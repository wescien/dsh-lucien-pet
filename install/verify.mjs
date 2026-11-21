#!/usr/bin/env node
/**
 * 「一样的大肥鱼」自检脚本（零依赖，Node >= 18）
 *
 * 用途：装完之后跑一次，把 AGENTS.md 第 2 节的 6 条验收标准逐条核对，
 * 打印 ✅/❌ 表格。别人「报结果」时贴这个输出，而不是口头说装好了。
 *
 * 用法：
 *   node install/verify.mjs                 # 自动找 profile 与数据目录
 *   node install/verify.mjs --json          # 机器可读，便于 AI 转述
 *   node install/verify.mjs --profile <dir> --data-dir <dir> --repo <dir>
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
const wantJson = process.argv.includes('--json');

const dshHome = arg('dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh'));
let profileDir = arg('profile', process.env.DSH_PROFILE_DIR);
if (!profileDir) {
  const def = join(dshHome, 'profiles', 'desktop');
  if (existsSync(def)) profileDir = def;
  else {
    const profilesRoot = join(dshHome, 'profiles');
    const subs = existsSync(profilesRoot)
      ? readdirSync(profilesRoot).filter((n) => statSync(join(profilesRoot, n)).isDirectory())
      : [];
    profileDir = subs.length === 1 ? join(profilesRoot, subs[0]) : def;
  }
}
const dataDir = arg('data-dir', join(dshHome, 'nekowhale-stickers'));
const repoDir = arg('repo', root);

const readText = (f) => readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
const readJson = (f) => JSON.parse(readText(f));

const checks = [];
const add = (id, label, expected, actual, pass, hint) =>
  checks.push({ id, label, expected, actual, pass: !!pass, hint: pass ? undefined : hint });

// ── 1. 两个插件版本 ────────────────────────────────────────────
try {
  const a = readJson(join(repoDir, 'pet-chatter', 'package.json'));
  const b = readJson(join(repoDir, 'dsh-nekowhale-stickers', 'package.json'));
  const ok = a.version === '0.8.4' && b.version === '1.1.1';
  add('versions', '插件版本', 'pet-chatter 0.8.4 + stickers 1.1.1', `${a.version} + ${b.version}`, ok,
    '仓库文件可能不完整，重新 git clone');
} catch (e) {
  add('versions', '插件版本', 'pet-chatter 0.8.4 + stickers 1.1.1', '读不到 package.json', false, String(e.message));
}

// ── 2~4. profile 配置 ─────────────────────────────────────────
function sectionOf(text, id) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}
function configKeys(block) {
  if (!block) return [];
  const cfgIdx = block.findIndex((l) => /^\s*config:\s*$/.test(l));
  if (cfgIdx === -1) return [];
  const baseIndent = block[cfgIdx].match(/^\s*/)[0].length;
  const keys = [];
  for (const line of block.slice(cfgIdx + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^(\s*)([A-Za-z_][\w-]*):/);
    if (!m) continue;
    if (m[1].length > baseIndent) keys.push(m[2]);
  }
  return keys;
}
const patchFile = join(profileDir, 'cordis.patch.yml');
let patchText = '';
try {
  patchText = readText(patchFile);
} catch {
  /* 下面按缺失处理 */
}
const petBlock = sectionOf(patchText, 'pet-chatter');
const petKeys = configKeys(petBlock);
add('config', '气泡配置条目', 'pet-chatter 存在且 config 有 38 个键',
  petBlock ? `${petKeys.length} 个键` : '没有 pet-chatter 段', petKeys.length === 38,
  `检查 ${patchFile}；应为安装器自动追加的那段`);
add('voice', '音色参数', 'voice=zh-CN-XiaoyiNeural, rate=+8%, pitch=+15Hz, volume=0.9',
  petKeys.length ? ['voice', 'rate', 'pitch', 'volume'].map((k) => {
    const line = petBlock.find((l) => new RegExp(`^\\s*${k}:`).test(l));
    return line ? line.trim() : `${k}=缺`;
  }).join(' ') : '缺配置',
  ['voice', 'rate', 'pitch', 'volume'].every((k) => petKeys.includes(k)),
  '少了这几项说明装的是默认配置，不是作者那份');

const stickerBlock = sectionOf(patchText, 'nekowhale-stickers');
add('petHeight', '桌宠高度', 'petHeight: 233',
  stickerBlock && stickerBlock.some((l) => /^\s*petHeight:\s*233\s*$/.test(l)) ? '233' : '不是 233 / 缺配置',
  !!(stickerBlock && stickerBlock.some((l) => /^\s*petHeight:\s*233\s*$/.test(l))),
  `检查 ${patchFile} 的 nekowhale-stickers 段`);

// ── profile 是否登记了两个插件 ────────────────────────────────
try {
  const pkg = readJson(join(profileDir, 'package.json'));
  const deps = Object.keys(pkg.dependencies || {}).filter((k) => /pet-chatter|nekowhale-stickers/.test(k));
  const bundles = ((pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [])
    .filter((b) => /pet-chatter|nekowhale-stickers/.test(b));
  add('registered', '插件已登记', 'dependencies 2 项 + bundles 2 项',
    `dependencies ${deps.length} 项 / bundles ${bundles.length} 项`,
    deps.length === 2 && bundles.length === 2, `检查 ${join(profileDir, 'package.json')}`);
} catch (e) {
  add('registered', '插件已登记', 'dependencies 2 项 + bundles 2 项', '读不到 package.json', false, String(e.message));
}

// ── 5. 表情张数 ───────────────────────────────────────────────
let gifs = 0;
let bytes = 0;
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.gif$/i.test(name)) { gifs++; bytes += st.size; }
  }
})(join(dataDir, 'packs'));
add('stickers', '表情素材', '322 张 GIF（约 407 MB）',
  `${gifs} 张 / ${(bytes / 1024 / 1024).toFixed(1)} MB`, gifs === 322,
  `检查 ${join(dataDir, 'packs')}；重跑安装器加 --download-assets`);

// ── 输出 ─────────────────────────────────────────────────────
const ok = checks.every((c) => c.pass);
if (wantJson) {
  console.log(JSON.stringify({ ok, profile: profileDir, dataDir, checks }, null, 2));
} else {
  console.log(`profile: ${profileDir}`);
  console.log(`数据目录: ${dataDir}\n`);
  checks.forEach((c, i) => {
    console.log(`${c.pass ? '✅' : '❌'} ${i + 1}. ${c.label}：${c.actual}`);
    if (!c.pass && c.hint) console.log(`     ↳ ${c.hint}`);
  });
  console.log(`\n${ok ? '全部通过：和作者那份配置一致。' : '有项目不合格，见上面 ↳ 提示。'}`);
  console.log('第 6 条（重启后肉眼确认桌宠与气泡）需要你自己看，脚本查不到。');
}
process.exit(ok ? 0 : 1);
