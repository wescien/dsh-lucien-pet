#!/usr/bin/env node
/**
 * 大肥鱼宠物套件 · 跨平台安装器
 *
 * 作用：把 pet-chatter（吐槽气泡）和 dsh-nekowhale-stickers（表情包）
 * 连同作者调好的配置，装进本机的 dsh profile。
 *
 * 用法（在仓库根目录）：
 *   node install/apply.mjs                      # 装插件 + 配置，再跑 pnpm install
 *   node install/apply.mjs --download-assets    # 顺带下载 400 MB 表情素材包（离线可用）
 *   node install/apply.mjs --assets ./assets.zip
 *   node install/apply.mjs --json               # 输出机器可读结果
 *
 * 可选参数：
 *   --profile <dir>   指定 profile 目录（默认 $DSH_HOME/profiles/desktop）
 *   --dsh-home <dir>  指定 DSH_HOME（默认 ~/.dsh）
 *   --data-dir <dir>  表情数据目录（默认 $DSH_HOME/nekowhale-stickers）
 *   --skip-install    不执行 pnpm install
 *   --force           素材已存在时也重新解压
 *   --dry-run         只打印将要做的改动
 *
 * 设计原则：幂等（重复执行不会写重复配置）、先备份后修改、失败不破坏原配置。
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, '..');
const IS_WIN = process.platform === 'win32';

const PLUGINS = [
  { id: 'pet-chatter', pkg: '@local/pet-chatter', dir: 'pet-chatter' },
  { id: 'nekowhale-stickers', pkg: 'dsh-nekowhale-stickers', dir: 'dsh-nekowhale-stickers' },
];

const ASSET_URL =
  'https://github.com/wescien/dsh-lucien-pet/releases/download/assets-v1009/nekowhale-stickers-assets-v1009.zip';

const args = parseArgs(process.argv.slice(2));
const result = { ok: true, steps: [], warnings: [] };

function parseArgs(argv) {
  const out = { profile: null, dshHome: null, dataDir: null, assets: null, download: false, skipInstall: false, force: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`参数 ${a} 缺少值`);
      return v;
    };
    switch (a) {
      case '--profile': out.profile = next(); break;
      case '--dsh-home': out.dshHome = next(); break;
      case '--data-dir': out.dataDir = next(); break;
      case '--assets': out.assets = next(); break;
      case '--download-assets': out.download = true; break;
      case '--skip-install': out.skipInstall = true; break;
      case '--force': out.force = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': help(); process.exit(0); break;
      default: die(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  return out;
}

function say(msg) {
  if (!args.json) console.log(msg);
  result.steps.push(msg);
}
function warn(msg) {
  result.warnings.push(msg);
  if (!args.json) console.log(`  ⚠ ${msg}`);
}
function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}
function help() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace(/^#!.*\n/, ''));
}

const toPosix = (p) => p.split('\\').join('/');
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function backup(file) {
  const bak = `${file}.bak-${stamp()}`;
  writeFileSync(bak, readFileSync(file));
  return bak;
}

/** 读文本并去掉 BOM（Windows 上 PowerShell Set-Content 经常留一个） */
function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** $DSH_HOME：参数 > 环境变量 > ~/.dsh */
function resolveDshHome() {
  const home = args.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
  if (!existsSync(home)) die(`找不到 DSH_HOME：${home}\n先装好 DeepSeek Harness 桌面版，或用 --dsh-home 指过去。`);
  return resolve(home);
}

/** profile 目录：参数 > 环境变量 > profiles/desktop > profiles/ 下第一个 */
function resolveProfile(dshHome) {
  if (args.profile) {
    const p = resolve(args.profile);
    if (!existsSync(p)) die(`指定的 profile 目录不存在：${p}`);
    return p;
  }
  if (process.env.DSH_PROFILE_DIR && existsSync(process.env.DSH_PROFILE_DIR)) return resolve(process.env.DSH_PROFILE_DIR);

  const root = join(dshHome, 'profiles');
  const desktop = join(root, 'desktop');
  if (existsSync(desktop)) return desktop;
  if (existsSync(root)) {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length === 1) return join(root, dirs[0].name);
    if (dirs.length > 1) die(`profiles 下有多个目录，请用 --profile 指定：\n  ${dirs.map((d) => d.name).join('\n  ')}`);
  }
  die(`找不到 profile 目录（${root}）。dsh 还没初始化过 profile？`);
}

// ── 1. 校验仓库完整 ──────────────────────────────────────────────
for (const p of PLUGINS) {
  if (!existsSync(join(REPO_DIR, p.dir, 'package.json'))) die(`仓库不完整：缺少 ${p.dir}/package.json\n请在克隆下来的仓库根目录执行本脚本。`);
}

const DSH_HOME = resolveDshHome();
const PROFILE = resolveProfile(DSH_HOME);
const DATA_DIR = resolve(args.dataDir || join(DSH_HOME, 'nekowhale-stickers'));

say(`仓库：${REPO_DIR}`);
say(`profile：${PROFILE}`);
if (args.dryRun) say('（--dry-run：只显示改动，不写文件）');

// ── 2. profile/package.json：依赖 + bundles ─────────────────────
function patchPackageJson() {
  const file = join(PROFILE, 'package.json');
  let json;
  if (existsSync(file)) {
    try {
      json = JSON.parse(readText(file));
    } catch (e) {
      die(`profile/package.json 不是合法 JSON，先修好它：${e.message}`);
    }
  } else {
    json = { name: 'dsh-profile', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  }

  json.dependencies ??= {};
  json.dsh ??= {};
  json.dsh.profile ??= {};
  json.dsh.profile.bundles ??= [];

  const changes = [];
  for (const p of PLUGINS) {
    const link = `link:${toPosix(resolve(REPO_DIR, p.dir))}`;
    if (json.dependencies[p.pkg] === link) {
      say(`  依赖 ${p.pkg} 已登记`);
    } else {
      json.dependencies[p.pkg] = link;
      changes.push(`依赖 ${p.pkg} → ${link}`);
    }
    if (json.dsh.profile.bundles.includes(p.pkg)) {
      say(`  bundles 已含 ${p.pkg}`);
    } else {
      json.dsh.profile.bundles.push(p.pkg);
      changes.push(`bundles 追加 ${p.pkg}`);
    }
  }

  if (!changes.length) {
    say('package.json：无需改动');
    return { file, changed: false };
  }
  for (const c of changes) say(`  ${c}`);
  if (args.dryRun) return { file, changed: true, dry: true };

  const bak = existsSync(file) ? backup(file) : null;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  if (bak) say(`  已备份 ${bak}`);
  return { file, changed: true };
}

// ── 3. cordis.patch.yml：追加作者配置 ───────────────────────────
function splitEntries(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^- id:/.test(line)) {
      if (cur) entries.push(cur);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) entries.push(cur);
  return entries.map((lines) => lines.join('\n').replace(/\s+$/, '')).filter(Boolean);
}

function patchCordisYml() {
  const file = join(PROFILE, 'cordis.patch.yml');
  const snippetFile = join(SCRIPT_DIR, 'profile.patch.yml');
  if (!existsSync(snippetFile)) die(`缺少配置片段：${snippetFile}`);

  const existing = existsSync(file) ? readText(file) : '';
  const existingIds = new Set([...existing.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]));
  const entries = splitEntries(readFileSync(snippetFile, 'utf8'));

  const missing = entries.filter((e) => {
    const id = /^- id:\s*(\S+)/.exec(e)?.[1];
    return id && !existingIds.has(id);
  });

  if (!missing.length) {
    say('cordis.patch.yml：配置已存在，跳过');
    return { file, changed: false, added: [] };
  }

  const added = missing.map((e) => /^- id:\s*(\S+)/.exec(e)[1]);
  say(`  追加配置：${added.join('、')}`);
  if (args.dryRun) return { file, changed: true, added, dry: true };

  const bak = existsSync(file) ? backup(file) : null;
  const base = existing.replace(/\s*$/, '');
  writeFileSync(file, `${base ? base + '\n\n' : ''}${missing.join('\n\n')}\n`);
  if (bak) say(`  已备份 ${bak}`);
  return { file, changed: true, added };
}

// ── 4. 依赖安装 ─────────────────────────────────────────────────
function findNode() {
  const probe = spawnSync('node', ['--version'], { encoding: 'utf8', shell: IS_WIN });
  if (probe.status === 0) return { cmd: process.execPath, how: '当前 node' };
  return { cmd: process.execPath, how: '当前 node（PATH 里没有，但脚本本身在跑）' };
}

function findPnpm(dshHome) {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: IS_WIN, timeout: 20000 });
  if (probe.status === 0) return { cmd: 'pnpm', args: [], how: `PATH 里的 pnpm ${probe.stdout.trim()}` };

  const runtimes = join(dshHome, 'dsh-runtimes');
  if (existsSync(runtimes)) {
    for (const d of readdirSync(runtimes, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const mjs = join(runtimes, d.name, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
      if (existsSync(mjs)) return { cmd: process.execPath, args: [mjs], how: `dsh 自带 pnpm（${mjs}）` };
    }
  }
  return null;
}

function installDeps() {
  if (args.skipInstall) {
    say('已跳过 pnpm install（记得自己进 profile 目录跑一次）');
    return;
  }
  const node = findNode();
  const pnpm = findPnpm(DSH_HOME);
  if (!pnpm) {
    warn('没找到 pnpm：请自己进 profile 目录执行 pnpm install');
    return;
  }
  say(`  使用 ${pnpm.how}`);
  const r = spawnSync(pnpm.cmd, [...pnpm.args, 'install'], {
    cwd: PROFILE,
    stdio: args.json ? 'pipe' : 'inherit',
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  });
  if (r.status !== 0) {
    warn(`pnpm install 退出码 ${r.status}${r.stderr ? `：${String(r.stderr).split('\n').slice(-3).join(' ')}` : ''}`);
    say('  依赖可能没装全，装完再重跑一次本脚本即可（幂等）');
    return;
  }
  say('  依赖已安装');
  void node;
}

// ── 5. 表情素材（可选离线包）────────────────────────────────────
function countGifs(dir) {
  const packs = join(dir, 'packs');
  if (!existsSync(packs)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.gif$/i.test(e.name)) n++;
    }
  };
  walk(packs);
  return n;
}

async function download(url, dest) {
  say(`  下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-lucien-pet-installer' } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（${url}）`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let lastPct = -10;
  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    got += chunk.length;
    if (!total) return;
    const pct = Math.floor((got / total) * 100);
    if (pct - lastPct >= 10) {
      lastPct = pct;
      if (!args.json) process.stdout.write(`     ${pct}% (${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB)\r`);
    }
  });
  try {
    await pipeline(stream, createWriteStream(dest));
  } catch (err) {
    try { unlinkSync(dest); } catch { /* 忽略 */ }
    throw new Error(`下载中断：${err.message ?? err}`);
  }
  if (!args.json) process.stdout.write('\n');
  const size = statSync(dest).size;
  if (size < 50 * 1024 * 1024) {
    try { unlinkSync(dest); } catch { /* 忽略 */ }
    throw new Error(`下载的文件只有 ${size} 字节，明显不对，已中止`);
  }
  say(`  下载完成 ${(size / 1048576).toFixed(0)} MB`);
  return size;
}

function extract(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const attempts = IS_WIN
    ? [['tar', ['-xf', zip, '-C', dest]], ['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]]]
    : [['unzip', ['-q', '-o', zip, '-d', dest]], ['tar', ['-xf', zip, '-C', dest]], ['python3', ['-m', 'zipfile', '-e', zip, dest]]];

  for (const [cmd, argv] of attempts) {
    const r = spawnSync(cmd, argv, { stdio: 'pipe', timeout: 20 * 60 * 1000 });
    if (r.status === 0) {
      say(`  解压完成（${cmd}）→ ${dest}`);
      return true;
    }
  }
  return false;
}

async function setupAssets() {
  const have = countGifs(DATA_DIR);
  if (have >= 300 && !args.force) {
    say(`表情素材：已有 ${have} 张，跳过`);
    return { dir: DATA_DIR, gifs: have, skipped: true };
  }

  let zip = args.assets ? resolve(args.assets) : null;
  let downloaded = false;
  if (zip && !existsSync(zip)) die(`--assets 指向的文件不存在：${zip}`);

  if (!zip && args.download) {
    if (args.dryRun) {
      say(`（--dry-run）将下载 ${ASSET_URL} 并解压到 ${DATA_DIR}`);
      return { dir: DATA_DIR, gifs: have, dry: true };
    }
    zip = join(tmpdir(), 'nekowhale-stickers-assets-v1009.zip');
    mkdirSync(DATA_DIR, { recursive: true });
    await download(ASSET_URL, zip);
    downloaded = true;
  }

  if (!zip) {
    if (have > 0) say(`表情素材：现有 ${have} 张（未满 322，可用 --download-assets 补全）`);
    else say('表情素材：未提供，插件会在使用时按需联网拉取（想离线全量请加 --download-assets）');
    return { dir: DATA_DIR, gifs: have };
  }

  if (args.dryRun) {
    say(`（--dry-run）将解压 ${zip} → ${DATA_DIR}`);
    return { dir: DATA_DIR, gifs: have, dry: true };
  }

  const ok = extract(zip, DATA_DIR);
  if (!ok) throw new Error(`解压失败：系统里没有可用的解压工具（tar / unzip / Expand-Archive）。\n请手动把 ${zip} 解压到 ${DATA_DIR}`);
  if (downloaded) {
    try { renameSync(zip, zip + '.done'); } catch { /* 忽略 */ }
  }
  const gifs = countGifs(DATA_DIR);
  say(`表情素材：${gifs} 张`);
  return { dir: DATA_DIR, gifs };
}

// ── 主流程 ──────────────────────────────────────────────────────
try {
  say('\n[1/4] 登记插件到 profile');
  const pkg = patchPackageJson();

  say('\n[2/4] 写入作者配置');
  const yml = patchCordisYml();

  say('\n[3/4] 安装依赖');
  installDeps();

  say('\n[4/4] 表情素材');
  let assets;
  try {
    assets = await setupAssets();
  } catch (err) {
    // 素材是可选增强：插件本身不依赖它，缺了会在用图时从 kiriyuki.com 按需拉取。
    assets = { dir: DATA_DIR, gifs: countGifs(DATA_DIR), failed: true, error: String(err.message ?? err) };
    warn(`表情素材没装上：${err.message ?? err}`);
    warn('这不影响插件本身：第一次用到表情时会从 kiriyuki.com 按需拉取（需联网）。');
    warn('想补成离线全量，等网络好点重跑：node install/apply.mjs --download-assets');
  }

  result.summary = { profile: PROFILE, packageJson: pkg, patch: yml, assets };
} catch (err) {
  result.ok = false;
  result.error = String(err && err.stack ? err.stack : err);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`\n✖ 安装失败：${err.message ?? err}`);
  }
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`
✔ 安装完成

下一步：
  1. 完全退出 dsh 再打开（只刷新网页不够，插件要重新加载）
  2. 打开任意对话，看右下角有没有大肥鱼桌宠
  3. 气泡是默认开着的；想换称呼 / 音色，改 ${join(PROFILE, 'cordis.patch.yml')} 里 id: pet-chatter 那段

撤销：把同目录下的 *.bak-* 覆盖回去，再跑一次 pnpm install。
`);
}
