#!/usr/bin/env node
/**
 * Regenerate the bundled click/drag reaction clips.
 *
 *   node tools/build-reactions.mjs [--force]
 *
 * Uses the configured Edge voice (Xiaoyi + the app's default prosody) and writes
 * deterministic `assets/reactions/<kind>-NN.mp3` files. Runtime never calls TTS
 * for these clips, so a tap or drag is guaranteed to have local audio.
 */
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { synthesize } from '../tts.js';
import { CLICK_LINES, DRAG_LINES, REACTION_LINES } from '../lib/reactions.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, '..', 'assets', 'reactions');
const tmpDir = path.join(root, '..', '.reaction-build');
const force = process.argv.includes('--force');
const voice = process.env.PET_REACTION_VOICE || 'zh-CN-XiaoyiNeural';
const rate = process.env.PET_REACTION_RATE || '+8%';
const pitch = process.env.PET_REACTION_PITCH || '+15Hz';

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function buildOne(kind, index, text) {
  const target = path.join(outDir, `${kind}-${String(index + 1).padStart(2, '0')}.mp3`);
  if (!force && (await exists(target))) return 'cached';
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await synthesize(text, { dir: tmpDir, mode: 'edge', voice, rate, pitch });
      if (!result || !result.file.endsWith('.mp3')) throw new Error(result ? result.file : 'no-audio');
      await copyFile(path.join(tmpDir, result.file), target);
      return 'built';
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw new Error(`${kind}-${index + 1}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const main = async () => {
  await mkdir(outDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  const jobs = [];
  for (const [kind, lines] of Object.entries(REACTION_LINES)) {
    for (let index = 0; index < lines.length; index += 1) {
      jobs.push({ kind, index, text: lines[index].text });
    }
  }
  let cursor = 0;
  let built = 0;
  let cached = 0;
  const failures = [];
  const workers = Array.from({ length: 3 }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      try {
        const result = await buildOne(job.kind, job.index, job.text);
        if (result === 'built') built += 1;
        else cached += 1;
        process.stdout.write(`.${job.kind[0]}${String(job.index + 1).padStart(2, '0')} `);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        process.stdout.write(`\nFAIL ${job.kind}-${job.index + 1}: ${error instanceof Error ? error.message : error}\n`);
      }
    }
  });
  await Promise.all(workers);
  console.log(`\nreactions: ${built} built, ${cached} cached, ${failures.length} failed (${CLICK_LINES.length} click + ${DRAG_LINES.length} drag)`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
