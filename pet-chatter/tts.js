import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Speech synthesis for the pet bubble.
 *
 * Edge neural voices (the cute default) come from the open-source
 * `@andresaya/edge-tts` package installed in this bundle's own node_modules;
 * Windows SAPI is the offline fallback. Both produce a cached file under
 * <DSH_HOME>/pet-chatter/voice so the browser can stream it from our route.
 */

const EDGE_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';
// The bubble waits for audio, so a slow engine must not hold the line hostage:
// Edge gets 6s per attempt; the local fallback gets 10s because the first
// PowerShell run pays for loading System.Speech and the zh-CN voice.
const EDGE_TIMEOUT_MS = 6_000;
const SAPI_TIMEOUT_MS = 10_000;
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let edgePromise;
/** Last real synthesis failure, for the settings panel's diagnosis line. */
let lastFailure = null;

/** Return a copy of the last synthesis failure, or null after a success. */
export function lastSynthesisFailure() {
  return lastFailure ? { ...lastFailure } : null;
}

function noteFailure(error, extra = {}) {
  const message = error instanceof Error ? (error.message || error.name || 'error') : (error || 'no-audio');
  lastFailure = {
    at: Date.now(),
    error: String(message).slice(0, 200),
    ...extra,
  };
}

/** Load the Edge TTS package lazily: a missing or broken dependency must not break the plugin. */
function loadEdge() {
  if (!edgePromise) {
    edgePromise = import('@andresaya/edge-tts').catch(() => null);
  }
  return edgePromise;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** SSML prosody values only accept a bounded range; clamp instead of letting the service reject. */
export function clampRate(value, fallback = '+8%') {
  const match = /^([+-]?)(\d{1,3}(?:\.\d+)?)%$/.exec(String(value ?? '').trim());
  if (!match) return fallback;
  const magnitude = Math.min(200, Math.max(0, Number(match[2])));
  const negative = match[1] === '-';
  return `${negative ? '-' : '+'}${magnitude}%`;
}

export function clampPitch(value, fallback = '+15Hz') {
  const match = /^([+-]?)(\d{1,3}(?:\.\d+)?)Hz$/i.exec(String(value ?? '').trim());
  if (!match) return fallback;
  const magnitude = Math.min(100, Math.max(0, Number(match[2])));
  const negative = match[1] === '-';
  return `${negative ? '-' : '+'}${magnitude}Hz`;
}

function pitchToSapiPercent(pitch) {
  const match = /^([+-]?)(\d{1,3}(?:\.\d+)?)Hz$/i.exec(String(pitch || ''));
  if (!match) return '+8%';
  const hertz = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  const percent = Math.min(40, Math.max(-40, Math.round((hertz / 200) * 100)));
  return `${percent >= 0 ? '+' : '-'}${Math.abs(percent)}%`;
}

/** Speech text: keep letters/CJK/digits and light punctuation, drop markup and emoji. */
export function speechText(input) {
  return String(input ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>~|]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function exists(file) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}

async function edgeMp3(text, { voice, rate, pitch }) {
  const module = await loadEdge();
  const EdgeTTS = module && (module.EdgeTTS || (module.default && module.default.EdgeTTS));
  if (typeof EdgeTTS !== 'function') throw new Error('edge-tts-unavailable');
  const client = new EdgeTTS();
  let result;
  try {
    result = await withTimeout(
      client.generate(text, voice, { outputFormat: EDGE_FORMAT, rate, pitch }),
      EDGE_TIMEOUT_MS,
      'edge',
    );
  } catch (error) {
    const message = error instanceof Error ? (error.message || error.name) : String(error || 'unknown');
    throw new Error(`edge-generate: ${message}`.slice(0, 180));
  }
  const audio = result && result.audio;
  if (!audio || !audio.length) throw new Error('edge-empty');
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
}

const SAPI_SCRIPT = String.raw`
param([string]$SsmlPath, [string]$OutPath, [string]$VoiceHint)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  $pick = $null
  foreach ($voice in $voices) {
    if ($VoiceHint -and $voice.VoiceInfo.Name -like "*$VoiceHint*") { $pick = $voice; break }
  }
  if (-not $pick) {
    foreach ($voice in $voices) {
      if ($voice.VoiceInfo.Culture.Name -like 'zh-*') { $pick = $voice; break }
    }
  }
  if ($pick) { $synth.SelectVoice($pick.VoiceInfo.Name) }
  $ssml = Get-Content -LiteralPath $SsmlPath -Raw -Encoding UTF8
  $synth.SetOutputToWaveFile($OutPath)
  $synth.SpeakSsml($ssml)
} finally {
  $synth.Dispose()
}
`;

async function sapiWav(text, file, pitch) {
  const workDir = path.join(os.tmpdir(), `pet-chatter-${createHash('sha1').update(text).digest('hex').slice(0, 12)}`);
  const ssmlPath = path.join(workDir, 'say.ssml');
  const scriptPath = path.join(workDir, 'say.ps1');
  await mkdir(workDir, { recursive: true });
  const ssml = `<?xml version="1.0" encoding="utf-8"?><speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody pitch="${pitchToSapiPercent(pitch)}" rate="+6%">${escapeXml(text)}</prosody></speak>`;
  await writeFile(ssmlPath, ssml, 'utf8');
  await writeFile(scriptPath, SAPI_SCRIPT, 'utf8');

  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        const child = spawn(
          POWERSHELL,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ssmlPath, file, 'Yaoyao'],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`sapi-exit-${code}: ${stderr.slice(0, 200)}`));
        });
      }),
      SAPI_TIMEOUT_MS,
      'sapi',
    );
    return await exists(file);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Synthesize one line into the cache directory.
 *
 * @returns {Promise<{ file: string, mime: string } | null>} cached file name
 *   (relative to the voice directory) and its media type, or null when no
 *   engine could produce audio.
 */
export async function synthesize(text, options = {}) {
  const say = speechText(text);
  if (!say) return null;

  const dir = options.dir;
  if (!dir) throw new Error('voice-dir-missing');
  await mkdir(dir, { recursive: true });

  const mode = ['auto', 'edge', 'sapi', 'off'].includes(options.mode) ? options.mode : 'auto';
  if (mode === 'off') return null;

  const voice = options.voice || 'zh-CN-XiaoyiNeural';
  const rate = clampRate(options.rate);
  const pitch = clampPitch(options.pitch);
  const stem = createHash('sha1').update(`${mode}|${voice}|${rate}|${pitch}|${say}`).digest('hex');

  const mp3 = path.join(dir, `${stem}.mp3`);
  if (await exists(mp3)) {
    lastFailure = null;
    return { file: `${stem}.mp3`, mime: 'audio/mpeg' };
  }
  const wav = path.join(dir, `${stem}.wav`);
  if (await exists(wav)) {
    lastFailure = null;
    return { file: `${stem}.wav`, mime: 'audio/wav' };
  }
  const wavResult = { file: `${stem}.wav`, mime: 'audio/wav' };
  const writeMp3 = async (buffer) => {
    await writeFile(mp3, buffer);
    lastFailure = null;
    return { file: `${stem}.mp3`, mime: 'audio/mpeg' };
  };

  if (mode !== 'sapi') {
    // Only the configured neural voice is acceptable: falling back to Windows'
    // robotic default would silently change the voice the human chose, so a
    // failed Edge call returns null and the host speaks the bundled failure
    // notice instead. Two attempts cover ordinary socket churn.
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await writeMp3(await edgeMp3(say, { voice, rate, pitch }));
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (mode === 'edge') {
      noteFailure(lastError, { mode, voice, engine: 'edge' });
      throw lastError;
    }
    noteFailure(lastError || 'edge-empty', { mode, voice, engine: 'edge' });
    return null;
  }

  const ok = await sapiWav(say, wav, pitch).catch((error) => {
    noteFailure(error, { mode, voice, engine: 'sapi' });
    return false;
  });
  if (!ok) noteFailure('sapi-empty', { mode, voice, engine: 'sapi' });
  else lastFailure = null;
  return ok ? wavResult : null;
}

/**
 * Cache-only probe: returns the clip for this text if it is already on disk, so
 * a bubble never waits for a fresh synthesis.
 */
export function cachedVoice(text, options = {}) {
  try {
    const say = speechText(text);
    if (!say) return null;
    const dir = options.dir;
    if (!dir) return null;
    const mode = ['auto', 'edge', 'sapi', 'off'].includes(options.mode) ? options.mode : 'auto';
    if (mode === 'off') return null;
    const voice = options.voice || 'zh-CN-XiaoyiNeural';
    const rate = clampRate(options.rate);
    const pitch = clampPitch(options.pitch);
    const stem = createHash('sha1').update(`${mode}|${voice}|${rate}|${pitch}|${say}`).digest('hex');
    const mp3 = path.join(dir, `${stem}.mp3`);
    if (existsSync(mp3)) return { file: `${stem}.mp3`, mime: 'audio/mpeg' };
    const wav = path.join(dir, `${stem}.wav`);
    if (existsSync(wav)) return { file: `${stem}.wav`, mime: 'audio/wav' };
    return null;
  } catch {
    return null;
  }
}