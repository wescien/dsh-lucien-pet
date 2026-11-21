#!/usr/bin/env node
/**
 * Control-matrix test for the pet-chatter settings panel.
 *
 *   node tools/controls.mjs [baseUrl]
 *
 * Every slider, dropdown, text field and toggle in the panel writes one config
 * key. This script drives each of those keys through the same HTTP endpoint the
 * panel uses, asserts the effective value changed to what the control promises,
 * then restores the original settings. No model calls, no bubbles.
 */
import process from 'node:process';

const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:64079').replace(/\/+$/, '');
const headers = { 'x-pet-chatter': '1', 'Content-Type': 'application/json' };
let passed = 0;
let failed = 0;

const get = async () => {
  const response = await fetch(`${base}/pet-chatter/settings`, { headers, cache: 'no-store' });
  return response.json();
};

const patch = async (body) => {
  const response = await fetch(`${base}/pet-chatter/settings`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

const check = (ok, name, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
};

/** Write one key, read it back, then restore. */
const probe = async (key, value, expect = value) => {
  const before = (await get()).effective;
  const write = await patch({ patch: { [key]: value } });
  const after = (await get()).effective;
  const ok = write.status === 200 && JSON.stringify(after[key]) === JSON.stringify(expect);
  check(ok, `control ${key} = ${JSON.stringify(value)}`, `effective ${JSON.stringify(after[key])}`);
  await patch({ patch: { [key]: before[key] } });
  return ok;
};

/** Enumerations must reject impossible values instead of storing them. */
const rejects = async (key, value) => {
  const before = (await get()).effective;
  await patch({ patch: { [key]: value } });
  const after = (await get()).effective;
  check(JSON.stringify(after[key]) === JSON.stringify(before[key]), `control ${key} rejects ${JSON.stringify(value)}`, `kept ${JSON.stringify(after[key])}`);
  await patch({ patch: { [key]: before[key] } });
};

const main = async () => {
  const snapshot = await get();
  check(Boolean(snapshot?.effective), 'settings endpoint is up');

  const options = snapshot.options || {};
  const voices = options.voices || [];
  const personalities = options.personalities || [];

  // --- enums -------------------------------------------------------------
  const current = snapshot.effective;
  const otherPersonality = personalities.find((name) => name !== current.personality) || 'balance';
  await probe('personality', otherPersonality);
  await probe('frequency', current.frequency === 'often' ? 'rare' : 'often');
  await probe('effects', current.effects === 'lively' ? 'soft' : 'lively');
  await probe('anchor', current.anchor === 'pet' ? 'corner' : 'pet');
  await probe('tts', current.tts === 'edge' ? 'auto' : 'edge');
  // Every frame the picker offers must survive the validation table.
  for (const frame of (options.frames || []).filter((name) => name !== current.bubbleStyle)) {
    await probe('bubbleStyle', frame);
  }
  const otherVoice = voices.find((name) => name !== current.voice) || voices[0];
  if (otherVoice) await probe('voice', otherVoice);

  // --- numbers -----------------------------------------------------------
  await probe('ideaChance', current.ideaChance > 0.5 ? 0.05 : 0.9);
  await probe('roastChance', current.roastChance > 0.5 ? 0.05 : 0.9);
  await probe('minGapMinutes', current.minGapMinutes === 7 ? 2 : 7);
  await probe('maxPerHour', current.maxPerHour === 5 ? 9 : 5);
  await probe('idleMinutes', current.idleMinutes === 20 ? 55 : 20);
  await probe('bedtimeQuietMinutes', current.bedtimeQuietMinutes === 30 ? 10 : 30);
  await probe('voiceChance', current.voiceChance > 0.5 ? 0.1 : 0.95);
  await probe('volume', current.volume > 0.5 ? 0.3 : 0.9);
  await probe('stickerChance', current.stickerChance > 0.5 ? 0.1 : 0.9);
  await probe('bubbleGapSeconds', current.bubbleGapSeconds === 30 ? 10 : 30);
  await probe('clickBubbleChance', current.clickBubbleChance > 0.5 ? 0.2 : 0.9);
  await probe('dragBubbleChance', current.dragBubbleChance > 0.5 ? 0.2 : 0.9);
  await probe('actionBiasChance', current.actionBiasChance > 0.5 ? 0.2 : 0.9);
  await probe('chatCompactPercent', current.chatCompactPercent === 72 ? 60 : 72);
  await rejects('chatReasoning', 'off');

  // --- booleans ----------------------------------------------------------
  for (const key of ['enabled', 'expressive', 'idleEnabled', 'nightAuto', 'petReactions', 'dragFeedback', 'chatAgent']) {
    await probe(key, !current[key]);
  }

  // --- strings -----------------------------------------------------------
  await probe('address', '老板');
  await probe('persona', '一句话里必须带个「喵」');
  await probe('quietHours', '03:00-05:00');
  await probe('nightHours', '00:30-06:30');
  await probe('bedtime', '22:45');
  await probe('rate', '-5%');
  await probe('pitch', '-10Hz');

  // --- validation --------------------------------------------------------
  await rejects('bedtime', '99:99');
  await rejects('personality', 'not-a-personality');
  await rejects('voice', 'xx-XX-NotAVoice');
  await rejects('bubbleStyle', 'not-a-frame');

  // --- presets -----------------------------------------------------------
  for (const name of ['quiet', 'chatty', 'night']) {
    const response = await fetch(`${base}/pet-chatter/preset`, { method: 'POST', headers, body: JSON.stringify({ name }) });
    const json = await response.json();
    const ok =
      response.status === 200 &&
      (name === 'quiet' ? json.effective.frequency === 'rare' : true) &&
      (name === 'chatty' ? json.effective.frequency === 'often' : true) &&
      (name === 'night' ? json.effective.voiceChance <= 0.5 : true);
    check(ok, `preset ${name} applies`, `${json.effective?.frequency} / voice ${json.effective?.voiceChance}`);
  }
  const reset = await fetch(`${base}/pet-chatter/preset`, { method: 'POST', headers, body: JSON.stringify({ name: 'default' }) });
  check(reset.status === 200, 'preset default resets overrides');

  // --- restore the user's original settings ------------------------------
  const restore = await fetch(`${base}/pet-chatter/settings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ patch: current }),
  });
  const restored = await restore.json();
  const same = Object.entries(current).every(([key, value]) => JSON.stringify(restored.effective[key]) === JSON.stringify(value));
  check(same, 'original settings restored', same ? '' : 'differs from snapshot');

  // --- non-model buttons -------------------------------------------------
  const say = await fetch(`${base}/pet-chatter/say`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: '控件测试·预览气泡', speak: false, effects: 'none', internal: true }),
  });
  const sayJson = await say.json();
  check(say.status === 200 && sayJson.item?.text === '控件测试·预览气泡', 'button 预览气泡 (say) shows text without speaking');

  const preview = await fetch(`${base}/pet-chatter/preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ voice: voices[0] }),
  });
  const previewJson = await preview.json();
  check(preview.status === 200 && typeof previewJson.audioUrl === 'string', 'button 试听 (preview) returns an audio url', previewJson.engine);

  await fetch(`${base}/pet-chatter/pending`, { headers });
  const rerollEmpty = await fetch(`${base}/pet-chatter/reroll?internal=1`, { method: 'POST', headers, body: '{}' });
  check(rerollEmpty.status === 409 || rerollEmpty.status === 200, 'button 再来一句 answers', `${rerollEmpty.status}`);
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
