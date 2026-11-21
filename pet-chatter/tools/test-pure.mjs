#!/usr/bin/env node
/**
 * Unit checks for the dependency-free helpers in lib/pure.js.
 *
 *   node tools/test-pure.mjs
 */
import assert from 'node:assert/strict';

import { MOODS, bedtimeDue, clip, dayKey, inQuietHours, isClockTime, nightActive, number, oneOf, parseRemark, presetPatch, shouldIdle, shiftPitch, shiftRate, stripDecorativeMarks, stripHtml, stripMarkdown, textOf, trimRemark, withNightOverlay } from '../lib/pure.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
};

test('clip collapses whitespace and appends an ellipsis', () => {
  assert.equal(clip('  a \n b ', 10), 'a b');
  assert.equal(clip('一二三四五', 3), '一二三…');
});

test('number clamps and falls back', () => {
  assert.equal(number('0.5', 1, 0, 1), 0.5);
  assert.equal(number(9, 1, 0, 1), 1);
  assert.equal(number(-9, 1, 0, 1), 0);
  assert.equal(number('abc', 0.7, 0, 1), 0.7);
});

test('oneOf keeps known values only', () => {
  assert.equal(oneOf('often', ['rare', 'normal', 'often'], 'normal'), 'often');
  assert.equal(oneOf('nope', ['rare', 'normal', 'often'], 'normal'), 'normal');
  assert.equal(oneOf(undefined, ['a'], 'a'), 'a');
});

const at = (hour, minute) => new Date(2026, 0, 1, hour, minute, 0, 0);

test('inQuietHours handles a same-day window', () => {
  assert.equal(inQuietHours('01:00-08:00', at(2, 30)), true);
  assert.equal(inQuietHours('01:00-08:00', at(0, 30)), false);
  assert.equal(inQuietHours('01:00-08:00', at(8, 0)), false);
  assert.equal(inQuietHours('01:00-08:00', at(9, 0)), false);
});

test('inQuietHours handles a midnight-wrapping window', () => {
  assert.equal(inQuietHours('23:00-07:00', at(23, 30)), true);
  assert.equal(inQuietHours('23:00-07:00', at(6, 59)), true);
  assert.equal(inQuietHours('23:00-07:00', at(12, 0)), false);
});

test('inQuietHours rejects malformed or empty windows', () => {
  assert.equal(inQuietHours('', at(2, 0)), false);
  assert.equal(inQuietHours('abc', at(2, 0)), false);
  assert.equal(inQuietHours('10:00-10:00', at(10, 0)), false);
});

test('textOf reads strings, blocks and empty payloads', () => {
  assert.equal(textOf({ content: 'hi' }), 'hi');
  assert.equal(
    textOf({ content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'x' }, { type: 'text', text: 'b' }] }),
    'ab',
  );
  assert.equal(textOf({}), '');
  assert.equal(textOf(null), '');
});

test('trimRemark prefers a sentence end', () => {
  assert.equal(trimRemark('一二三四五六七八。九十', 10), '一二三四五六七八。');
  assert.equal(trimRemark('短句', 10), '短句');
  assert.equal(trimRemark('没有标点的一段很长的话', 5), '没有标点的…');
});

test('parseRemark accepts strict JSON', () => {
  const parsed = parseRemark('{"text":"老大真快","mood":"赞"}');
  assert.equal(parsed.text, '老大真快');
  assert.equal(parsed.mood, '赞');
});

test('parseRemark tolerates code fences and unknown moods', () => {
  const parsed = parseRemark('```json\n{"text":"喵","mood":"胡说"}\n```');
  assert.equal(parsed.text, '喵');
  assert.equal(parsed.mood, '开心');
  assert.ok(MOODS.includes(parsed.mood));
});

test('parseRemark falls back to plain text and strips markup', () => {
  const parsed = parseRemark('**老大** 好样的');
  assert.equal(parsed.text, '老大 好样的');
  assert.equal(parsed.mood, '开心');
});

test('parseRemark honours the length budget', () => {
  const long = '一'.repeat(80);
  assert.equal(parseRemark(long, 10).text.length, 11); // 10 chars + ellipsis
  assert.equal(parseRemark('{"text":"' + long + '"}', 12).text.length, 13);
});

test('stripHtml removes model paragraph wrappers', () => {
  assert.equal(stripHtml('<p>老大冒泡啦！</p>'), '老大冒泡啦！');
  assert.equal(stripHtml('<p>第一行<br>第二行</p>'), '第一行 第二行');
  assert.equal(stripHtml('&lt;p&gt;你好&lt;/p&gt;'), '你好');
  assert.equal(stripHtml('<p你好</p'), '你好');
  assert.equal(stripHtml('1 < 2 不是标签'), '1 < 2 不是标签');
  assert.equal(parseRemark('{"text":"<p>老大冒泡啦！</p>","mood":"开心"}').text, '老大冒泡啦！');
});

test('stripDecorativeMarks drops standalone macrons anywhere', () => {
  assert.equal(stripDecorativeMarks('老大晚上好哦￣'), '老大晚上好哦');
  assert.equal(stripDecorativeMarks('老大晚上好哦￣。'), '老大晚上好哦。');
  assert.equal(stripDecorativeMarks('物￣老大是不是在发呆'), '物老大是不是在发呆');
  assert.equal(stripDecorativeMarks('(￣▽￣)'), '(￣▽￣)');
  assert.equal(stripDecorativeMarks('=￣ω￣='), '=￣ω￣=');
  assert.equal(stripDecorativeMarks('普通破折号—'), '普通破折号—');
});

// ---- idle gate -------------------------------------------------------------

const idleConfig = { enabled: true, idleEnabled: true, idleMinutes: 45, minGapMinutes: 3, maxPerHour: 8, quietHours: '' };
const IDLE_NOW = new Date(2026, 0, 1, 14, 0, 0, 0).getTime();
const idleBase = () => ({
  config: { ...idleConfig },
  now: IDLE_NOW,
  lastPollAt: IDLE_NOW - 1_000,
  lastActivityAt: IDLE_NOW - 46 * 60_000,
  lastCommentAt: IDLE_NOW - 10 * 60_000,
  hourStart: IDLE_NOW - 60_000,
  hourCount: 1,
  inFlight: false,
  runningCount: 0,
  roll: 0.1,
});

test('shouldIdle allows a quiet, watched, idle session', () => {
  assert.equal(shouldIdle(idleBase()), true);
});

test('shouldIdle refuses when disabled or quiet', () => {
  assert.equal(shouldIdle({ ...idleBase(), config: { ...idleConfig, enabled: false } }), false);
  assert.equal(shouldIdle({ ...idleBase(), config: { ...idleConfig, idleEnabled: false } }), false);
  const quiet = { ...idleConfig, quietHours: '13:00-15:00' };
  assert.equal(shouldIdle({ ...idleBase(), config: quiet }), false);
});

test('shouldIdle ignores unrelated running sessions', () => {
  // A long background turn used to keep the global running count above zero,
  // silently disabling idle remarks for the whole session.
  assert.equal(shouldIdle({ ...idleBase(), runningCount: 3 }), true);
});

test('shouldIdle needs a recently polled page', () => {
  assert.equal(shouldIdle({ ...idleBase(), lastPollAt: IDLE_NOW - 120_000 }), false);
});

test('shouldIdle needs the human to be quiet long enough', () => {
  assert.equal(shouldIdle({ ...idleBase(), lastActivityAt: IDLE_NOW - 60_000 }), false);
});

test('shouldIdle respects the gap and the hourly cap', () => {
  assert.equal(shouldIdle({ ...idleBase(), lastCommentAt: IDLE_NOW - 60_000 }), false);
  assert.equal(shouldIdle({ ...idleBase(), hourCount: 8 }), false);
  // An expired hour window counts as zero used.
  assert.equal(shouldIdle({ ...idleBase(), hourCount: 8, hourStart: IDLE_NOW - 2 * 3_600_000 }), true);
});

test('shouldIdle skips while another remark is generating', () => {
  assert.equal(shouldIdle({ ...idleBase(), inFlight: true }), false);
});

test('shouldIdle honours the dice', () => {
  assert.equal(shouldIdle({ ...idleBase(), roll: 0.45 }), true);
  assert.equal(shouldIdle({ ...idleBase(), roll: 0.46 }), false);
});

// ---- prosody nudges --------------------------------------------------------

test('shiftRate adds a delta and keeps the sign', () => {
  assert.equal(shiftRate('+8%', 5), '+13%');
  assert.equal(shiftRate('+8%', -20), '-12%');
  assert.equal(shiftRate('-20%', 3), '-17%');
});

test('shiftRate clamps to the SSML range', () => {
  assert.equal(shiftRate('-50%', -60), '-100%');
  assert.equal(shiftRate('+150%', 100), '+200%');
});

test('shiftRate falls back to the default when the value is junk', () => {
  assert.equal(shiftRate('abc', 5), '+13%'); // fallback +8% + 5
  assert.equal(shiftRate('', 0), '+8%');
});

test('shiftPitch adds hertz and keeps the sign', () => {
  assert.equal(shiftPitch('+15Hz', 6), '+21Hz');
  assert.equal(shiftPitch('+15Hz', -20), '-5Hz');
});

test('shiftPitch clamps to the SSML range', () => {
  assert.equal(shiftPitch('-90Hz', -30), '-100Hz');
  assert.equal(shiftPitch('+95Hz', 20), '+100Hz');
});

test('shiftPitch falls back to the default when the value is junk', () => {
  assert.equal(shiftPitch('bad', 6), '+21Hz');
  assert.equal(shiftPitch('', 0), '+15Hz');
});


// ---- presets ---------------------------------------------------------------

test('presetPatch returns a copy of a known preset', () => {
  const quiet = presetPatch('quiet');
  assert.equal(quiet.frequency, 'rare');
  assert.equal(quiet.idleEnabled, false);
  assert.equal(quiet.roastChance, 0.05);
  quiet.frequency = 'often';
  assert.equal(presetPatch('quiet').frequency, 'rare');
});

test('presetPatch rejects unknown names', () => {
  assert.equal(presetPatch('nope'), null);
  assert.equal(presetPatch(''), null);
  assert.equal(presetPatch(undefined), null);
});

// ---- automatic night mode ------------------------------------------------

test('nightActive needs both the switch and the window', () => {
  assert.equal(nightActive({ nightAuto: false, nightHours: '01:00-08:00' }, at(2, 0)), false);
  assert.equal(nightActive({ nightAuto: true, nightHours: '01:00-08:00' }, at(2, 0)), true);
  assert.equal(nightActive({ nightAuto: true, nightHours: '01:00-08:00' }, at(9, 0)), false);
  assert.equal(nightActive({ nightAuto: true, nightHours: '23:00-07:00' }, at(23, 30)), true);
});

test('nightActive wraps across midnight', () => {
  assert.equal(nightActive({ nightAuto: true, nightHours: '23:00-07:00' }, at(0, 30)), true);
  assert.equal(nightActive({ nightAuto: true, nightHours: '23:00-07:00' }, at(12, 0)), false);
});

test('nightActive falls back to the default window', () => {
  assert.equal(nightActive({ nightAuto: true, nightHours: '' }, at(2, 0)), true);
});

test('withNightOverlay leaves the config untouched by day', () => {
  const config = { nightAuto: true, nightHours: '01:00-08:00', maxPerHour: 8, volume: 0.9 };
  const day = withNightOverlay(config, at(14, 0));
  assert.equal(day, config); // same reference: no work to do
});

test('withNightOverlay applies the night values when active', () => {
  const config = { nightAuto: true, nightHours: '01:00-08:00', maxPerHour: 8, volume: 0.9, idleEnabled: true };
  const night = withNightOverlay(config, at(2, 0));
  assert.equal(night.maxPerHour, 4);
  assert.equal(night.volume, 0.5);
  assert.equal(night.idleEnabled, false);
  assert.equal(night.night, true);
  assert.equal(config.maxPerHour, 8); // original untouched
});

// ---- bedtime nudge --------------------------------------------------------

test('dayKey is stable per local day', () => {
  assert.equal(dayKey(new Date(2026, 0, 2, 23, 59)), '2026-1-2');
  assert.equal(dayKey(new Date(2026, 0, 3, 0, 1)), '2026-1-3');
});

test('bedtimeDue fires inside the 15-minute window once a day', () => {
  const spec = '23:30';
  assert.equal(bedtimeDue(spec, new Date(2026, 0, 2, 23, 30), ''), true);
  assert.equal(bedtimeDue(spec, new Date(2026, 0, 2, 23, 44), ''), true);
  assert.equal(bedtimeDue(spec, new Date(2026, 0, 2, 23, 46), ''), false);
  assert.equal(bedtimeDue(spec, new Date(2026, 0, 2, 23, 29), ''), false);
  assert.equal(bedtimeDue(spec, new Date(2026, 0, 2, 23, 35), '2026-1-2'), false);
  assert.equal(bedtimeDue(spec, new Date(2026, 0, 3, 23, 35), '2026-1-2'), true);
});

test('bedtimeDue ignores empty or malformed specs', () => {
  assert.equal(bedtimeDue('', new Date(2026, 0, 2, 23, 30), ''), false);
  assert.equal(bedtimeDue('晚点睡', new Date(2026, 0, 2, 23, 30), ''), false);
});

test('stripMarkdown removes tables, fences and emphasis', () => {
  const sample = '标题\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**粗体** 和 `code` 以及 [链接](https://x.y)';
  const flat = stripMarkdown(sample);
  assert.ok(!flat.includes('|'));
  assert.ok(!flat.includes('**'));
  assert.ok(!flat.includes('`'));
  assert.ok(flat.includes('粗体'));
  assert.ok(flat.includes('链接'));
  assert.ok(!flat.includes('https://x.y'));
});

test('stripMarkdown keeps ordinary prose intact', () => {
  assert.equal(stripMarkdown('  老大 今天  很厉害。 '), '老大 今天 很厉害。');
});

test('isClockTime enforces real clock ranges', () => {
  assert.equal(isClockTime('23:30'), true);
  assert.equal(isClockTime('9:05'), true);
  assert.equal(isClockTime('00:00'), true);
  assert.equal(isClockTime('24:00'), false);
  assert.equal(isClockTime('99:99'), false);
  assert.equal(isClockTime('23:70'), false);
  assert.equal(isClockTime(''), false);
});
console.log(`\n${passed} checks passed`);