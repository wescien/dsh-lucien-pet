#!/usr/bin/env node
/**
 * Stress / abuse test for pet-chatter.
 *
 *   node tools/stress.mjs [baseUrl]
 *
 * Hammers the HTTP surface the way a buggy client or a hostile page would, then
 * checks the host is still healthy. No model calls, so it is cheap to repeat.
 */
import process from 'node:process';

const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:64079').replace(/\/+$/, '');
const headers = { 'x-pet-chatter': '1' };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
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

const get = (path) => fetch(`${base}${path}`, { headers, cache: 'no-store' });
const post = (path, body, extra = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...jsonHeaders, ...extra }, body });

const main = async () => {
  const before = await (await get('/pet-chatter/settings')).json();
  check(Boolean(before.effective), 'host is up before the abuse starts');

  // 1. A tight loop of polls must never 5xx.
  let pollFailures = 0;
  for (let index = 0; index < 120; index += 1) {
    const response = await get('/pet-chatter/pending');
    if (response.status >= 500) pollFailures += 1;
  }
  check(pollFailures === 0, '120 sequential polls without a 5xx', `${pollFailures} failures`);

  // 2. Concurrent producers must not corrupt the queue.
  const burst = await Promise.all(
    Array.from({ length: 15 }, (_, index) => post('/pet-chatter/say', JSON.stringify({ text: `并发 ${index}`, speak: false, internal: true }))),
  );
  check(burst.every((response) => response.status === 200), '15 concurrent says all succeed', burst.map((r) => r.status).join(','));

  // 3. Malformed input must be a 4xx, never a 5xx.
  const badBodies = ['{', 'null', '[]', '"text"', '{"text":null}', '{"text":123}', '{"text":"x".repeat}'];
  let badStatuses = 0;
  for (const body of badBodies) {
    for (const path of ['/pet-chatter/say', '/pet-chatter/chat', '/pet-chatter/reroll?internal=1', '/pet-chatter/settings']) {
      const response = await post(path, body);
      if (response.status >= 500) badStatuses += 1;
    }
  }
  check(badStatuses === 0, 'malformed bodies never 5xx', `${badStatuses} 5xx`);

  // 4. Oversized body is refused with 413 and the connection still works.
  const huge = JSON.stringify({ text: 'x'.repeat(40_000) });
  const tooBig = await post('/pet-chatter/say', huge);
  check(tooBig.status === 413, 'oversized body is refused', `${tooBig.status}`);
  const afterBig = await get('/pet-chatter/pending');
  check(afterBig.status === 204 || afterBig.status === 200, 'host still answers after a 413', `${afterBig.status}`);

  // 5. Wrong method and wrong header.
  const wrongMethod = await fetch(`${base}/pet-chatter/say`, { headers });
  check(wrongMethod.status === 405, 'GET on a POST route is 405', `${wrongMethod.status}`);
  const noHeader = await fetch(`${base}/pet-chatter/say`, { method: 'POST', body: '{}' });
  check(noHeader.status === 403, 'missing guard header is 403', `${noHeader.status}`);

  // 6. Unicode and control characters survive the trip.
  const weird = '大肥鱼🐋\u0000\u0007<>"\'`${x}%s';
  const weirdResponse = await post('/pet-chatter/say', JSON.stringify({ text: weird, speak: false, internal: true }));
  const weirdJson = await weirdResponse.json().catch(() => null);
  check(weirdResponse.status === 200 && typeof weirdJson?.item?.text === 'string', 'unicode payload is accepted', `${weirdJson?.item?.text?.length ?? 0} chars`);

  // 7. Many settings reads in parallel (the panel polls while the user clicks).
  const reads = await Promise.all(Array.from({ length: 20 }, () => get('/pet-chatter/settings')));
  check(reads.every((response) => response.status === 200), '20 concurrent settings reads', reads.map((r) => r.status).filter((s) => s !== 200).join(',') || 'all 200');

  // 8. Drain and confirm the host still looks the same.
  for (let index = 0; index < 30; index += 1) {
    const response = await get('/pet-chatter/pending');
    if (response.status === 204) break;
  }
  const after = await (await get('/pet-chatter/settings')).json();
  check(after.runtime && typeof after.runtime.queue === 'number' && after.runtime.queue <= 2, 'queue is bounded after the storm', `queue=${after.runtime?.queue}`);
  check(after.effective.enabled === before.effective.enabled, 'settings survived the storm');

  // 9. Voice files still serve after all of it.
  const voice = await get('/pet-chatter/settings').then((r) => r.json());
  const pending = await get('/pet-chatter/pending');
  check(pending.status === 204 || pending.status === 200, 'final poll is sane', `${pending.status}, facts=${voice.memory?.length}`);
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
