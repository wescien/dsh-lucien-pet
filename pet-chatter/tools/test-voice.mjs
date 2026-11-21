#!/usr/bin/env node
/**
 * Voice-specific checks for pet-chatter.
 *
 *   node tools/test-voice.mjs [baseUrl]
 *
 * Covers the two things that are easy to get wrong and invisible from a smoke
 * test: the on-disk cache probe, and the rule that a bubble never exists before
 * its audio does (with the bundled alert clip as the last resort).
 */
import { cachedVoice, synthesize } from '../tts.js';
import path from 'node:path';
import process from 'node:process';

const dir = process.env.PET_CHATTER_VOICE_DIR || path.join(process.env.DSH_HOME || '.', 'pet-chatter', 'voice');
const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:64079').replace(/\/+$/, '');
const headers = { 'x-pet-chatter': '1' };
const options = { dir, mode: 'auto', voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+15Hz' };
let passed = 0;
let failed = 0;

const check = (ok, name, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  // 1. Cache round trip: what synthesize() writes, cachedVoice() must find.
  const text = `语音缓存往返 ${Date.now()}`;
  const made = await synthesize(text, options);
  check(Boolean(made && made.file), 'synthesize writes a clip', made?.file);
  const hit = cachedVoice(text, options);
  check(Boolean(hit && hit.file), 'cache probe finds the clip it just wrote', hit?.file);
  check(Boolean(made && hit && made.file === hit.file), 'cache probe returns the same file');
  check(cachedVoice('完全不存在的文本 ' + Math.random(), options) === null, 'cache probe misses unknown text');

  // 1b. auto/edge may only use the configured voice: an unusable voice must
  // return null (so the host speaks the bundled notice) instead of silently
  // switching to Windows' robotic default.
  const guarded = await synthesize(`音色保护测试 ${Date.now()}`, { ...options, voice: 'xx-XX-NotAVoice', mode: 'auto' });
  check(guarded === null, 'auto mode never substitutes another voice', guarded?.file || 'null');
  const sapiMode = await synthesize(`系统语音测试 ${Date.now()}`, { ...options, mode: 'sapi' });
  check(Boolean(sapiMode && sapiMode.file?.endsWith('.wav')), 'explicit sapi mode still produces a local clip', sapiMode?.file);
  const normalOptions = { ...options, voice: 'zh-CN-XiaoyiNeural', mode: 'auto' };
  const normal = await synthesize(`神经网络测试 ${Date.now()}`, normalOptions).catch(() => null);
  check(Boolean(normal && normal.file?.endsWith('.mp3')), 'auto mode normally picks the neural clip', normal?.file);

  // 2. Audio is resolved before a bubble exists: every generated bubble must
  // already carry a playable clip (or be the audible alert when TTS is down).
  const generated = [];
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`${base}/pet-chatter/test?kind=comment&internal=1`, { method: 'POST', headers });
    const json = await response.json().catch(() => null);
    if (json?.ok && json.item) generated.push(json.item);
  }
  check(generated.length === 2, 'two bubbles were generated', `${generated.length}`);
  for (const item of generated) {
    check(
      typeof item.audioUrl === 'string' && item.audioUrl.length > 0,
      'the bubble exists only with its audio ready',
      `${item.kind} ${item.audioUrl}`,
    );
    const head = await fetch(`${base}${item.audioUrl}`, { method: 'HEAD', headers });
    check(head.ok && String(head.headers.get('content-type') || '').startsWith('audio/'), 'that audio is actually served', `${head.status}`);
  }

  // 3. When synthesis fails entirely, the pet must say so out loud, using the
  // clip that ships with the bundle (never a silent bubble).
  const failed = await fetch(`${base}/pet-chatter/test?kind=comment&internal=1&simulateVoiceFail=1`, {
    method: 'POST',
    headers,
  });
  const failedJson = await failed.json().catch(() => null);
  check(failedJson?.item?.kind === 'alert', 'a total TTS failure turns into the alert bubble', failedJson?.item?.kind);
  check(String(failedJson?.item?.audioUrl || '').startsWith('/pet-chatter/alert-voice'), 'the alert uses the bundled clip', failedJson?.item?.audioUrl);
  const alertAudio = await fetch(`${base}/pet-chatter/alert-voice`, { method: 'HEAD' });
  check(alertAudio.ok && String(alertAudio.headers.get('content-type') || '').startsWith('audio/'), 'the bundled alert clip is served', `${alertAudio.status}`);
};

main()
  .catch((error) => {
    failed += 1;
    console.log(`FAIL  aborted: ${error instanceof Error ? error.message : error}`);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  });
