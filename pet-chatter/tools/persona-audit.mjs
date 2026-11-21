#!/usr/bin/env node
/**
 * Persona quality audit for pet-chatter.
 *
 *   node tools/persona-audit.mjs [baseUrl]              # audit the live history
 *   node tools/persona-audit.mjs --generate 5            # generate + audit 5 lines
 *
 * Flags the failure modes that make the pet sound robotic:
 *   - talking about its own UI ("右上角", "气泡", "设置" …)
 *   - template phrases ("加油", "记得休息" …)
 *   - duplicates and over-long lines
 * Generation mode uses the neutral `?sample=1` turn so it exercises the normal
 * path instead of the self-topic fallback. It does not touch the live queue.
 */
import process from 'node:process';

const args = process.argv.slice(2);
const baseArg = args.find((value) => /^https?:\/\//.test(value));
const base = (baseArg || process.env.DSH_WEB_URL || 'http://127.0.0.1:64079').replace(/\/+$/, '');
const headers = { 'x-pet-chatter': '1' };
const generateIndex = args.indexOf('--generate');
const generateCount = generateIndex >= 0 ? Math.max(1, Math.min(12, Number(args[generateIndex + 1]) || 0)) : 0;

const UI_WORDS = /右上角|气泡|插件|设置|界面|位置|挪|搬|语音|调试|参数/;
const TEMPLATE = /加油|记得休息|辛苦了|注意休息|早点睡哦/;
const MAX_CHARS = 60;

const collectHistory = async () => {
  const response = await fetch(`${base}/pet-chatter/settings`, { headers, cache: 'no-store' });
  const json = await response.json();
  return (Array.isArray(json.history) ? json.history : []).map((entry) => String(entry.text || ''));
};

const generate = async (count) => {
  const texts = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${base}/pet-chatter/test?kind=comment&internal=1&sample=1`, {
      method: 'POST',
      headers,
    });
    const json = await response.json().catch(() => null);
    if (json?.item?.text) {
      texts.push(json.item.text);
      console.log(`GEN  ${json.item.text}`);
    } else {
      console.log(`GEN  (failed: ${response.status} ${json?.error || ''})`);
    }
  }
  return texts;
};

const audit = (texts) => {
  const seen = new Map();
  let ui = 0;
  let template = 0;
  let long = 0;
  for (const text of texts) {
    const flags = [];
    if (UI_WORDS.test(text)) {
      ui += 1;
      flags.push('UI');
    }
    if (TEMPLATE.test(text)) {
      template += 1;
      flags.push('TEMPLATE');
    }
    if (text.length > MAX_CHARS) {
      long += 1;
      flags.push('LONG');
    }
    seen.set(text, (seen.get(text) || 0) + 1);
    if (flags.length) console.log(`${flags.join(',')}  ${text}`);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  const lengths = texts.map((text) => text.length);
  const average = lengths.length ? Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length) : 0;
  console.log(`\nremarks: ${texts.length}`);
  console.log(`UI self-reference: ${ui}`);
  console.log(`template phrases: ${template}`);
  console.log(`over ${MAX_CHARS} chars: ${long}`);
  console.log(`duplicates: ${duplicates.length}`);
  for (const [text, count] of duplicates) console.log(`  x${count}  ${text}`);
  if (lengths.length) console.log(`length: avg ${average}, max ${Math.max(...lengths)}`);
  const clean = ui === 0 && template === 0 && long === 0 && duplicates.length === 0;
  return clean;
};

const main = async () => {
  const texts = generateCount ? await generate(generateCount) : await collectHistory();
  if (!texts.length) {
    console.log('no remarks to audit');
    return;
  }
  if (!audit(texts)) process.exitCode = 1;
};

main().catch((error) => {
  console.error('persona audit failed:', error);
  process.exitCode = 1;
});
