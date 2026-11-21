#!/usr/bin/env node
/**
 * Read-only health check for the running pet-chatter plugin.
 *
 *   node tools/health.mjs [baseUrl]
 *
 * Prints the live configuration, queue/gate state, runtime numbers and the
 * on-disk data files. It never enqueues a bubble and never calls the model, so
 * it is safe to run at any time.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:64079').replace(/\/+$/, '');
const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const dataDir = path.join(home, 'pet-chatter');

const headers = { 'x-pet-chatter': '1' };
const results = [];
const line = (ok, name, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const info = (name, detail = '') => console.log(`      ${name}${detail ? `: ${detail}` : ''}`);

const main = async () => {
  let settings;
  try {
    const response = await fetch(`${base}/pet-chatter/settings`, { headers, cache: 'no-store' });
    line(response.ok, 'settings endpoint', `status ${response.status}`);
    if (!response.ok) return;
    settings = await response.json();
  } catch (error) {
    line(false, 'settings endpoint', error.message);
    return;
  }

  const pending = await fetch(`${base}/pet-chatter/pending`, { headers, cache: 'no-store' });
  line(pending.status === 200 || pending.status === 204, 'pending endpoint', `status ${pending.status}`);

  const e = settings.effective || {};
  info('personality', `${e.personality} / ${e.frequency} / idea ${e.ideaChance} / roast ${e.roastChance}`);
  info('voice', `${e.voice} rate ${e.rate} pitch ${e.pitch} volume ${e.volume} chance ${e.voiceChance}`);
  info('pacing', `gap ${e.minGapMinutes}m · max ${e.maxPerHour}/h · idle ${e.idleEnabled ? `${e.idleMinutes}m` : 'off'} · bedtime ${e.bedtime || 'off'}`);
  info('look', `${e.effects} · anchor ${e.anchor} · sticker ${e.stickerChance} · expressive ${e.expressive}`);

  const runtime = settings.runtime || {};
  info('runtime', `rss ${runtime.rssMB} MB · heap ${runtime.heapMB} MB · sessions ${runtime.sessions} · queue ${runtime.queue}`);
  if (Array.isArray(runtime.trend) && runtime.trend.length) {
    info('rss trend', `${runtime.trend.join(' → ')} MB`);
  }
  const gate = settings.gate || {};
  info('gate', `hour ${gate.hourCount}/${gate.maxPerHour}${gate.nextAt ? ` · next ≥ ${new Date(gate.nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`);
  info('night', `${settings.night?.active ? 'active' : 'inactive'} · window ${settings.night?.hours || '-'}`);
  info('client', String(settings.stats?.clientVersion || 'unknown'));
  info('memory facts', String(Array.isArray(settings.memory) ? settings.memory.length : 0));
  info('chat', `agent ${settings.chat?.ready ? 'ready' : 'not started'} · ${settings.chat?.turns || 0} turns · ${settings.chat?.percent || 0}%${settings.chat?.summaryChars ? ` · summary ${settings.chat.summaryChars} chars` : ''}`);

  // On-disk state.
  if (existsSync(dataDir)) {
    const files = readdirSync(dataDir).filter((name) => name.endsWith('.json'));
    info('data dir', dataDir);
    for (const name of files) {
      const size = statSync(path.join(dataDir, name)).size;
      info(`  ${name}`, `${size} B`);
    }
    try {
      const settingsFile = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
      line(settingsFile && typeof settingsFile === 'object', 'settings.json is valid JSON');
    } catch {
      line(false, 'settings.json is valid JSON');
    }
    const historyPath = path.join(dataDir, 'history.json');
    if (existsSync(historyPath)) {
      try {
        const historyFile = JSON.parse(readFileSync(historyPath, 'utf8'));
        line(Array.isArray(historyFile.entries), 'history.json is valid JSON', `${historyFile.entries.length} entries`);
      } catch {
        line(false, 'history.json is valid JSON');
      }
    } else {
      info('history.json', 'not created yet');
    }
    const chatStatePath = path.join(dataDir, 'chat-agent.json');
    if (existsSync(chatStatePath)) {
      try {
        const chatState = JSON.parse(readFileSync(chatStatePath, 'utf8'));
        line(
          Boolean(chatState && typeof chatState.sessionId === 'string' && chatState.sessionId && typeof chatState.summary === 'string'),
          'chat-agent.json is valid JSON',
          String(chatState.sessionId || ''),
        );
      } catch {
        line(false, 'chat-agent.json is valid JSON');
      }
    } else {
      info('chat-agent.json', 'not created yet');
    }
  } else {
    line(false, 'data directory exists', dataDir);
  }

  for (const folder of ['voice', 'stickers']) {
    const target = path.join(dataDir, folder);
    if (!existsSync(target)) {
      info(folder, 'missing (nothing cached yet)');
      continue;
    }
    const names = readdirSync(target);
    let bytes = 0;
    for (const name of names) {
      try {
        bytes += statSync(path.join(target, name)).size;
      } catch {
        /* file vanished between listing and stat */
      }
    }
    info(folder, `${names.length} files · ${(bytes / 1048576).toFixed(1)} MB`);
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
};

main().catch((error) => {
  console.error('health check failed:', error);
  process.exitCode = 1;
});
