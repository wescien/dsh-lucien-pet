#!/usr/bin/env node
/**
 * End-to-end smoke test for pet-chatter.
 *
 *   node tools/smoke.mjs [baseUrl]
 *
 * Exercises the HTTP surface the browser half and the settings panel use.
 * Costs two model calls; everything else is local. Exits non-zero on failure.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:64079').replace(/\/+$/, '');
const headers = { 'x-pet-chatter': '1' };
const results = [];

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const get = (path, withHeader = true) =>
  fetch(`${base}${path}`, { headers: withHeader ? headers : {}, cache: 'no-store' });

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

const json = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const magicOf = (buffer) => Array.from(new Uint8Array(buffer).slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');

const main = async () => {
  // 1. Header guard.
  const guarded = await get('/pet-chatter/pending', false);
  check('pending rejects a missing capability header', guarded.status === 403, `status ${guarded.status}`);

  // 2. A foreign Origin must not drive the pet.
  const foreign = await fetch(`${base}/pet-chatter/pending`, {
    headers: { ...headers, Origin: 'http://evil.example' },
  });
  check('pending rejects a foreign origin', foreign.status === 403, `status ${foreign.status}`);

  // 2. Drain whatever is queued.
  const drained = await get('/pet-chatter/pending');
  check('pending answers 200 or 204', drained.status === 200 || drained.status === 204, `status ${drained.status}`);

  // 3. Settings read.
  const settings = await get('/pet-chatter/settings');
  const snapshot = await json(settings);
  check('settings GET returns effective config', settings.status === 200 && !!snapshot?.effective);
  check('settings exposes options', Array.isArray(snapshot?.options?.voices) && snapshot.options.voices.length > 0);
  check('settings offers the six traits plus random', Array.isArray(snapshot?.options?.personalities) && snapshot.options.personalities.includes('random') && snapshot.options.personalities.length === 7);
  check('settings reports runtime diagnostics', typeof snapshot?.runtime?.rssMB === 'number' && snapshot.runtime.rssMB > 0, `${snapshot?.runtime?.rssMB} MB`);
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const shippedVersion = /MY_VERSION = '([^']+)'/.exec(clientSource)?.[1];
  check(
    'host expects exactly the client version shipped in client.js',
    Boolean(shippedVersion) && snapshot?.client?.expects === shippedVersion,
    `${snapshot?.client?.expects} vs ${shippedVersion}`,
  );
  const before = snapshot?.effective || {};
  check(
    'settings exposes the newer knobs',
    typeof before.roastChance === 'number' &&
      typeof before.bedtimeQuietMinutes === 'number' &&
      typeof before.expressive === 'boolean' &&
      typeof before.bubbleStyle === 'string',
  );

  // 4. Settings write round-trip, then restore.
  const probe = Number.isFinite(before.voiceChance) ? Math.abs(before.voiceChance - 0.5) : 0.5;
  const wrote = await post('/pet-chatter/settings', { patch: { voiceChance: probe } });
  const afterWrite = await json(wrote);
  check('settings POST applies immediately', wrote.status === 200 && Math.abs((afterWrite?.effective?.voiceChance ?? -1) - probe) < 1e-6);
  const restored = await post('/pet-chatter/settings', { patch: { voiceChance: before.voiceChance ?? 1 } });
  check('settings POST restores the probe', restored.status === 200);

  // Unknown values must fall back instead of corrupting the config.
  const junk = await json(await post('/pet-chatter/settings', { patch: { voice: 'not-a-voice', effects: 'nope', maxPerHour: 9999 } }));
  check('settings coerces junk values', junk?.effective?.voice === before.voice && junk.effective.effects === before.effects, `${junk?.effective?.voice}/${junk?.effective?.effects}`);
  await post('/pet-chatter/settings', { patch: { voice: before.voice, effects: before.effects, maxPerHour: before.maxPerHour } });

  // Every knob the panel writes must survive the validation table.
  const idleWrite = await json(await post('/pet-chatter/settings', { patch: { idleMinutes: 33 } }));
  check('settings persists idleMinutes', idleWrite?.effective?.idleMinutes === 33, String(idleWrite?.effective?.idleMinutes));
  await post('/pet-chatter/settings', { patch: { idleMinutes: before.idleMinutes ?? 45 } });

  // 5. Voice preview + audio route.
  const preview = await post('/pet-chatter/preview', { voice: 'zh-CN-XiaoyiNeural', text: '冒烟测试，听得到吗？' });
  const previewJson = await json(preview);
  check('preview synthesizes audio', preview.status === 200 && typeof previewJson?.audioUrl === 'string', previewJson?.engine);

  // The bundled audio-failure notice: it must always be fetchable, because it is
  // the one thing that guarantees an alert is audible even with both engines down.
  const alertHead = await fetch(`${base}/pet-chatter/alert-voice`, { method: 'HEAD' });
  check('bundled alert clip is served', alertHead.ok && /^audio\//.test(alertHead.headers.get('content-type') || ''), `${alertHead.status} ${alertHead.headers.get('content-type')}`);
  check('bundled alert clip has bytes', Number(alertHead.headers.get('content-length') || 0) > 5000, `${alertHead.headers.get('content-length')} B`);
  if (previewJson?.audioUrl) {
    const audio = await fetch(`${base}${previewJson.audioUrl}`);
    const bytes = await audio.arrayBuffer();
    const magic = magicOf(bytes);
    const isMp3 = magic.startsWith('ff f3') || magic.startsWith('ff fb') || magic.startsWith('49 44 33');
    const isWav = magic === '52 49 46 46';
    check('voice route serves mp3/wav', audio.ok && (isMp3 || isWav), `${bytes.byteLength}B ${magic}`);
    check('voice route sets a media type', /^audio\//.test(audio.headers.get('content-type') || ''));
    const headAudio = await fetch(`${base}${previewJson.audioUrl}`, { method: 'HEAD' });
    const headBytes = await headAudio.arrayBuffer();
    check(
      'voice HEAD answers headers only',
      headAudio.status === 200 && Number(headAudio.headers.get('content-length')) > 0 && headBytes.byteLength === 0,
      `${headAudio.headers.get('content-length')}B declared, ${headBytes.byteLength}B sent`,
    );
  }

  // 6. Generation probes.
  for (const kind of ['comment', 'idea', 'comfort', 'idle', 'bedtime']) {
    const response = await post(`/pet-chatter/test?kind=${kind}&internal=1`);
    const payload = await json(response);
    const ok = response.status === 200 && payload?.ok === true && typeof payload.item?.text === 'string' && payload.item.text.length > 0;
    check(`generates a ${kind}`, ok, ok ? `${payload.item.text.length} chars` : JSON.stringify(payload)?.slice(0, 120));
    if (ok) {
      const limit = kind === 'idea' ? 60 : 45;
      check(`${kind} respects the length budget`, payload.item.text.length <= limit + 1, `${payload.item.text.length}/${limit}`);
      check(`${kind} carries an effect mode`, ['none', 'soft', 'lively', 'typewriter'].includes(payload.item.effects), payload.item.effects);
      check(`${kind} reports the client state`, typeof payload.debug?.clientVersion === 'string');
      if (kind !== 'comment') check(`${kind} keeps its kind`, payload.item.kind === kind, payload.item.kind);
      if (kind === 'idle') {
        check('idle carries no quote', !payload.item.quote);
        check(
          'idle stays off the stale work digest',
          !/偏差|三处偏差|实验数据|对比表/.test(payload.item.text),
          payload.item.text,
        );
      } else check(`${kind} quotes the user line`, typeof payload.item.quote === 'string' && payload.item.quote.length > 0, payload.item.quote?.slice(0, 12));
    }
  }

  // 7. Bogus asset names must not escape the cache directory.
  const badVoice = await fetch(`${base}/pet-chatter/voice/../../etc/passwd`);
  check('voice route refuses traversal', badVoice.status === 404, `status ${badVoice.status}`);
  const badSticker = await fetch(`${base}/pet-chatter/sticker/notahash.gif`);
  check('sticker route refuses a bogus name', badSticker.status === 404, `status ${badSticker.status}`);
  const encodedSticker = await fetch(`${base}/pet-chatter/sticker/%2e%2e%2fpackage.json`);
  check('sticker route refuses encoded traversal', encodedSticker.status === 404, `status ${encodedSticker.status}`);

  // 7b. Malformed request bodies and wrong methods.
  const huge = await fetch(`${base}/pet-chatter/settings`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: { address: 'x'.repeat(20_000) } }),
  });
  check('settings rejects an oversized body', huge.status === 400 || huge.status === 413, `status ${huge.status}`);
  const broken = await fetch(`${base}/pet-chatter/settings`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{not json',
  });
  check('settings rejects malformed JSON', broken.status === 400, `status ${broken.status}`);
  const emptySay = await post('/pet-chatter/say', { text: '   ' });
  check('say rejects blank text', emptySay.status === 400, `status ${emptySay.status}`);
  const headPending = await fetch(`${base}/pet-chatter/pending`, { method: 'HEAD', headers });
  check('pending rejects HEAD', headPending.status === 405, `status ${headPending.status}`);

  // 8. Capability channel rejects anything but POST (kept out of the way so a
  // real browser report is never overwritten by this test).
  const helloGet = await get('/pet-chatter/hello');
  check('hello rejects GET', helloGet.status === 405, `status ${helloGet.status}`);

  // 9. Direct speech route + the "voice frequency" knob.
  const said = await post('/pet-chatter/say', { text: '冒烟测试，我在。', speak: false, mood: '开心', internal: true });
  const saidJson = await json(said);
  check('say route enqueues a line', said.status === 200 && saidJson?.item?.text === '冒烟测试，我在。');
  check('say respects speak:false', saidJson?.item?.audioUrl === null);
  // An explicit speak:true must always synthesize, bypassing the voiceChance lottery.
  const loud = await json(await post('/pet-chatter/say', { text: '强制发声测试', speak: true, internal: true }));
  check('say speak:true always synthesizes', typeof loud?.item?.audioUrl === 'string', loud?.item?.audioUrl || '');

  // Frames are presentation-only: the saved style must ride along with every
  // item, and a per-call override must win without touching the setting.
  const framedDefault = await json(await post('/pet-chatter/say', { text: '默认框测试', speak: false, internal: true }));
  check('items carry the configured frame', framedDefault?.item?.frame === before.bubbleStyle, `${framedDefault?.item?.frame} / ${before.bubbleStyle}`);
  const framed = await json(await post('/pet-chatter/say', { text: '框测试', speak: false, frame: 'paper', internal: true }));
  check('say accepts a frame override', framed?.item?.frame === 'paper', framed?.item?.frame || '');

  // 9b. Short chat inside the bubble: text and voice arrive together.
  const hello = await json(await post('/pet-chatter/manual/hello', {}));
  check('manual greeting uses the configured frame', hello?.item?.frame === before.bubbleStyle, `${hello?.item?.frame} / ${before.bubbleStyle}`);
  check('manual greeting uses the configured effects', hello?.item?.effects === before.effects, `${hello?.item?.effects} / ${before.effects}`);
  const chat = await post('/pet-chatter/chat', { text: '你是谁呀' });
  const chatJson = await json(chat);
  check('chat returns a reply', chat.status === 200 && typeof chatJson?.reply === 'string' && chatJson.reply.length > 0, chatJson?.reply?.slice(0, 24));
  check('chat returns its voice with the reply', typeof chatJson?.audioUrl === 'string', chatJson?.audioUrl || '');
  const spoken = await json(await post('/pet-chatter/speak', { text: chatJson?.reply || '测试' }));
  check('speak route still serves a clip', typeof spoken?.audioUrl === 'string', spoken?.audioUrl || '');
  const blankChat = await post('/pet-chatter/chat', { text: '  ' });
  check('chat rejects blank input', blankChat.status === 400, `status ${blankChat.status}`);

  // 9c. "记住：…" writes one long-term fact, and the panel can clear it.
  const memorise = await json(await post('/pet-chatter/chat', { text: '记住：我喜欢冰美式' }));
  check('chat remembers a fact', memorise?.remembered === '我喜欢冰美式', memorise?.reply || '');
  const withMemory = await json(await get('/pet-chatter/settings'));
  check('settings exposes the memory', Array.isArray(withMemory?.memory) && withMemory.memory.includes('我喜欢冰美式'), JSON.stringify(withMemory?.memory));
  const cleared = await json(await post('/pet-chatter/memory', { action: 'clear' }));
  check('memory can be cleared', Array.isArray(cleared?.memory) && cleared.memory.length === 0);
  await post('/pet-chatter/chat', { text: '记住：这是一条临时记忆' });
  const removed = await json(await post('/pet-chatter/memory', { action: 'remove', text: '这是一条临时记忆' }));
  check('memory can remove one fact', Array.isArray(removed?.memory) && !removed.memory.includes('这是一条临时记忆'));
  await post('/pet-chatter/memory', { action: 'clear' });

  // Forced sticker: the kind picks the emotion (comfort → 安慰), the route serves it.
  const withSticker = await json(await post('/pet-chatter/say', { text: '贴纸测试', speak: false, kind: 'comfort', sticker: true, internal: true }));
  check('say can force a sticker', typeof withSticker?.item?.stickerUrl === 'string', withSticker?.item?.stickerUrl || '');
  if (withSticker?.item?.stickerUrl) {
    const gif = await fetch(`${base}${withSticker.item.stickerUrl}`);
    const bytes = await gif.arrayBuffer();
    const magic = magicOf(bytes);
    check('sticker route serves a gif', gif.ok && magic.startsWith('47 49 46'), `${bytes.byteLength}B ${magic}`);
  }

  // voiceChance 0 must silence the line even when speak is requested.
  await post('/pet-chatter/settings', { patch: { voiceChance: 0 } });
  const silent = await json(await post('/pet-chatter/say', { text: '静音测试', internal: true }));
  check('voiceChance 0 produces no audio', silent?.item?.audioUrl === null);
  await post('/pet-chatter/settings', { patch: { voiceChance: before.voiceChance ?? 1 } });

  // 10. "再来一句" either rewrites the latest turn or explains there is none.
  // A 502 means the model provider hiccuped (two attempts both failed), which is
  // environmental, so retry once before calling it a failure.
  let reroll = await post('/pet-chatter/reroll?internal=1');
  if (reroll.status === 502) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    reroll = await post('/pet-chatter/reroll?internal=1');
  }
  const rerollJson = await json(reroll);
  check('reroll answers 200 or 409', reroll.status === 200 || reroll.status === 409, `status ${reroll.status}`);
  if (reroll.status === 200) {
    check('reroll returns a line', typeof rerollJson?.item?.text === 'string' && rerollJson.item.text.length > 0);
    check('internal reroll spends no queue slot and no quota', rerollJson?.internal === true);
  }

  // 11. A burst of direct lines must not crash the queue or the server. These are
  // internal, so the burst never appears on screen.
  const burst = await Promise.all(
    Array.from({ length: 5 }, (_, index) => post('/pet-chatter/say', { text: `突发 ${index}`, speak: false, internal: true })),
  );
  check('burst of say calls all succeed', burst.every((response) => response.status === 200), burst.map((response) => response.status).join(','));

  // 11b. The preview button must answer every click: force bypasses the echo
  // guard, and preempt asks the browser to replace the bubble already showing.
  const previewSay = { text: '预览重复测试', speak: false, force: true, preempt: true };
  const firstPreview = await json(await post('/pet-chatter/say', previewSay));
  const secondPreview = await json(await post('/pet-chatter/say', previewSay));
  check(
    'repeated previews are not swallowed as echoes',
    Boolean(firstPreview?.item?.id) && Boolean(secondPreview?.item?.id) && firstPreview.item.id !== secondPreview.item.id,
  );
  check('preview items ask the browser to replace the current bubble', secondPreview?.item?.preempt === true);

  // 12. Drain the queue so the page starts clean; it must empty within a few
  // reads. Every read is a complete bubble, so item reads count towards the
  // expected five.
  let drainReads = 0;
  let drainedItems = 0;
  let emptyAfterItems = false;
  for (let attempt = 0; attempt < 25 && !emptyAfterItems; attempt += 1) {
    const response = await get('/pet-chatter/pending');
    if (response.status === 204) {
      emptyAfterItems = true;
      break;
    }
    const body = await json(response);
    drainReads += 1;
    if (body && body.text) drainedItems += 1;
  }
  check('empty queue answers 204 and never hangs', emptyAfterItems, `${drainedItems} leftover bubbles in ${drainReads} reads`);

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failures:', failed.map((entry) => entry.name).join(', '));
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error('smoke failed:', error);
  process.exitCode = 1;
});
