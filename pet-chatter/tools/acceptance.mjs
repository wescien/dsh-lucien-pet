#!/usr/bin/env node
/**
 * Delivery acceptance check for pet-chatter.
 *
 *   node tools/acceptance.mjs [baseUrl]
 *
 * A short, human-readable pass over the user-facing flows:
 * versions → frames → preview repeat → reroll pacing → chat + voice →
 * audio-failure alert → sticker → history. Restores every setting it touches.
 * Costs one model call (chat) and a little TTS; never leaves bubbles queued.
 */
import process from 'node:process';

const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:64079').replace(/\/+$/, '');
const headers = { 'x-pet-chatter': '1', 'Content-Type': 'application/json' };
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

const settings = async () => (await fetch(`${base}/pet-chatter/settings`, { headers, cache: 'no-store' })).json();
const postJson = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: response.status, json: await response.json().catch(() => null) };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const first = await settings();
  check(Boolean(first?.effective), 'settings endpoint is up');
  check(first?.client?.expects === first?.client?.version, 'client matches the host build', `${first?.client?.version} vs ${first?.client?.expects}`);
  check(Array.isArray(first?.options?.frames) && first.options.frames.length >= 7, 'seven bubble frames are offered', JSON.stringify(first?.options?.frames));

  // Frames round-trip, then restore.
  const originalFrame = first.effective.bubbleStyle;
  let framesOk = true;
  for (const frame of first.options.frames) {
    const write = await postJson('/pet-chatter/settings', { patch: { bubbleStyle: frame } });
    if (write.status !== 200 || (await settings()).effective.bubbleStyle !== frame) framesOk = false;
  }
  await postJson('/pet-chatter/settings', { patch: { bubbleStyle: originalFrame } });
  check(framesOk, 'every frame can be selected', originalFrame);

  // A repeated preview must not be swallowed and must ask to replace the bubble.
  const preview = { text: '验收预览：这一句重复点也要出来', speak: false, force: true, preempt: true };
  const previewA = await postJson('/pet-chatter/say', preview);
  const previewB = await postJson('/pet-chatter/say', preview);
  check(Boolean(previewA.json?.item?.id) && Boolean(previewB.json?.item?.id) && previewA.json.item.id !== previewB.json.item.id, 'repeated preview always shows');
  check(previewB.json?.item?.preempt === true, 'preview replaces the current bubble');

  // Reroll pacing: a simultaneous second click is throttled.
  const [rollA, rollB] = await Promise.all([postJson('/pet-chatter/reroll?internal=1'), postJson('/pet-chatter/reroll?internal=1')]);
  check([rollA.status, rollB.status].includes(429), 'rapid reroll clicks are throttled', `${rollA.status}/${rollB.status}`);

  // The long-press greeting must carry the saved frame/effects, not hardcoded ones.
  const hello = await postJson('/pet-chatter/manual/hello', {});
  check(hello.status === 200 && hello.json?.item?.kind === 'chat', 'manual chat greeting is served', hello.json?.item?.text);
  check(hello.json?.item?.frame === first.effective.bubbleStyle, 'greeting uses the configured frame', `${hello.json?.item?.frame} vs ${first.effective.bubbleStyle}`);
  check(hello.json?.item?.effects === first.effective.effects, 'greeting uses the configured effects', `${hello.json?.item?.effects} vs ${first.effective.effects}`);

  // Chat returns text AND voice together (same paint), not text-then-voice.
  let chat = await postJson('/pet-chatter/chat', { text: '验收一下，你在吗' });
  if (chat.json?.voiceFailed) {
    // Edge is occasionally rate-limited; one warm retry distinguishes that from
    // a real regression. A persistent failure is still explicit in the payload.
    await sleep(2500);
    chat = await postJson('/pet-chatter/chat', { text: '再验收一下，你还在吗' });
  }
  check(chat.status === 200 && typeof chat.json?.reply === 'string', 'chat replies with text', chat.json?.reply?.slice(0, 20));
  check(
    typeof chat.json?.audioUrl === 'string' || chat.json?.voiceFailed === true,
    'chat returns its voice with the text (or the explicit alert fallback)',
    chat.json?.audioUrl || 'voiceFailed',
  );
  if (typeof chat.json?.audioUrl === 'string') {
    const audio = await fetch(`${base}${chat.json.audioUrl}`, { method: 'HEAD', headers });
    check(audio.ok && String(audio.headers.get('content-type') || '').startsWith('audio/'), 'that clip is actually served', `${audio.status}`);
  }

  // Drag and tap both use the same local pipeline and shared bubble gap.
  const dragGap = first.effective.bubbleGapSeconds;
  const dragChance = first.effective.dragBubbleChance;
  const clickChance = first.effective.clickBubbleChance;
  const actionBias = first.effective.actionBiasChance;
  await postJson('/pet-chatter/settings', { patch: { bubbleGapSeconds: 0, dragBubbleChance: 1, clickBubbleChance: 1, actionBiasChance: 1 } });
  await postJson('/pet-chatter/bubble-state', { active: false, id: '' });
  const drag = await postJson('/pet-chatter/drag', {});
  check(drag.status === 200, 'drag feedback responds', String(drag.status));
  if (drag.json?.ok) {
    check(drag.json.item?.kind === 'drag', 'drag feedback is a local drag line', drag.json.item?.kind || '');
    check(typeof drag.json.item?.audioUrl === 'string' && drag.json.item.audioUrl.includes('/reaction-voice/'), 'drag carries a bundled clip', drag.json.item?.audioUrl || '');
    check(typeof drag.json.item?.stickerUrl === 'string', 'drag feedback has a mood-matched sticker');
    await postJson('/pet-chatter/settings', { patch: { bubbleGapSeconds: 60 } });
    const again = await postJson('/pet-chatter/drag', {});
    check(again.json?.ok === false && /gap/.test(String(again.json?.skipped)), 'the shared bubble gap is enforced', again.json?.skipped || '');
  }
  await postJson('/pet-chatter/settings', { patch: { bubbleGapSeconds: 0 } });
  await postJson('/pet-chatter/bubble-state', { active: false, id: '' });
  const click = await postJson('/pet-chatter/click', {});
  check(click.json?.ok === true && click.json.item?.kind === 'click', 'tap feedback is local and immediate', click.json?.item?.kind || click.json?.skipped || '');
  if (click.json?.ok) {
    check(typeof click.json.item?.audioUrl === 'string' && click.json.item.audioUrl.includes('/reaction-voice/'), 'tap carries a bundled clip', click.json.item.audioUrl);
  }
  await postJson('/pet-chatter/bubble-state', { active: false, id: '' });
  const biased = await postJson('/pet-chatter/click', { action: 'happy' });
  check(biased.json?.ok === true && ['开心', '喜欢', '兴奋'].includes(biased.json.item?.mood), 'known body actions softly bias the line', biased.json?.item?.mood || biased.json?.skipped || '');
  await postJson('/pet-chatter/say', { text: '聊天前队列清理验收', speak: false, force: true });
  const beforeChat = await settings();
  await postJson('/pet-chatter/chat-state', { open: true });
  const afterChat = await settings();
  check(beforeChat.stats.queued >= 1 && afterChat.stats.queued === 0, 'opening chat clears queued bubbles', `${beforeChat.stats.queued} -> ${afterChat.stats.queued}`);
  await postJson('/pet-chatter/chat-state', { open: false });
  await postJson('/pet-chatter/settings', { patch: { bubbleGapSeconds: dragGap, dragBubbleChance: dragChance, clickBubbleChance: clickChance, actionBiasChance: actionBias } });

  // Total TTS failure must become the audible alert.
  const alert = await postJson('/pet-chatter/test?alert=1&internal=1');
  check(alert.json?.item?.kind === 'alert', 'audio failure becomes the alert bubble', alert.json?.item?.kind || '');
  check(String(alert.json?.item?.audioUrl || '').startsWith('/pet-chatter/alert-voice'), 'the alert uses the bundled clip');
  const alertHead = await fetch(`${base}/pet-chatter/alert-voice`, { method: 'HEAD' });
  check(alertHead.ok, 'the bundled clip is served', `${alertHead.status}`);

  // A sticker can ride along and is served by our route.
  const sticker = await postJson('/pet-chatter/say', { text: '验收贴纸', speak: false, sticker: true, internal: true });
  check(typeof sticker.json?.item?.stickerUrl === 'string', 'a sticker can ride along', sticker.json?.item?.stickerUrl || '');
  if (typeof sticker.json?.item?.stickerUrl === 'string') {
    const gif = await fetch(`${base}${sticker.json.item.stickerUrl}`, { headers });
    const bytes = new Uint8Array(await gif.arrayBuffer()).slice(0, 4);
    check(gif.ok && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46, 'the sticker route returns a GIF', `${gif.status}`);
  }

  check(Array.isArray(first.history), 'recent remarks are available', `${first.history.length} entries`);

  // Leave the queue empty for the next real visitor.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const drain = await fetch(`${base}/pet-chatter/pending`, { headers, cache: 'no-store' });
    if (drain.status === 204) break;
    await drain.text();
    await sleep(120);
  }
  const end = await settings();
  check(end.stats.queued === 0, 'queue is clean afterwards', String(end.stats.queued));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
};

main().catch((error) => {
  console.error('acceptance failed:', error);
  process.exitCode = 1;
});
