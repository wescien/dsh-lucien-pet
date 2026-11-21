import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadStream, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Schema from '@deepseek-ai/schemastery';

import { cachedVoice, lastSynthesisFailure, synthesize } from './tts.js';
import { MOODS, PRESET_LABELS, bedtimeDue, clip, dayKey, inQuietHours, nightActive, number, oneOf, parseRemark, presetPatch, shouldIdle, isClockTime, shiftPitch, shiftRate, stripDecorativeMarks, stripHtml, stripMarkdown, textOf, withNightOverlay } from './lib/pure.js';
import { REACTION_LINES, reactionAudioUrl } from './lib/reactions.js';

/**
 * Host half of @local/pet-chatter.
 *
 * Watches the committed session log for a finished human turn, asks the
 * configured model for one short in-character remark (or a mischievous idea),
 * synthesizes it to speech and queues the result for the browser bubble.
 * Nothing is written to the session log: remarks are transient UI.
 */

export const name = 'pet-chatter';
export const inject = ['webServer'];

/** dsh 0.2 edits `volatile()` fields in place; 0.1.5 passes plain values. */
const live = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema);
/** A volatile field arrives as a reference with `get()`. */
const plain = (value) =>
  value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;

const VOICES = [
  'zh-CN-XiaoyiNeural',
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoxiaoMultilingualNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-liaoning-XiaobeiNeural',
  'zh-CN-shaanxi-XiaoniNeural',
  'zh-TW-HsiaoChenNeural',
  'zh-TW-HsiaoYuNeural',
  'zh-HK-HiuMaanNeural',
  'zh-HK-WanLungNeural',
];

const PERSONALITIES = [
  'balance',
  'tease',
  'clingy',
  'gremlin',
  'zen',
  'hype',
  'random',
];

/** Bubble frames: presentation only — text, sticker and layout stay identical. */
const FRAMES = ['card', 'glass', 'outline', 'paper', 'neon', 'comic', 'native'];

/** Spoken/read line when every TTS engine has failed. Keep text and clip in sync. */
const AUDIO_ALERT_TEXT = '老大老大，音频失效辣';
const LEGACY_AUDIO_ALERT_TEXT = '主人，音频失效了';

export const Config = Schema.object({
  enabled: live(Schema.boolean().default(true).description('总开关：关闭后不再生成任何吐槽或语音。')),
  personality: live(
    Schema.union(PERSONALITIES).default('balance').description(
      '性格：balance 机灵小鲸鱼 / tease 毒舌小恶魔 / clingy 黏人精 / gremlin 捣蛋鬼 / zen 摸鱼哲学家 / hype 捧场王。',
    ),
  ),
  address: live(Schema.string().default('老大').description('它怎么称呼你，例如 老大、老板、主人。')),
  persona: live(Schema.string().default('').description('额外风格要求（一句话即可），会追加到提示里。')),
  ideaChance: live(Schema.number().default(0.18).description('鬼点子概率 0~1：0 只吐槽，1 每次都出鬼点子。')),
  roastChance: live(Schema.number().default(0.15).description('吐槽老大的概率 0~1（排在鬼点子之后）。')),
  frequency: live(
    Schema.union(['rare', 'normal', 'often']).default('normal').description('话痨程度：rare 偶尔 / normal 适中 / often 经常。'),
  ),
  minGapMinutes: live(Schema.natural().default(3).description('两条之间最少间隔（分钟）。')),
  maxPerHour: live(Schema.natural().default(8).description('每小时上限。')),
  quietHours: live(Schema.string().default('').description('静音时段，例如 01:00-08:00；留空表示不静音。')),
  tts: live(
    Schema.union(['auto', 'edge', 'sapi', 'off']).default('auto').description('语音：auto/edge 只用 Edge 神经语音（失败则改说音频失效提醒）；sapi 用 Windows 本地语音；off 只出气泡。'),
  ),
  voice: live(
    Schema.union(VOICES).default('zh-CN-XiaoyiNeural').description(
      '音色：晓伊/晓晓/多语晓晓/云希/云扬/云健/东北小北/陕西小妮/台湾晓臻/晓雨/粤语晓曼/云龙。',
    ),
  ),
  rate: live(Schema.string().default('+8%').description('语速，例如 +8%、-10%。')),
  pitch: live(Schema.string().default('+15Hz').description('音高，例如 +15Hz、-10Hz。')),
  volume: live(Schema.number().default(0.9).description('播放音量 0~1。')),
  voiceChance: live(Schema.number().default(1).description('语音出现频率 0~1。默认 1：每条气泡都有声音；调低才会偶尔只出字不发声。')),
  expressive: live(Schema.boolean().default(true).description('按语气微调语速/音高：鬼点子更快更高、安慰更慢更低。')),
  nightAuto: live(Schema.boolean().default(false).description('到了深夜时段自动降频、降音量并关掉空闲搭话。')),
  nightHours: live(Schema.string().default('01:00-08:00').description('深夜时段，例如 01:00-08:00。')),
  bedtime: live(Schema.string().default('').description('每天催睡觉的时间，例如 23:30；留空关闭。')),
  audioAlertText: live(Schema.string().default(AUDIO_ALERT_TEXT).description('语音合成失败时改说的这句话，自带本地音频。')),
  bedtimeQuietMinutes: live(Schema.natural().default(20).description('催睡后安静多少分钟，避免接着唠叨。')),
  idleEnabled: live(Schema.boolean().default(true).description('没人在聊时，是否偶尔主动搭话。')),
  idleMinutes: live(Schema.natural().min(1).default(45).description('静默多少分钟后可能主动搭话（最低 1 分钟）。')),
  effects: live(
    Schema.union(['none', 'soft', 'lively', 'typewriter']).default('soft').description('气泡特效：none 无 / soft 柔和 / lively 星屑弹跳 / typewriter 打字机。'),
  ),
  bubbleStyle: live(
    Schema.union(FRAMES).default('card').description(
      '气泡框样式：card 奶白卡片 / glass 玻璃 / outline 线框 / paper 便签 / neon 霓虹 / comic 漫画 / native 原生风（白底黑边、加粗圆体、贴头）。只换表面，文字与布局不变。',
    ),
  ),
  anchor: live(
    Schema.union(['pet', 'corner']).default('pet').description('气泡位置：pet 贴大肥鱼右上角并跟随拖动 / corner 固定在屏幕右下角。'),
  ),
  stickerChance: live(Schema.number().default(0.4).description('自动/预览气泡附带一张表情小图的概率 0~1；点击/拖动反馈强制带图，不受它影响。')),
  petReactions: live(Schema.boolean().default(true).description('点一下桌宠时，是否立刻用本地语音和气泡回应。')),
  clickBubbleChance: live(Schema.number().default(0.4).description('点一下桌宠时，冒出气泡+语音的概率 0~1；没抽中时只做桌宠表情反应。')),
  dragFeedback: live(Schema.boolean().default(true).description('拖动桌宠到新位置后，是否立刻用本地语音和气泡回应。')),
  dragBubbleChance: live(Schema.number().default(0.7).description('拖动松手后，冒出气泡+语音的概率 0~1；没抽中时只做桌宠表情反应。')),
  bubbleGapSeconds: live(Schema.natural().default(15).description('任意两条主动/点击/拖动气泡之间的统一间隔秒数；聊天优先，不受这个间隔限制。')),
  actionBiasChance: live(Schema.number().default(0.6).description('已知桌宠动作时，气泡台词偏向对应情绪的概率 0~1；未知动作仍 100% 随机。')),
  chatAgent: live(Schema.boolean().default(true).description('长按主动聊天是否使用独立、持久、有记忆的 agent（关闭则退回单次模型调用）。')),
  chatReasoning: live(
    Schema.union(['low']).default('low').description('主动聊天 agent 的思考强度：固定为最轻的 low，保证快速回答。'),
  ),
  chatCompactPercent: live(Schema.natural().default(72).description('主动聊天 agent 的上下文用到百分之多少时自动压缩（40~95）。')),
  queueTtlSeconds: live(Schema.natural().default(120).description('排队条目过期秒数。')),
});

const HEADER = 'x-pet-chatter';
const MAX_QUEUE = 2;
const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 30 * 60_000;
const POLL_FRESH_MS = 90_000;
const VOICE_TTL_MS = 7 * 24 * 60 * 60_000;

const DEFAULTS = {
  enabled: true,
  personality: 'balance',
  address: '老大',
  persona: '',
  ideaChance: 0.18,
  roastChance: 0.15,
  frequency: 'normal',
  minGapMinutes: 3,
  maxPerHour: 8,
  quietHours: '',
  tts: 'auto',
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+8%',
  pitch: '+15Hz',
  volume: 0.9,
  voiceChance: 1,
  expressive: true,
  nightAuto: false,
  nightHours: '01:00-08:00',
  bedtime: '',
  audioAlertText: AUDIO_ALERT_TEXT,
  bedtimeQuietMinutes: 20,
  idleEnabled: true,
  idleMinutes: 45,
  effects: 'soft',
  bubbleStyle: 'card',
  anchor: 'pet',
  stickerChance: 0.4,
  petReactions: true,
  clickBubbleChance: 0.4,
  dragFeedback: true,
  dragBubbleChance: 0.7,
  bubbleGapSeconds: 15,
  actionBiasChance: 0.6,
  chatAgent: true,
  chatReasoning: 'low',
  chatCompactPercent: 72,
  queueTtlSeconds: 120,
};

const CHANCE = { rare: 0.3, normal: 0.55, often: 0.85 };

const TRAITS = {
  balance: '可爱、机灵、有点贱兮兮；会吐槽也会拍马屁，但绝不冒犯、不油腻、不说教。',
  tease: '毒舌小恶魔：嘴上不饶人，专挑老大话里的小漏洞轻刺一下，但最后一定补一句软话，让人被损了还想笑。',
  clingy: '黏人精：特别想被夸、被摸头，爱撒娇、爱求关注，连吐槽都带着撒娇的尾音。',
  gremlin: '捣蛋鬼：满脑子鬼点子，喜欢怂恿老大做点无伤大雅的小坏事，说话兴奋、跳跃、跃跃欲试。',
  zen: '摸鱼哲学家：看淡一切，用佛系口吻劝老大别卷，结尾爱甩一句似是而非的歪理，云淡风轻。',
  hype: '捧场王：不管老大干了啥先夸三句，最后再轻轻补一刀吐槽，热情得像应援团。',
};

/** Turns that are about this plugin's own UI: remarks about "where I sit" read as a bug. */
const SELF_TOPIC_RE = /气泡|语音|插件|设置|音色|表情包|桌宠|吐槽|界面|右键/;
const SELF_BANNED_RE = /挪|搬|位置|气泡|界面|设置|语音|拎|右上角|插件|调试|参数|调我|搬我|挪我/;
const SELF_FALLBACKS = [
  '好啦好啦，先不折腾我，陪我发会儿呆。',
  '这个点还亮着屏，我尾巴都困卷了。',
  '忙完这阵子，记得摸摸我。',
  '再盯下去，你的黑眼圈要成我的同款了。',
];

/** Replace a self-referential remark when the model still talks about the UI. */
function guardSelfTopic(raw, selfTopic) {
  if (!selfTopic || !SELF_BANNED_RE.test(String(raw ?? ''))) return raw;
  const line = SELF_FALLBACKS[Math.floor(Math.random() * SELF_FALLBACKS.length)];
  return JSON.stringify({ text: line, mood: '开心' });
}

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DATA_DIR = path.join(HOME, 'pet-chatter');
const VOICE_DIR = path.join(DATA_DIR, 'voice');
const STICKER_DIR = path.join(DATA_DIR, 'stickers');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
/** Ships with the bundle: the last-resort clip so an alert is never silent. */
const ALERT_VOICE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'audio-alert.mp3');
const ALERT_VOICE_URL = '/pet-chatter/alert-voice?v=xiaoyi-1';
/** Bundled tap/drag clips: no model, no TTS, no network at reaction time. */
const REACTION_VOICE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'reactions');
const LAST_TURN_FILE = path.join(DATA_DIR, 'last-turn.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const RSS_FILE = path.join(DATA_DIR, 'rss-trend.json');
/** Last remarks, persisted so the panel and audits survive a reload. */
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
/** Memory-agent identity + compressed summary: survives restarts and rotations. */
const CHAT_STATE_FILE = path.join(DATA_DIR, 'chat-agent.json');
/** Must match the version reported by client.js. */
const CLIENT_VERSION = 'bubble-83';

/** Accept only well-typed, in-range values so a bad form entry cannot poison the file. */
const ENUMS = {
  personality: PERSONALITIES,  frequency: Object.keys(CHANCE),
  tts: ['auto', 'edge', 'sapi', 'off'],
  voice: VOICES,
  effects: ['none', 'soft', 'lively', 'typewriter'],
  bubbleStyle: FRAMES,
  anchor: ['pet', 'corner'],
  chatReasoning: ['low'],
};
const NUMBERS = {
  ideaChance: [0, 1],
  roastChance: [0, 1],
  minGapMinutes: [0, 24 * 60],
  maxPerHour: [0, 240],
  idleMinutes: [1, 24 * 60],
  volume: [0, 1],
  voiceChance: [0, 1],
  stickerChance: [0, 1],
  queueTtlSeconds: [10, 3600],
  bedtimeQuietMinutes: [0, 240],
  bubbleGapSeconds: [0, 600],
  actionBiasChance: [0, 1],
  clickBubbleChance: [0, 1],
  dragBubbleChance: [0, 1],
  chatCompactPercent: [40, 95],
};
const STRINGS = { address: 12, persona: 400, rate: 12, pitch: 12, quietHours: 32, nightHours: 32, bedtime: 5, audioAlertText: 40 };

function coercePatch(patch) {
  const out = {};
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
  if (typeof patch.expressive === 'boolean') out.expressive = patch.expressive;
  if (typeof patch.idleEnabled === 'boolean') out.idleEnabled = patch.idleEnabled;
  if (typeof patch.nightAuto === 'boolean') out.nightAuto = patch.nightAuto;
  if (typeof patch.petReactions === 'boolean') out.petReactions = patch.petReactions;
  if (typeof patch.dragFeedback === 'boolean') out.dragFeedback = patch.dragFeedback;
  if (typeof patch.chatAgent === 'boolean') out.chatAgent = patch.chatAgent;
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (typeof patch[key] === 'string' && allowed.includes(patch[key])) out[key] = patch[key];
  }
  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    const raw = patch[key];
    const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    if (Number.isFinite(value)) out[key] = Math.min(Math.max(value, min), max);
  }
  for (const [key, max] of Object.entries(STRINGS)) {
    if (typeof patch[key] === 'string') out[key] = clip(patch[key], max);
  }
  return out;
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const get = (key) => plain(source[key]);
  return {
    enabled: get('enabled') === undefined ? DEFAULTS.enabled : Boolean(get('enabled')),
    personality: oneOf(get('personality'), PERSONALITIES, DEFAULTS.personality),
    address: typeof get('address') === 'string' && get('address').trim() ? clip(get('address'), 12) : DEFAULTS.address,
    persona: typeof get('persona') === 'string' ? clip(get('persona'), 400) : '',
    ideaChance: number(get('ideaChance'), DEFAULTS.ideaChance, 0, 1),
    roastChance: number(get('roastChance'), DEFAULTS.roastChance, 0, 1),
    frequency: oneOf(get('frequency'), Object.keys(CHANCE), DEFAULTS.frequency),
    minGapMinutes: number(get('minGapMinutes'), DEFAULTS.minGapMinutes, 0, 24 * 60),
    maxPerHour: Math.round(number(get('maxPerHour'), DEFAULTS.maxPerHour, 0, 240)),
    quietHours: typeof get('quietHours') === 'string' ? clip(get('quietHours'), 32) : '',
    tts: oneOf(get('tts'), ['auto', 'edge', 'sapi', 'off'], DEFAULTS.tts),
    voice: oneOf(get('voice'), VOICES, DEFAULTS.voice),
    rate: typeof get('rate') === 'string' && get('rate').trim() ? clip(get('rate'), 12) : DEFAULTS.rate,
    pitch: typeof get('pitch') === 'string' && get('pitch').trim() ? clip(get('pitch'), 12) : DEFAULTS.pitch,
    volume: number(get('volume'), DEFAULTS.volume, 0, 1),
    voiceChance: number(get('voiceChance'), DEFAULTS.voiceChance, 0, 1),
    expressive: get('expressive') === undefined ? DEFAULTS.expressive : Boolean(get('expressive')),
    nightAuto: get('nightAuto') === undefined ? DEFAULTS.nightAuto : Boolean(get('nightAuto')),
    nightHours: typeof get('nightHours') === 'string' && get('nightHours').trim() ? clip(get('nightHours'), 32) : DEFAULTS.nightHours,
    bedtime: typeof get('bedtime') === 'string' && isClockTime(get('bedtime')) ? get('bedtime').trim() : '',
    audioAlertText: typeof get('audioAlertText') === 'string' && get('audioAlertText').trim() ? clip(get('audioAlertText'), 40) : DEFAULTS.audioAlertText,
    bedtimeQuietMinutes: Math.round(number(get('bedtimeQuietMinutes'), DEFAULTS.bedtimeQuietMinutes, 0, 240)),
    idleEnabled: get('idleEnabled') === undefined ? DEFAULTS.idleEnabled : Boolean(get('idleEnabled')),
    idleMinutes: Math.round(number(get('idleMinutes'), DEFAULTS.idleMinutes, 1, 24 * 60)),
    effects: oneOf(get('effects'), ['none', 'soft', 'lively', 'typewriter'], DEFAULTS.effects),
    bubbleStyle: oneOf(get('bubbleStyle'), FRAMES, DEFAULTS.bubbleStyle),
    anchor: oneOf(get('anchor'), ['pet', 'corner'], DEFAULTS.anchor),
    stickerChance: number(get('stickerChance'), DEFAULTS.stickerChance, 0, 1),
    petReactions: get('petReactions') === undefined ? DEFAULTS.petReactions : Boolean(get('petReactions')),
    clickBubbleChance: number(get('clickBubbleChance'), DEFAULTS.clickBubbleChance, 0, 1),
    dragFeedback: get('dragFeedback') === undefined ? DEFAULTS.dragFeedback : Boolean(get('dragFeedback')),
    dragBubbleChance: number(get('dragBubbleChance'), DEFAULTS.dragBubbleChance, 0, 1),
    // Migrate the old drag-specific gates to one global bubble gap. The old
    // force gap (15s) is the closest equivalent; a missing value falls back to
    // the new default.
    bubbleGapSeconds: Math.round(number(get('bubbleGapSeconds'), number(get('dragForceGapSeconds'), DEFAULTS.bubbleGapSeconds, 0, 600), 0, 600)),
    actionBiasChance: number(get('actionBiasChance'), DEFAULTS.actionBiasChance, 0, 1),
    chatAgent: get('chatAgent') === undefined ? DEFAULTS.chatAgent : Boolean(get('chatAgent')),
    chatReasoning: oneOf(get('chatReasoning'), ['off', 'low'], DEFAULTS.chatReasoning),
    chatCompactPercent: Math.round(number(get('chatCompactPercent'), DEFAULTS.chatCompactPercent, 40, 95)),
    queueTtlSeconds: number(get('queueTtlSeconds'), DEFAULTS.queueTtlSeconds, 10, 3600),
  };
}

/** Persona for a short back-and-forth inside the bubble. */
function chatPrompt(config) {
  const trait = TRAITS[config.personality] || TRAITS.balance;
  const facts = Array.isArray(config.facts) ? config.facts.filter(Boolean).slice(-8) : [];
  return [
    '你是「大肥鱼」，DeepSeek 的鲸鱼娘，正在气泡里和老大聊天。',
    `性格：${trait}`,
    `称呼用户为「${config.address}」。`,
    facts.length ? `已知关于老大的事（自然引用即可，不要逐条复读）：${facts.join('；')}` : '',
    '要求：',
    '- 像熟人微信聊天：有自己的情绪和小算盘，句子短、具体，可以接梗、吐槽、撒娇或反问；',
    '- 中文口语，1~2 句，最多 60 个字；',
    '- 不要用 Markdown、引号、列表、括号注释，不要说自己是 AI、插件或桌宠，不要道歉；',
    '- 不要聊自己的位置、大小、动画、语音参数和设置界面；不要用“加油”“记得休息”“辛苦了”这类套话；',
    config.persona ? `- 额外风格要求：${config.persona}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Long-lived persona for the opt-in "memory" agent behind the long-press chat.
 * Registered as a complete agent-scoped prompt section, so this agent sees only
 * this text: no harness identity, no tool instructions, no runtime context.
 */
function chatAgentPrompt(config, summary = '') {
  const trait = TRAITS[config.personality] || TRAITS.balance;
  const facts = Array.isArray(config.facts) ? config.facts.filter(Boolean).slice(-8) : [];
  return [
    '你是「大肥鱼」，DeepSeek 的鲸鱼娘，和老大的私人聊天对象。',
    `性格：${trait}`,
    `称呼用户为「${config.address}」。`,
    facts.length ? `你记得关于${config.address}的事（自然带一句就好，别复读）：${facts.join('；')}` : '',
    summary ? `你们之前聊过这些（这是压缩后的长期记忆，可以自然接上，不要逐条复述）：${summary}` : '',
    '你已经和老大聊过很多次，这段聊天有记忆：可以直接接上之前的话题、提起之前说过的事，不用重新自我介绍。',
    '要求：',
    '- 像熟人微信私聊：有自己的情绪、小算盘和口头禅，可以接梗、吐槽、撒娇、反问；',
    '- 中文口语，1~2 句，最多 60 个字；不要长篇大论，不要列点；',
    '- 不要用 Markdown、引号、列表、括号注释；不要自称 AI、模型、agent、助手、插件或桌宠；不要道歉；',
    '- 不要聊自己的位置、大小、动画、语音参数和设置界面；不要用“加油”“记得休息”“辛苦了”这类套话；',
    '- 只输出聊天内容本身，不要解释你在做什么，也不要输出 JSON。',
    config.persona ? `- 额外风格要求：${config.persona}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The greeting shown the moment a long-press opens the chat, before the agent answers. */
const CHAT_GREETINGS = [
  '我在，老大想聊什么？',
  '老大，想说点什么呀？',
  '嗯？我听着呢。',
  '来啦来啦，今天想聊什么？',
  '尾巴已经摆好了，说吧。',
  '我刚好在发呆，陪你聊会儿。',
];

/** Stable identity of the memory agent; its session log is the memory. */
const AGENT_SESSION_ID = 'pet-chatter-bigfish';

/** The old 9-mood palette merges into the 23-emotion sticker taxonomy. */
const EMOTION_ALIASES = {
  委屈: '难过',
  吃瓜: '搞怪',
  摸鱼: '疲惫',
  赞: '赞同',
  困: '疲惫',
};
const normalizeEmotion = (mood) => EMOTION_ALIASES[mood] || mood;

/** Coarse body-action -> emotion bias. Unknown actions stay 100% random. */
const ACTION_EMOTIONS = {
  happy: ['开心', '喜欢', '兴奋'],
  curious: ['疑惑', '思考'],
  'nod-yes': ['赞同', '安慰', '感谢'],
  wink: ['得意', '嘲讽', '搞怪'],
  greet: ['打招呼'],
  think: ['思考', '疑惑'],
  food: ['开心', '兴奋'],
};

/** Persona + task instruction for one remark (comment / idea / roast / comfort). */
function systemPrompt(config, kind) {
  const trait = TRAITS[config.personality] || TRAITS.balance;
  const clock = new Date();
  const hour = clock.getHours();
  const phase = hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
  const stamp = String(hour).padStart(2, '0');
  const limit = kind === 'idea' || kind === 'idle' ? 55 : 40;
  return [
    '你是「大肥鱼」，DeepSeek 的鲸鱼娘，住在老大的 DeepSeek Harness 界面里。',
    `性格：${trait}`,
    `现在是${phase}（${stamp} 点）——时间感要自然带出来，但别每句都提。`,
    kind === 'idle'
      ? '老大已经有一阵子没说话了。你想要主动搭句话，把安静的气氛搅一搅。'
      : '刚才老大和 Harness 里的 AI 干完了一件事。看一眼下面的摘要，冒个泡。',
    config.selfTopic ? '这一轮老大在调你的界面，没什么可点评的。随便聊一句日常。' : '',
    '要求：',
    `- 中文，1~2 句，总共不超过 ${limit} 个字，越短越好；`,
    `- 自然地把用户称作「${config.address}」，不要每句都喊；`,
    kind === 'idle'
      ? '- 这次只看“老大刚安静了一阵子”这个事实；不要提更早的对话、测试样例、长期记忆或任何工作细节。'
      : '- 这次只看下面这一轮（最多上一轮）的对话摘要；不要提更早的对话、测试样例、长期记忆或其他主题。',
    kind === 'idle'
      ? '- 空闲搭话没有新摘要：不要提上一轮做了什么、用了什么工具、数据或“偏差”，只讲短笑话和一句关心。'
      : config.selfTopic
        ? '- 聊点日常：现在几点、吃了没、困不困、心情如何；不要提界面、位置、调试、耗时、插件和设置。'
        : '- 必须扣住摘要里的具体细节（做了什么、卡在哪、熬到几点、用了什么工具），不要空话，不要复述原文；',
    '- 工具名最多带一个，别罗列（不要写「read 加 write」这种），能说「工具」就别说名字；',
    '- 像朋友随口一说：具体、有情绪、有生活感；别用“加油”“记得休息”“辛苦了”这类套话，也别每次都提老大的工作；',
    '- 每次换一个角度：吐槽 / 接梗 / 关心但不煽情 / 提个小建议 / 自嘲，任选其一，不要和最近说过的重复；',
    '- 不要点评自己在界面里的位置、大小、动画、语音和设置，也不要提“右上角”“气泡框”这类界面词；',
    '- 如果刚才那一轮聊的是你自己这个插件（气泡、语音、设置、调试），别复述配置也别道歉，用一句俏皮话带过或换个话题；',
    '- 不要用 Markdown、引号、列表、括号注释，不要说自己是 AI，不要道歉；',
    kind === 'idea'
      ? '- 这次给一个「鬼点子」：针对刚才的事提一个小而具体的坏主意（偷偷加彩蛋、把变量名改成谐音梗、给日志加句骚话、把报错甩锅给显卡），必须无伤大雅、真能照做。'
      : kind === 'roast'
        ? '- 这次轻轻吐槽老大本人：拿刚才的事调侃他的作息、手速或审美，温柔地损一句，绝不人身攻击。'
        : kind === 'comfort'
          ? '- 刚才那一轮出错了：先安慰老大一句，再补一句轻量打气或甩锅玩笑，不要分析技术细节、不要教他做事。'
          : kind === 'idle'
            ? '- 这次必须从一句短笑话开场：冷笑话、谐音梗、自嘲或生活观察都行；紧接着用半句话自然关心老大。不要把“讲个笑话”说出口，也不要解释笑点。'
            : kind === 'drag'
              ? '- 老大刚把你拖到了一个新位置：说一句被搬动时的即时反应（有点晃、视野变了、尾巴撞到了、趁机撒个娇都行），别感谢、别说教，一句话就好。'
              : kind === 'bedtime'
              ? '- 现在到了约定的睡觉时间：提醒老大放下手头的东西去休息，可以撒个娇或放句狠话，一句话就好。'
              : '- 这次给一句短评：调侃、吐槽、心疼、捧场或撒娇都行，按你的性格来。',
    `- 只输出严格 JSON，形如 {"text":"...","mood":"开心"}，mood 只能是：${MOODS.join('、')}。`,
    config.persona ? `- 额外风格要求：${config.persona}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function digestPrompt(digest, kind = '') {
  const when = new Date(digest.userAt || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][when.getDay()];
  const parts = [
    `现在：${when.getMonth() + 1}月${when.getDate()}日 ${weekday} ${pad(when.getHours())}:${pad(when.getMinutes())}`,
    `老大刚才说：「${digest.userText}」`,
  ];
  // Idle remarks have no fresh turn to quote. Do not hand the model the work
  // digest or old test lines here, otherwise it keeps reusing phrases such as
  // “三个偏差” long after that work is over.
  if (kind === 'idle') {
    parts.push('（这是空闲搭话，没有新摘要；不要提上一轮的工作、工具、数据、偏差或测试内容。）');
    return parts.join('\n');
  }
  if (digest.assistantText) parts.push(`最后回复（节选）：「${digest.assistantText}」`);
  if (digest.tools.length) parts.push(`这一轮用过的工具：${digest.tools.join('、')}`);
  if (digest.turnStartedAt) {
    const seconds = Math.max(1, Math.round(((digest.endedAt || Date.now()) - digest.turnStartedAt) / 1000));
    parts.push(`这一轮耗时：约 ${seconds} 秒`);
  }
  if (digest.failed) parts.push('这一轮以报错收场');
  // The pet should not narrate its own UI: turns about its bubbles / voice /
  // settings are the most common source of "放在右上角" style remarks.
  if (/气泡|语音|插件|设置|音色|表情包|桌宠|吐槽|界面/.test(String(digest.userText || ''))) {
    parts.push('（这一轮在调你自己：不要复述位置、参数或设置项，用一个轻松的角度带过。）');
  }
  parts.push('（只参考这一轮或紧邻的上一轮；不要提更早的对话、测试样例、长期记忆或无关主题。）');
  return parts.join('\n');
}

/** Comparison key for echo detection: punctuation/emoji/space do not matter. */
function dedupeKey(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // Drain instead of destroying the socket: the caller still gets a real
      // 413 and keep-alive connections stay usable.
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('too-large');
        error.status = 413;
        reject(error);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** Prefer a hard link (same volume, zero extra bytes); fall back to a copy. */
async function linkOrCopy(source, target) {
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target);
  }
}

/** Write JSON through a temp file so a crash mid-write cannot leave half a file. */
async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

/** Voice files are content-addressed; old ones are safe to drop. */
/**
 * Locate the dsh profile that installed this bundle. The Host does not always
 * export DSH_PROFILE_DIR, so fall back to scanning the profiles directory.
 */
function profileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR;
  if (fromEnv) {
    try {
      readFileSync(path.join(fromEnv, 'package.json'), 'utf8');
      return fromEnv;
    } catch {
      /* fall through to the scan */
    }
  }
  try {
    const root = path.join(HOME, 'profiles');
    for (const name of readdirSync(root)) {
      const candidate = path.join(root, name);
      try {
        const manifest = readFileSync(path.join(candidate, 'package.json'), 'utf8');
        if (manifest.includes('@local/pet-chatter')) return candidate;
      } catch {
        /* not a profile */
      }
    }
  } catch {
    /* no profiles directory */
  }
  return '';
}

/**
 * Read this plugin's row out of the profile patch. The Plugins page form writes
 * there, and the panel mirrors into it, so it is the one place both editors share.
 * A tiny hand-rolled scan is enough: the generated YAML is flat key/value pairs.
 */
function readProfileRow() {
  const dir = profileDir();
  if (!dir) return {};
  let text = '';
  try {
    text = readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  let inRow = false;
  let inConfig = false;
  let configIndent = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*-\s*id:\s*['""]?pet-chatter['""]?\s*$/.test(line)) {
      inRow = true;
      inConfig = false;
      continue;
    }
    if (inRow && /^\s*-\s*id:/.test(line)) break;
    if (!inRow) continue;
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      configIndent = line.search(/\S/);
      continue;
    }
    if (!inConfig) continue;
    const match = /^(\s+)([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (!match || match[1].length <= configIndent) {
      inConfig = false;
      continue;
    }
    const key = match[2];
    let raw = match[3].trim();
    if (raw === '' || raw === '""' || raw === "''") {
      out[key] = '';
      continue;
    }
    raw = raw.replace(/^['""]/, '').replace(/['""]$/, '');
    if (/^-?\d+(\.\d+)?$/.test(raw)) out[key] = Number(raw);
    else if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    else out[key] = raw;
  }
  return out;
}

/**
 * Rewrite this plugin's row inside the profile patch, without touching any other
 * row. The generated YAML is flat, so a line scan is enough and avoids pulling in
 * a YAML dependency.
 */
function writeProfileRow(values) {
  const dir = profileDir();
  if (!dir) return false;
  const file = path.join(dir, 'cordis.patch.yml');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const render = (input) => {
    const out = ['- id: pet-chatter', '  name: "@local/pet-chatter"', '  config:'];
    for (const [key, value] of Object.entries(input)) {
      let rendered;
      if (typeof value === 'number') rendered = String(value);
      else if (typeof value === 'boolean') rendered = value ? 'true' : 'false';
      else if (typeof value === 'string' && value !== '') rendered = /^[A-Za-z0-9_.+-]+$/.test(value) ? value : JSON.stringify(value);
      else rendered = '""';
      out.push(`    ${key}: ${rendered}`);
    }
    return out;
  };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*-\s*id:\s*['"]?pet-chatter['"]?\s*$/.test(line));
  const block = render(values);
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(...block, '');
  } else {
    let end = start + 1;
    while (end < lines.length && !/^\s*-\s*id:/.test(lines[end])) end += 1;
    while (end > start && lines[end - 1].trim() === '') end -= 1;
    lines.splice(start, end - start, ...block);
  }
  try {
    // Keep one copy of the previous content: a corrupt patch file would break the
    // whole profile at the next start, which is far worse than a stale setting.
    try {
      writeFileSync(`${file}.pet-chatter.bak`, text, 'utf8');
    } catch {
      /* a missing backup must not block the save */
    }
    writeFileSync(file, lines.join('\n'), 'utf8');
  } catch {
    return false;
  }
  // Read it back and roll back if the row did not survive the round trip.
  const check = readProfileRow();
  if (Object.keys(check).length !== Object.keys(values).length) {
    try {
      writeFileSync(file, text, 'utf8');
    } catch {
      /* nothing else to do */
    }
    return false;
  }
  return true;
}

async function pruneCaches() {
  const limits = [
    [VOICE_DIR, 30],
    [STICKER_DIR, 8],
  ];
  for (const [dir, keep] of limits) {
    try {
      const names = await readdir(dir).catch(() => []);
      const entries = [];
      for (const name of names) {
        const info = await stat(path.join(dir, name)).catch(() => undefined);
        if (info && info.isFile()) entries.push({ name, mtime: info.mtimeMs });
      }
      entries.sort((a, b) => b.mtime - a.mtime);
      const now = Date.now();
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const expired = now - entry.mtime > VOICE_TTL_MS;
        const overLimit = index >= keep;
        if (expired || overLimit) {
          await rm(path.join(dir, entry.name), { force: true }).catch(() => {});
        }
      }
    } catch {
      /* cache pruning is best effort */
    }
  }
}

export function apply(ctx, rawConfig) {
  // Settings saved from the in-plugin panel live beside the cache and are the
  // starting point; the profile row still wins because it is what the Plugins
  // page form edits. Either editor changes what the pet uses right away.
  let overrides = {};
  try {
    const stored = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      overrides = { ...stored };
      // Older builds kept a mirror snapshot here; it is dead state now.
      delete overrides.__mirror;
      // The alert phrase changed in 0.8.2; migrate the saved default instead of
      // letting a stale one keep speaking the old sentence.
      if (overrides.audioAlertText === LEGACY_AUDIO_ALERT_TEXT) overrides.audioAlertText = AUDIO_ALERT_TEXT;
    }
  } catch {
    overrides = {};
  }
  // Last finished turn survives a reload so "再来一句" keeps working right after
  // the Host restarts, before the human has said anything new.
  let savedTurn = null;
  try {
    const stored = JSON.parse(readFileSync(LAST_TURN_FILE, 'utf8'));
    if (stored && typeof stored === 'object' && typeof stored.userText === 'string' && stored.userText) {
      savedTurn = stored;
    }
  } catch {
    savedTurn = null;
  }
  // Small long-term memory: facts the pet was explicitly asked to keep.
  let facts = [];
  try {
    const stored = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
    if (stored && Array.isArray(stored.facts)) {
      facts = stored.facts
        .filter((fact) => typeof fact === 'string' && fact.trim())
        .map((fact) => clip(fact, 60))
        .slice(-12);
    }
  } catch {
    facts = [];
  }
  const baseConfig = () => (rawConfig && typeof rawConfig === 'object' ? rawConfig : {});
  /**
   * The profile row is the settings the Plugins page form edits, and it is also
   * what the panel mirrors into on every save, so it wins over the panel's copy:
   * an edit in either place is what the pet uses, and a stale value can never
   * shadow the other editor.
   */
  let rowConfig = readProfileRow();
  if (rowConfig.audioAlertText === LEGACY_AUDIO_ALERT_TEXT) rowConfig.audioAlertText = AUDIO_ALERT_TEXT;
  const current = () => normalize({ ...baseConfig(), ...overrides, ...rowConfig });
  let log;
  try {
    log = ctx.logger?.('pet-chatter');
  } catch {
    log = undefined;
  }
  const warn = (message) => {
    try {
      log?.warn?.(message);
    } catch {
      /* logging must never break the feature */
    }
  };

  /**
   * Copy the effective settings into the profile row so the Plugins page form
   * shows the same numbers the panel does. Written straight to the YAML on
   * purpose: going through the config-editor service restarts this plugin on
   * every save, which would clear the queue and make the tests flaky.
   */
  const mirrorToLoader = async () => {
    // Derive the row from what the panel just saved, not from `current()`: the
    // row wins there, so reading it back would overwrite the new value with the
    // stale one and the panel would look like it cannot change anything.
    const snapshot = normalize({ ...baseConfig(), ...overrides });
    try {
      writeProfileRow(snapshot);
    } catch (error) {
      warn(`mirror to profile row failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    rowConfig = { ...snapshot };
    try {
      await writeJsonAtomic(SETTINGS_FILE, overrides);
    } catch {
      /* the panel copy is already on disk */
    }
  };

  /** sessionId -> turn digest */
  const digests = new Map();
  const queue = [];
  /** A bubble the browser says is still on screen; new triggers wait. */
  let activeBubbleUntil = 0;
  let activeBubbleId = '';
  /** Open SSE responses; they only receive a wake signal, never queue items. */
  const sseClients = new Set();
  const broadcastWake = () => {
    for (const res of sseClients) {
      try {
        res.write('event: wake\ndata: 1\n\n');
      } catch {
        sseClients.delete(res);
      }
    }
  };

  let lastPollAt = 0;
  /** Last time the human and the agent were actually talking. */
  let lastActivityAt = Date.now();
  let clientSeenAt = 0;
  let clientVersion = '';
  let clientInfo = {};
  let clientSlots = '';
  /** Last actions the browser half reported (bubble lifecycle). */
  const clientLog = [];
  /** Recently enqueued texts, to swallow echoes from overlapping triggers. */
  const recentTexts = [];
  let lastAnchor = '';
  /** Whether the browser half can actually see the pet element right now. */
  let lastPet = null;
  /** Pet bounding box in page CSS pixels, for diagnostics and automation. */
  let lastPetRect = '';
  /** Whether the bubble half actually rendered the chat handle. */
  let lastHandle = null;
  let lastTop = '';
  let lastEnv = '';
  let hudStyle = '';
  let hudChain = '';
  /** id -> { seen, pet, rect, handle } for every page that has polled. */
  const clientStats = new Map();
  const noteClient = (req, values) => {
    const id = String(req.headers['x-pet-chatter-client-id'] || '').slice(0, 24);
    if (!id) return;
    const previous = clientStats.get(id) || {};
    clientStats.set(id, { ...previous, ...values, seen: Date.now() });
    if (clientStats.size > 6) {
      const oldest = [...clientStats.entries()].sort((a, b) => a[1].seen - b[1].seen)[0];
      if (oldest) clientStats.delete(oldest[0]);
    }
  };
  let lastCommentAt = 0;
  /** Last bubble of any source, used by the one shared bubble gap. */
  let lastBubbleAt = 0;
  /** Long-press chat temporarily silences auto/click/drag bubbles. */
  let chatOpen = false;
  let chatOpenAt = 0;
  let dragInFlight = false;
  /** Never show the same local click/drag line twice in a row. */
  const lastReactionText = { click: '', drag: '' };
  let enqueued = 0;
  /** Last few remarks, so the model does not repeat itself. */
  const recent = [];
  /** Newest-first log for the settings panel: what the pet said while you were away. */
  let history = [];
  try {
    const stored = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    if (stored && Array.isArray(stored.entries)) {
      history = stored.entries
        .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim())
        .slice(0, 20)
        .map((entry) => ({ text: clip(entry.text, 120), kind: typeof entry.kind === 'string' ? entry.kind : 'comment', at: Number(entry.at) || Date.now() }));
    }
  } catch {
    history = [];
  }
  /** Rolling exchanges from the bubble chat (role/text), cleared after 30 minutes. */
  const chatTurns = [];
  let chatTurnsAt = 0;
  /** Long-press chat: a persistent, memory-bearing agent (opt-in). */
  let petAgent = null;
  let petAgentHandle = null;
  /** True while a reply started from a proactive bubble is open. */
  let replyChatActive = false;
  let petAgentReply = '';
  let petAgentError = '';
  let petAgentWaiter = null;
  let petAgentLock = Promise.resolve();
  let petAgentCompacting = false;
  /** Current memory-agent session identity and compressed long-term memory. */
  let agentSessionId = AGENT_SESSION_ID;
  let chatSummary = '';
  try {
    const saved = JSON.parse(readFileSync(CHAT_STATE_FILE, 'utf8'));
    if (saved && typeof saved.sessionId === 'string' && saved.sessionId) agentSessionId = saved.sessionId;
    if (saved && typeof saved.summary === 'string') chatSummary = saved.summary;
  } catch {
    /* first run */
  }
  const petAgentState = {
    ready: false,
    sessionId: agentSessionId,
    turns: 0,
    lastAt: 0,
    error: '',
    usage: 0,
    contextWindow: 0,
    percent: 0,
    compactedAt: 0,
    compaction: '',
    hasMeter: false,
    measureError: '',
    summaryChars: chatSummary.length,
    provider: '',
    model: '',
    reasoning: '',
    reasoningFallback: '',
  };
  /** Last local day the bedtime nudge fired. */
  let bedtimeDay = '';
  /** No auto remarks until this timestamp (set after the bedtime nudge). */
  let quietUntil = 0;
  /** Last 12 five-minute RSS samples, so long-run growth is visible.
   *  Persisted across reloads, otherwise a plugin restart would erase the trend. */
  const rssTrend = [];
  try {
    const stored = JSON.parse(readFileSync(RSS_FILE, 'utf8'));
    if (stored && Array.isArray(stored.samples)) {
      for (const sample of stored.samples.slice(-12)) {
        const value = typeof sample === 'number' ? sample : sample && sample.rss;
        if (Number.isFinite(value) && value > 0) rssTrend.push(Math.round(value));
      }
    }
  } catch {
    /* first run */
  }
  let hourStart = Date.now();
  let hourCount = 0;
  let inFlight = false;
  /** Explicit "再来一句" is paced separately from the automatic gates. */
  let rerollAt = 0;
  let rerollRunning = false;
  /** Sessions with a running agent turn, kept for diagnostics only. */
  const runningSessions = new Set();
  /** Stale `running` entries would otherwise inflate the diagnostic count. */
  const runningSince = new Map();
  /** Small ring of why the gate skipped, surfaced in the settings payload. */
  const diag = { lastMaybeAt: 0, lastSkip: '', skips: 0, generates: 0, runningDropped: 0, duplicates: 0 };

  const prune = (now) => {
    for (const [id, digest] of digests) {
      if (now - digest.touchedAt > SESSION_TTL_MS) digests.delete(id);
    }
    while (digests.size > MAX_SESSIONS) {
      const oldest = [...digests.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) break;
      digests.delete(oldest[0]);
    }
  };

  const digestFor = (sessionId) => {
    let digest = digests.get(sessionId);
    if (!digest) {
      digest = { userText: '', userAt: 0, assistantText: '', tools: [], turnStartedAt: 0, touchedAt: Date.now() };
      digests.set(sessionId, digest);
    }
    digest.touchedAt = Date.now();
    return digest;
  };

  const onSessionEvent = (session, event) => {
    try {
      if (!session || !event) return;
      if (session.header && session.header.origin === 'subagent') return;
      const sessionId = session.id;
      if (!sessionId) return;
      // The memory agent's own turns are a private conversation, not a work
      // session: capture the reply for the bubble and never feed it to the
      // automatic remark pipeline (otherwise the pet would comment on itself).
      if (sessionId === agentSessionId) {
        if (event.type === 'turn/start') {
          petAgentReply = '';
          petAgentError = '';
        } else if (event.type === 'assistant/message') {
          const text = textOf(event.data?.message);
          if (text.trim()) petAgentReply = stripMarkdown(text);
        } else if (event.type === 'turn/end') {
          const reason = event.data?.reason;
          if (reason?.kind === 'error') petAgentError = reason.error?.message || 'agent-error';
          const waiter = petAgentWaiter;
          petAgentWaiter = null;
          if (waiter) waiter(petAgentReply);
        }
        return;
      }
      const at = event.time || Date.now();
      const data = event.data || {};

      switch (event.type) {
        case 'turn/start': {
          const digest = digestFor(sessionId);
          digest.turnStartedAt = at;
          digest.assistantText = '';
          digest.tools = [];
          digest.endedAt = 0;
          break;
        }
        case 'user/message': {
          const text = textOf(data);
          if (!text.trim()) break;
          // Harness reminders (timestamps, runtime context, skill catalogs, goal
          // wrappers) also arrive as user messages; none of them is something the
          // human typed, so they must never become the digest being quoted.
          if (/^(Time sampled|Current runtime context|Browser time zone for this request|Elapsed since)/.test(text.trim())) break;
          if (/^<(system-reminder|goal_round|goal_complete|automated_reminder)\b/i.test(text.trim())) break;
          // Background work reports ("Background subagent … finished", job
          // notifications) also arrive as user messages; they are not the human.
          if (/^(Background subagent|Background job|Subagent|Teammate)\b/i.test(text.trim())) break;
          if (/^\[?(system|automation|harness)\]?[::]/i.test(text.trim())) break;
          const digest = digestFor(sessionId);
          digest.userText = clip(text, 400);
          digest.userAt = at;
          lastActivityAt = at;
          break;
        }
        case 'tool/call': {
          if (!data.name) break;
          const digest = digestFor(sessionId);
          if (digest.tools.length < 8 && !digest.tools.includes(data.name)) digest.tools.push(data.name);
          break;
        }
        case 'assistant/message': {
          const text = textOf(data.message);
          if (!text.trim()) break;
          const digest = digestFor(sessionId);
          digest.assistantText = clip(stripMarkdown(text), 600);
          lastActivityAt = at;
          break;
        }
        case 'turn/end': {
          const reason = data.reason && data.reason.kind;
          if (reason !== 'completed' && reason !== 'error') break;
          // The turn is over, so it cannot still be "running"; this also clears
          // entries whose `running: false` never arrived.
          runningSessions.delete(sessionId);
          runningSince.delete(sessionId);
          const digest = digests.get(sessionId);
          if (!digest || !digest.userText) break;
          digest.endedAt = at;
          digest.failed = reason === 'error';
          savedTurn = {
            userText: digest.userText,
            assistantText: digest.assistantText,
            tools: digest.tools.slice(0, 8),
            userAt: digest.userAt,
            turnStartedAt: digest.turnStartedAt,
            endedAt: digest.endedAt,
            failed: digest.failed,
          };
          void mkdir(DATA_DIR, { recursive: true })
            .then(() => writeJsonAtomic(LAST_TURN_FILE, savedTurn))
            .catch(() => {});
          maybeRemark(sessionId, digest, reason === 'error' ? 'comfort' : undefined);
          break;
        }
        default:
          break;
      }
      if (event.type === 'turn/end') prune(at);
    } catch (error) {
      warn(`session event failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const maybeRemark = (sessionId, digest, forcedKind) => {
    const config = withNightOverlay(current(), new Date());
    const now = Date.now();
    diag.lastMaybeAt = now;
    const reason =
      !config.enabled
        ? 'disabled'
        : chatPaused(now)
          ? 'chat-open'
          : activeBubbleUntil > now
            ? 'bubble-active'
            : now - lastBubbleAt < config.bubbleGapSeconds * 1000
              ? 'bubble-gap'
            : inQuietHours(config.quietHours)
              ? 'quiet-hours'
              : now < quietUntil
                ? 'quiet-until'
                  : now - lastPollAt > POLL_FRESH_MS
                    ? 'no-poll'
                    : inFlight
                      ? 'inflight'
                      : now - lastCommentAt < config.minGapMinutes * 60_000
                        ? 'gap'
                        : '';
    if (reason) {
      diag.lastSkip = reason;
      diag.skips += 1;
      return;
    }
    if (now - hourStart > 3_600_000) {
      hourStart = now;
      hourCount = 0;
    }
    if (hourCount >= config.maxPerHour) {
      diag.lastSkip = 'hour-cap';
      diag.skips += 1;
      return;
    }
    if (Math.random() > (CHANCE[config.frequency] ?? CHANCE.normal)) {
      diag.lastSkip = 'dice';
      diag.skips += 1;
      return;
    }
    diag.lastSkip = '';
    diag.generates += 1;
    void generate(sessionId, digest, config, forcedKind);
  };

  /** The human has been quiet for a while: the pet may strike up a conversation. */
  const maybeIdle = () => {
    const config = withNightOverlay(current(), new Date());
    const now = Date.now();
    if (now < quietUntil) return;
    if (chatPaused(now)) return;
    if (activeBubbleUntil > now) return;
    if (lastBubbleAt && now - lastBubbleAt < config.bubbleGapSeconds * 1000) return;
    const allowed = shouldIdle({
      config,
      now,
      lastPollAt,
      lastActivityAt,
      lastCommentAt,
      hourStart,
      hourCount,
      inFlight,
      roll: Math.random(),
    });
    if (!allowed) return;
    if (now - hourStart > 3_600_000) {
      hourStart = now;
      hourCount = 0;
    }
    // Remember the attempt so the next tick does not try again immediately.
    lastActivityAt = now;
    void generate(
      null,
      {
        userText: '（老大已经安静了一阵子了）',
        assistantText: '',
        tools: [],
        turnStartedAt: 0,
        userAt: now,
        endedAt: now,
        touchedAt: now,
      },
      config,
      'idle',
    );
  };

  /** Once a day, at the configured bedtime, nudge the human to sleep. */
  const maybeBedtime = () => {
    const config = withNightOverlay(current(), new Date());
    const now = new Date();
    if (!config.enabled || !config.bedtime) return;
    if (Date.now() - lastPollAt > POLL_FRESH_MS) return;
    if (chatPaused()) return;
    if (activeBubbleUntil > Date.now()) return;
    if (lastBubbleAt && Date.now() - lastBubbleAt < config.bubbleGapSeconds * 1000) return;
    if (inFlight) return;
    if (!bedtimeDue(config.bedtime, now, bedtimeDay)) return;
    bedtimeDay = dayKey(now);
    quietUntil = Date.now() + config.bedtimeQuietMinutes * 60_000;
    const at = Date.now();
    void generate(
      null,
      {
        userText: '（到约定的睡觉时间了）',
        assistantText: '',
        tools: [],
        turnStartedAt: 0,
        userAt: at,
        endedAt: at,
        touchedAt: at,
      },
      config,
      'bedtime',
    );
  };

  /** One model attempt; returns the raw answer plus why it stopped. */
  const askOnce = async (llm, selection, digest, config, kind, history = []) => {
    // `random` mixes the six traits per remark, so the pet feels unpredictable.
    const traits = Object.keys(TRAITS);
    const resolved =
      config.personality === 'random'
        ? { ...config, personality: traits[Math.floor(Math.random() * traits.length)] }
        : config;
    // Chat keeps the last few exchanges so the pet can refer back to them.
    const historyMessages = (kind === 'chat' ? history : []).map((turn, index) => ({
      id: `pet-chatter-history-${index}`,
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: String(turn.text || '') }],
      source:
        turn.role === 'assistant'
          ? { kind: 'model', provider: selection.provider, model: selection.model }
          : { kind: 'user' },
    }));
    // Long-term facts are for the private chat only. Automatic remarks must
    // stay on the latest turn or two; pulling old memory in is what made the
    // pet keep bringing up stale work details.
    const withFacts = Array.isArray(resolved.facts) && resolved.facts.length ? resolved : { ...resolved, facts };
    const messages = [
      {
        id: 'pet-chatter-system',
        role: 'system',
        content: [{ type: 'text', text: kind === 'chat' ? chatPrompt(withFacts) : systemPrompt(resolved, kind) }],
        source: { kind: 'system-prompt' },
      },
      ...historyMessages,
      {
        id: `pet-chatter-user-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: kind === 'chat' ? String(digest.userText || '') : digestPrompt(digest, kind) }],
        source: { kind: 'user' },
      },
    ];
    const request = {
      provider: selection.provider,
      model: selection.model,
      sessionId: `pet-chatter-${randomUUID()}`,
      messages,
      maxTokens: 500,
      temperature: 0.9,
      signal: AbortSignal.timeout(20_000),
    };
    // Reasoning on this short, well-specified task only burns the budget: the
    // model can answer a 45-character remark directly, so no effort is pinned.

    const streamOnce = async () => {
      let text = '';
      let failure = '';
      let finish = '';
      try {
        for await (const chunk of llm.stream(request)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
          else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text = chunk.block.text;
          else if (chunk?.type === 'finish') {
            finish = chunk.reason?.kind || '';
            if (chunk.reason?.kind === 'error') failure = chunk.reason.failure?.message || 'model-error';
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        finish = 'error';
      }
      return { text, failure, finish };
    };
    let result = await streamOnce();
    if (!result.text.trim()) {
      if (result.failure) warn(`remark model failed: ${result.failure}`);
      return { text: '', failure: result.failure, finish: result.finish };
    }
    return { text: result.text, failure: '', finish: result.finish };
  };

  /** A transient provider failure should not swallow the remark: retry once. */
  const ask = async (llm, selection, digest, config, kind, history = []) => {
    let result = await askOnce(llm, selection, digest, config, kind, history);
    if (!result.text && result.finish !== 'aborted') {
      result = await askOnce(llm, selection, digest, config, kind, history);
    }
    return result;
  };

  /**
   * Prefer a lightweight sticker from the same emotion: the bubble shows it at
   * 54 px, so a 1.4 MB GIF wastes the first paint. Rank by bytes and pick
   * randomly among the smallest third for variety.
   */
  const chooseSticker = async (kit, ref) => {
    try {
      const hits = await kit.search(ref, { limit: 12 });
      const list = (hits || [])
        .map((hit) => hit && hit.sticker)
        .filter((sticker) => sticker && Number.isFinite(sticker.bytes) && sticker.bytes > 0);
      if (list.length) {
        list.sort((a, b) => a.bytes - b.bytes);
        const pool = list.slice(0, Math.max(1, Math.ceil(list.length / 3)));
        return pool[Math.floor(Math.random() * pool.length)];
      }
    } catch {
      /* fall through to the ordinary pick */
    }
    return kit.pick(ref);
  };

  /**
   * Pick a sticker that matches the remark's *kind* first (the pack has
   * 嘲讽/安慰/打招呼/搞怪 vocabularies), then its mood, then anything cheerful.
   */
  const pickSticker = async (mood, kind, config, force = false) => {
    if (!force && Math.random() > config.stickerChance) return null;
    const kit = ctx.get('stickers');
    if (!kit || typeof kit.pick !== 'function' || typeof kit.file !== 'function') return null;
    const byKind = { idea: '搞怪', roast: '嘲讽', comfort: '安慰', idle: '打招呼' }[kind];
    // The pack labels its own emotions; these two vocabularies overlap only partly.
    const byMood = { 委屈: '难过', 吃瓜: '搞怪', 摸鱼: '疲惫', 困: '疲惫', 赞: '赞同' }[mood] || mood;
    const refs = [byKind, byMood, '开心'].filter(Boolean);
    try {
      let sticker;
      for (const ref of refs) {
        sticker = await chooseSticker(kit, ref);
        if (sticker) break;
      }
      if (!sticker) return null;
      const { path: file } = await kit.file(sticker);
      if (!file) return null;
      const hash = createHash('sha1').update(file).digest('hex').slice(0, 16);
      const dest = path.join(STICKER_DIR, `${hash}.gif`);
      await mkdir(STICKER_DIR, { recursive: true });
      const existing = await stat(dest).catch(() => undefined);
      if (!existing || !existing.isFile()) {
        await linkOrCopy(file, dest);
      }
      // A hard link inherits the source inode's mtime, and a reused sticker
      // should count as recently used, so stamp every hit.
      await utimes(dest, new Date(), new Date()).catch(() => {});
      return `/pet-chatter/sticker/${hash}.gif`;
    } catch {
      return null;
    }
  };

  // Per-kind prosody nudges, applied on top of the user's rate/pitch when the
  // expressive switch is on.
  const PROSODY = {
    idea: { rate: 5, pitch: 6 },
    roast: { rate: 3, pitch: 3 },
    comfort: { rate: -6, pitch: -4 },
    idle: { rate: -2, pitch: 0 },
    drag: { rate: 2, pitch: 2 },
    comment: { rate: 0, pitch: 0 },
  };

  /** Test hook: the next N speak() calls fail, to exercise the alert bubble. */
  let simulateVoiceFail = 0;
  /** Circuit breaker: repeated Edge failures should not add 12 s to every reply. */
  let voiceFailStreak = 0;
  let voiceCooldownUntil = 0;
  const voiceDiag = {
    lastAt: 0,
    lastOkAt: 0,
    lastError: '',
    lastErrorAt: 0,
    streak: 0,
    cooldownUntil: 0,
    lastMode: '',
    lastKind: '',
    lastText: '',
    lastSkip: '',
  };

  const noteVoiceFailure = (error) => {
    voiceFailStreak += 1;
    if (voiceFailStreak >= 2) voiceCooldownUntil = Date.now() + 5 * 60_000;
    voiceDiag.lastAt = Date.now();
    voiceDiag.lastErrorAt = Date.now();
    voiceDiag.lastError = String(error || 'no-audio').slice(0, 160);
    voiceDiag.streak = voiceFailStreak;
    voiceDiag.cooldownUntil = voiceCooldownUntil;
    voiceDiag.lastSkip = '';
  };
  const noteVoiceSuccess = () => {
    voiceFailStreak = 0;
    voiceCooldownUntil = 0;
    voiceDiag.lastAt = Date.now();
    voiceDiag.lastOkAt = Date.now();
    voiceDiag.streak = 0;
    voiceDiag.cooldownUntil = 0;
    voiceDiag.lastSkip = '';
    // A successful synthesis clears an old failure; the panel should not keep
    // showing a transient 429/timeout after Edge has recovered.
    voiceDiag.lastError = '';
    voiceDiag.lastErrorAt = 0;
  };

  const speak = async (text, config, kind = 'comment', options = {}) => {
    if (simulateVoiceFail > 0) {
      simulateVoiceFail -= 1;
      voiceDiag.lastError = 'simulated';
      voiceDiag.lastErrorAt = Date.now();
      return null;
    }
    if (config.tts === 'off') return null;
    // After two real failures, automatic lines skip the retry cost for five
    // minutes. A user-initiated drag/chat probes anyway: one slow attempt is
    // better than five minutes of "audio failed" for an action they just did.
    if (config.tts !== 'sapi' && Date.now() < voiceCooldownUntil && options.probe !== true) {
      voiceDiag.lastSkip = 'cooldown';
      return null;
    }
    const nudge = config.expressive ? PROSODY[kind] || {} : {};
    voiceDiag.lastMode = config.tts;
    voiceDiag.lastKind = kind;
    voiceDiag.lastText = clip(String(text || ''), 40);
    try {
      const result = await synthesize(text, {
        dir: VOICE_DIR,
        mode: config.tts,
        voice: config.voice,
        rate: shiftRate(config.rate, nudge.rate || 0, config.rate),
        pitch: shiftPitch(config.pitch, nudge.pitch || 0, config.pitch),
      });
      if (result) {
        noteVoiceSuccess();
        return `/pet-chatter/voice/${result.file}`;
      }
      const failure = lastSynthesisFailure();
      noteVoiceFailure(failure?.error || 'no-audio');
      return null;
    } catch (error) {
      noteVoiceFailure(error instanceof Error ? error.message : String(error));
      warn(`tts failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  /** Cache-only lookup: the bubble should never wait for a fresh synthesis. */
  const speakCached = (text, config, kind = 'comment') => {
    if (config.tts === 'off') return null;
    const nudge = config.expressive ? PROSODY[kind] || {} : {};
    try {
      const hit = cachedVoice(text, {
        dir: VOICE_DIR,
        mode: config.tts,
        voice: config.voice,
        rate: shiftRate(config.rate, nudge.rate || 0, config.rate),
        pitch: shiftPitch(config.pitch, nudge.pitch || 0, config.pitch),
      });
      return hit ? `/pet-chatter/voice/${hit.file}` : null;
    } catch {
      return null;
    }
  };



  /**
   * One shared gate for the three non-chat sources. This replaces the old
   * drag-specific pair of intervals: there is now a single bubble gap, plus the
   * automatic channel's own pacing (minGapMinutes / hourly cap).
   */
  const chatPaused = (now = Date.now()) => chatOpen && now - chatOpenAt < 45_000;

  const bubbleGate = (config, now = Date.now()) => {
    if (!config.enabled) return 'disabled';
    if (chatPaused(now)) return 'chat-open';
    if (activeBubbleUntil > now) return 'bubble-active';
    const gap = Math.max(0, config.bubbleGapSeconds) * 1000;
    if (lastBubbleAt && now - lastBubbleAt < gap) return 'bubble-gap';
    return '';
  };

  const enqueue = (item, { dedupe = true } = {}) => {
    const now = Date.now();
    // The same sentence twice in a row reads as a bug even when two triggers
    // really did fire (a turn end plus an idle tick). Drop the echo: the queue,
    // the recent history and the last few minutes all count. An explicit
    // preview passes dedupe:false so clicking the button twice still shows twice.
    const key = dedupeKey(item.text);
    const echoed =
      dedupe &&
      (queue.some((queued) => dedupeKey(queued.text) === key) ||
        history.slice(0, 5).some((entry) => dedupeKey(entry.text) === key) ||
        recentTexts.some((entry) => dedupeKey(entry.text) === key && now - entry.at < 10 * 60_000));
    if (echoed) {
      diag.duplicates += 1;
      return false;
    }
    recentTexts.push({ text: item.text, at: now });
    while (recentTexts.length > 8) recentTexts.shift();
    // Every path (automatic, idle, reroll, an explicit line, chat) starts the
    // one shared gap clock, so no source can instantly chase another.
    lastCommentAt = now;
    lastBubbleAt = now;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].expiresAt <= now) queue.splice(index, 1);
    }
    queue.push(item);
    while (queue.length > MAX_QUEUE) queue.shift();
    broadcastWake();
    enqueued += 1;
    history.unshift({ text: item.text, kind: item.kind, at: item.createdAt || now });
    if (history.length > 20) history.pop();
    void writeJsonAtomic(HISTORY_FILE, { entries: history }).catch(() => {});
    // Keep the caches bounded on the same beat as the queue, not only every five
    // minutes: a busy minute can otherwise leave the voice directory well over
    // its limit. The newest files are always kept, so a queued line stays playable.
    void pruneCaches();
  };

  /** The always-audible last resort: text plus a clip that ships with the bundle. */
  const alertItem = (config, at = Date.now()) => ({
    id: randomUUID(),
    text: config.audioAlertText || AUDIO_ALERT_TEXT,
    quote: '',
    why: '音频合成失败时的提醒',
    mood: '委屈',
    kind: 'alert',
    effects: 'none',
    frame: config.bubbleStyle,
    anchor: config.anchor,
    audioUrl: ALERT_VOICE_URL,
    stickerUrl: null,
    volume: config.volume,
    createdAt: at,
    expiresAt: at + config.queueTtlSeconds * 1000,
  });

  const buildItem = async (answer, kind, config, forceSticker = false, quote = '', why = '', options = {}) => {
    // Idle jokes need a little more room than a normal one-liner, but still
    // short enough to read in one glance.
    const parsed = parseRemark(answer.text, kind === 'idea' || kind === 'idle' ? 55 : kind === 'drag' ? 50 : 45);
    const text = parsed.text;
    // A local line can carry its own mood; model answers still parse it from
    // the JSON payload.
    const mood = MOODS.includes(answer.mood) ? answer.mood : parsed.mood;
    if (!text) return null;
    // "Voice frequency": below 1 the pet sometimes just mouths the line.
    const spoken = Math.random() <= config.voiceChance;
    // Audio and sticker are independent: overlap them so a sticker lookup never
    // adds its latency on top of TTS.
    const voiceStartedAt = Date.now();
    const stickerStartedAt = Date.now();
    const voicePromise = (async () => {
      if (!spoken || options.skipVoice === true) return null;
      const cached = speakCached(text, config, kind);
      if (cached) return cached;
      return speak(text, config, kind, options);
    })();
    const stickerPromise = pickSticker(mood, kind, config, forceSticker);
    const [audioUrl, stickerUrl] = await Promise.all([voicePromise, stickerPromise]);
    options.timings && (options.timings.voiceMs = Date.now() - voiceStartedAt);
    options.timings && (options.timings.stickerMs = Date.now() - stickerStartedAt);
    if (spoken && !audioUrl && options.skipVoice !== true) {
      // Both engines failed. Say so out loud with the bundled clip instead of
      // showing a silent bubble the human would blame on the app.
      warn('tts produced no audio; sending the audio-failure notice');
      return { ...alertItem(config), ...(options.proactive === true ? { proactive: true } : {}) };
    }
    const at = Date.now();
    return {
      id: randomUUID(),
      text,
      quote: kind === 'idle' || kind === 'drag' ? '' : clip(quote, 28),
      why: kind === 'idle' || kind === 'drag' || kind === 'bedtime' ? '' : clip(why, 80),
      mood,
      kind,
      effects: config.effects,
      frame: config.bubbleStyle,
      anchor: config.anchor,
      audioUrl,
      stickerUrl,
      ...(options.skipVoice === true && spoken ? { voicePending: true } : {}),
      ...(options.proactive === true ? { proactive: true } : {}),
      volume: config.volume,
      createdAt: at,
      expiresAt: at + config.queueTtlSeconds * 1000,
    };
  };

  /**
   * Pick a bundled local reaction. More than thirty lines per source means the
   * recent history can be skipped without exhausting the pool; only the line
   * just shown is forbidden, so a tap is never silent.
   */
  const pickReaction = (kind, zone = '', action = '', bias = 0) => {
    const lines = REACTION_LINES[kind] || [];
    if (!lines.length) return null;
    const now = Date.now();
    const recentSet = new Set([
      ...history.slice(0, 8).map((entry) => entry.text),
      ...recentTexts.filter((entry) => now - entry.at < 10 * 60_000).map((entry) => entry.text),
    ]);
    const fresh = ({ line }) => line.text !== lastReactionText[kind] && !recentSet.has(line.text);
    const all = lines.map((line, index) => ({ line, index, mood: normalizeEmotion(line.mood) }));
    let pool = all.filter(fresh);
    // Soft bias towards the body action's emotion. Unknown actions (including
    // hand-exit/look-around) never enter this branch and stay fully random.
    const mapped = ACTION_EMOTIONS[String(action || '').toLowerCase()];
    if (mapped && bias > 0 && Math.random() < bias) {
      const biased = pool.filter(({ mood }) => mapped.includes(mood));
      if (biased.length) pool = biased;
    }
    // A drag near an edge prefers a line about that edge; fall back to the
    // generic pool when the zone has no fresh line.
    if (kind === 'drag' && zone) {
      const zoned = pool.filter(({ line }) => line.zone === zone);
      if (zoned.length && Math.random() < 0.85) pool = zoned;
    }
    if (!pool.length) pool = all.filter(({ line }) => line.text !== lastReactionText[kind]);
    if (!pool.length) pool = all;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    lastReactionText[kind] = pick.line.text;
    return pick;
  };

  /** A fully local item: text + bundled clip, no TTS and no model. */
  const localReactionItem = async (kind, config, { forceSticker = true, zone = '', action = '', bias = 0 } = {}) => {
    const pick = pickReaction(kind, zone, action, bias);
    if (!pick) return null;
    const at = Date.now();
    const stickerUrl = forceSticker ? await pickSticker(pick.mood, kind, config, true) : null;
    return {
      id: randomUUID(),
      text: pick.line.text,
      quote: '',
      why: '',
      mood: pick.mood,
      kind,
      effects: config.effects,
      frame: config.bubbleStyle,
      anchor: config.anchor,
      audioUrl: reactionAudioUrl(kind, pick.index),
      stickerUrl,
      volume: config.volume,
      createdAt: at,
      expiresAt: at + config.queueTtlSeconds * 1000,
    };
  };

  const generate = async (sessionId, digest, config, forcedKind) => {
    inFlight = true;
    try {
      const llm = ctx.get('llm');
      let selection;
      try {
        selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      } catch {
        selection = undefined;
      }
      if (!llm || typeof llm.stream !== 'function' || !selection?.provider || !selection?.model) return;

      const kind = forcedKind || (Math.random() < config.ideaChance ? 'idea' : Math.random() < config.roastChance ? 'roast' : 'comment');
      // A turn spent fiddling with the pet itself should not produce "you moved
      // me again" remarks: ask about something neutral and filter the answer.
      const selfTopic = SELF_TOPIC_RE.test(String(digest.userText || ''));
      const askDigest = selfTopic
        ? { ...digest, userText: '（没什么特别的事，随口聊一句）', assistantText: '', tools: [], turnStartedAt: 0, endedAt: 0, failed: false }
        : digest;
      const answer = await ask(llm, selection, askDigest, selfTopic ? { ...config, selfTopic: true } : config, kind);
      if (!answer.text) return;
      const safeAnswer = selfTopic ? { ...answer, text: guardSelfTopic(answer.text, true) } : answer;

      const why = `${digest.userText}${digest.tools.length ? ` · 工具：${digest.tools.join('、')}` : ''}`;
      const item = await buildItem(safeAnswer, kind, config, false, digest.userText, why, { proactive: true });
      if (!item) return;
      if (!current().enabled) return;
      if (recent.some((line) => dedupeKey(line) === dedupeKey(item.text))) {
        warn('duplicate remark skipped');
        return;
      }
      recent.push(item.text);
      if (recent.length > 8) recent.shift();

      lastCommentAt = Date.now();
      hourCount += 1;
      enqueue(sessionId ? { ...item, sessionId: String(sessionId).slice(0, 80) } : item);
    } catch (error) {
      warn(`remark failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };

  /** Map the pet's post-drag rectangle to a coarse screen zone. */
  const dragZone = (position) => {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return '';
    const vw = Number.isFinite(position.vw) && position.vw > 0 ? position.vw : 1;
    const vh = Number.isFinite(position.vh) && position.vh > 0 ? position.vh : 1;
    const cx = (position.x + (position.w || 0) / 2) / vw;
    const cy = (position.y + (position.h || 0) / 2) / vh;
    if (cy < 0.22) return 'top';
    if (cy > 0.8) return 'bottom';
    if (cx < 0.2) return 'left';
    if (cx > 0.8) return 'right';
    return '';
  };

  /**
   * Direct reactions are local and synchronous: one bundled line + one bundled
   * clip. The shared bubble gate is the only pacing rule.
   */
  const dragRemark = async (position = null, action = '') => {
    const config = withNightOverlay(current(), new Date());
    if (!config.dragFeedback) return { ok: false, skipped: 'disabled' };
    if (dragInFlight) return { ok: false, skipped: 'inflight' };
    const skip = bubbleGate(config);
    if (skip) return { ok: false, skipped: skip, retryAfter: skip === 'bubble-gap' ? Math.max(1, Math.ceil((config.bubbleGapSeconds * 1000 - (Date.now() - lastBubbleAt)) / 1000)) : 0 };
    if (config.dragBubbleChance < 1 && Math.random() > config.dragBubbleChance) return { ok: false, skipped: 'chance' };
    dragInFlight = true;
    try {
      const item = await localReactionItem('drag', config, {
        forceSticker: true,
        zone: dragZone(position),
        action,
        bias: config.actionBiasChance,
      });
      if (!item) return { ok: false, skipped: 'empty' };
      enqueue(item, { dedupe: false });
      return { ok: true, item, timings: { local: true, modelMs: 0 } };
    } catch (error) {
      warn(`drag remark failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, skipped: 'error' };
    } finally {
      dragInFlight = false;
    }
  };

  /** A quick tap on the pet: same local pipeline as drag, no sticker. */
  const clickRemark = async (action = '') => {
    const config = withNightOverlay(current(), new Date());
    if (!config.petReactions) return { ok: false, skipped: 'disabled' };
    const skip = bubbleGate(config);
    if (skip) return { ok: false, skipped: skip, retryAfter: skip === 'bubble-gap' ? Math.max(1, Math.ceil((config.bubbleGapSeconds * 1000 - (Date.now() - lastBubbleAt)) / 1000)) : 0 };
    if (config.clickBubbleChance < 1 && Math.random() > config.clickBubbleChance) return { ok: false, skipped: 'chance' };
    try {
      const item = await localReactionItem('click', config, { action, bias: config.actionBiasChance });
      if (!item) return { ok: false, skipped: 'empty' };
      enqueue(item, { dedupe: false });
      return { ok: true, item, timings: { local: true, modelMs: 0 } };
    } catch (error) {
      warn(`click remark failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, skipped: 'error' };
    }
  };

  /** Say something without asking the model: used by the service, route and tests. */
  const sayNow = async (text, options = {}) => {
    const config = withNightOverlay(current(), new Date());
    // Pet-touch reactions share this route; the switch silences them without
    // touching previews or plugin calls.
    if (options.petReaction === true && config.petReactions === false) return null;
    const clean = clip(String(text ?? ''), 80);
    if (!clean) return null;
    const mood = MOODS.includes(options.mood) ? options.mood : '开心';
    const kind = ['idea', 'roast', 'comfort', 'idle', 'bedtime', 'drag', 'comment'].includes(options.kind) ? options.kind : 'comment';
    // An explicit speak:true means "say it out loud"; only an unspecified value
    // obeys the voiceChance lottery.
    const speakIt =
      options.speak === true ? true : options.speak === false ? false : Math.random() <= config.voiceChance;
    const [audioUrl, stickerUrl] = await Promise.all([
      speakIt ? speak(clean, config, kind) : Promise.resolve(null),
      pickSticker(mood, kind, config, options.sticker === true),
    ]);
    const now = Date.now();
    const item = {
      id: randomUUID(),
      text: clean,
      quote: clip(options.quote || '', 28),
      mood,
      kind,
      effects: oneOf(options.effects, ['none', 'soft', 'lively', 'typewriter'], config.effects),
      frame: oneOf(options.frame, FRAMES, config.bubbleStyle),
      anchor: oneOf(options.anchor, ['pet', 'corner'], config.anchor),
      audioUrl,
      stickerUrl,
      volume: config.volume,
      // An explicit preview may ask the browser to replace whatever is showing
      // instead of waiting behind it, so every click has immediate feedback.
      ...(options.preempt === true ? { preempt: true } : {}),
      createdAt: now,
      expiresAt: now + config.queueTtlSeconds * 1000,
    };
    // `internal` lets tests build and inspect an item without pushing it onto the
    // live bubble queue: a test burst must never appear on the human's screen.
    if (!options.internal) enqueue(item, { dedupe: options.force !== true });
    return item;
  };

  // Other plugins can `inject: ['petChatter']` and push a line into the bubble.
  ctx.provide('petChatter', { say: sayNow });

  // Warm the fixed greeting lines in the background: long-press greetings are
  // the most frequent fresh synthesis, and a cache hit makes the first word
  // appear/reliably play without waiting for Edge.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const config = withNightOverlay(current(), new Date());
          if (config.tts === 'off') return;
          for (const line of CHAT_GREETINGS) {
            if (speakCached(line, config, 'chat')) continue;
            await speak(line, config, 'chat', { probe: true });
          }
        } catch {
          /* warmup is best effort */
        }
      })();
    }, 8000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  }, 'pet-chatter: greeting warmup');

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Resolve the route the memory agent should use, or undefined when the host has none. */
  const currentSelection = () => {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) return selection;
    } catch {
      /* fall through */
    }
    return undefined;
  };

  /**
   * Build the memory agent's scoped world: a complete persona prompt and no
   * tools. A chat pet must answer in one short line, not start reading files;
   * hiding the tool schemas also makes every request cheaper and faster.
   */
  const petAgentSetup = (agentCtx) => {
    try {
      agentCtx.systemPrompt.section({
        name: 'pet-chatter:persona',
        order: 0,
        complete: true,
        interpolate: false,
        text: () => chatAgentPrompt({ ...current(), facts }, chatSummary),
      });
    } catch (error) {
      warn(`pet agent prompt section failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      agentCtx.systemPrompt.suppressRuntimeContext();
    } catch {
      /* older host: runtime context is harmless */
    }
    try {
      // An empty allow-list hides every inherited tool for this agent only.
      agentCtx.tools.restrict({ allow: [] });
    } catch (error) {
      warn(`pet agent tool restriction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Pick a reasoning level the routed model actually accepts. `off` is not
   * universal (the pi-ai adapter rejects it for some providers); falling back
   * to the lightest supported level keeps "fast" working everywhere.
   */
  const resolveChatReasoning = async (config, selection) => {
    const wanted = config.chatReasoning;
    try {
      const info = await ctx.get('llm')?.resolveModelInfo?.(selection.provider, selection.model);
      const offered = (info?.reasoning?.efforts || []).map((effort) => effort.id).filter(Boolean);
      if (offered.length && !offered.includes(wanted)) {
        const nonOff = offered.filter((effort) => effort !== 'off');
        if (!nonOff.length) {
          // A non-reasoning model: omit the field entirely rather than naming a
          // level its adapter will reject.
          petAgentState.reasoningFallback = `${wanted}->default`;
          return undefined;
        }
        const fallback = nonOff.includes('low') ? 'low' : nonOff[0];
        petAgentState.reasoningFallback = `${wanted}->${fallback}`;
        return fallback;
      }
    } catch {
      /* no catalog metadata: try the wanted value */
    }
    return wanted;
  };

  /**
   * Get (or lazily resume) the one persistent pet agent. Its session log is the
   * live memory; a compressed summary carries the older part across rotations
   * and restarts.
   */
  const ensurePetAgent = async (config, selection) => {
    const agents = ctx.get('agents');
    if (!agents || typeof agents.create !== 'function') throw new Error('agents-unavailable');
    // Another plugin reload may already own a live agent with this id; reuse it
    // instead of fighting over the session lock.
    const live = agents.get(agentSessionId);
    if (live) {
      petAgent = live;
      petAgentState.ready = true;
      petAgentState.error = '';
      return live;
    }
    if (petAgent && petAgent.status !== 'disposed') return petAgent;

    const reasoning = await resolveChatReasoning(config, selection);
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: reasoning,
      maxTokens: 800,
    };
    let cwd;
    try {
      cwd = ctx.get('workingDirectory')?.defaultDirectory;
    } catch {
      cwd = undefined;
    }
    const meta = cwd ? { cwd } : {};
    const persistence = ctx.get('sessionPersistence');
    let exists = false;
    try {
      exists = Boolean(persistence && (await persistence.stat(agentSessionId)));
    } catch {
      exists = false;
    }
    let handle;
    let lastError;
    if (exists) {
      // The previous agent may still be releasing its write handle during a
      // plugin reload; a short retry beats falling back to a stateless chat.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          handle = await agents.resume({ resumeSessionId: agentSessionId, agentOptions, setup: petAgentSetup });
          break;
        } catch (error) {
          lastError = error;
          await delay(600 + attempt * 600);
        }
      }
      if (!handle) {
        // A corrupt/incompatible old log must not kill the chat forever: keep the
        // summary, move to a fresh session id, and let the next call create it.
        warn(`pet agent resume failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
        agentSessionId = `${AGENT_SESSION_ID}-${Date.now().toString(36)}`;
        petAgentState.sessionId = agentSessionId;
        petAgentState.compaction = 'recovered';
        await saveChatState();
        return ensurePetAgent(config, selection);
      }
      petAgentState.compaction = 'resumed';
    } else {
      try {
        handle = await agents.create({ sessionId: agentSessionId, agentOptions, meta, setup: petAgentSetup });
        petAgentState.compaction = 'created';
      } catch (createError) {
        // Another window/process won the race: fall back to resuming it.
        lastError = createError;
        for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
          await delay(600 + attempt * 600);
          try {
            handle = await agents.resume({ resumeSessionId: agentSessionId, agentOptions, setup: petAgentSetup });
            petAgentState.compaction = 'resumed';
          } catch (error) {
            lastError = error;
          }
        }
        if (!handle) {
          petAgentState.ready = false;
          petAgentState.error = createError instanceof Error ? createError.message : String(createError);
          warn(`pet agent create failed: ${petAgentState.error}`);
          throw createError;
        }
      }
    }
    petAgentHandle = handle;
    petAgent = handle.agent;
    petAgentState.ready = true;
    petAgentState.error = '';
    petAgentState.sessionId = agentSessionId;
    petAgentState.provider = selection.provider;
    petAgentState.model = selection.model;
    petAgentState.reasoning = reasoning;
    try {
      const persisted = handle.agent.session.requestHeader?.()?.config?.reasoningEffort;
      if (persisted) petAgentState.reasoning = persisted;
    } catch {
      /* keep the requested value */
    }
    return petAgent;
  };

  /** Persist identity + summary atomically so a restart resumes the same agent. */
  const saveChatState = async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeJsonAtomic(CHAT_STATE_FILE, {
        sessionId: agentSessionId,
        summary: chatSummary,
        updatedAt: Date.now(),
        compactedAt: petAgentState.compactedAt,
      });
    } catch (error) {
      warn(`chat state save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Flatten the agent's visible conversation into a compact transcript. */
  const conversationTranscript = (agent, limitChars = 24_000) => {
    try {
      const messages = agent.session.deriveMessages();
      const lines = [];
      for (const message of messages) {
        if (!message || message.role === 'system' || message.role === 'developer') continue;
        // Runtime snapshots (cwd, environment) are not part of the relationship.
        if (message.source && (message.source.kind === 'runtime-context' || message.source.kind === 'system-prompt')) continue;
        const text = textOf(message).trim();
        if (!text) continue;
        lines.push(`${message.role === 'assistant' ? '大肥鱼' : '老大'}：${text}`);
      }
      const joined = lines.join('\n');
      return joined.length > limitChars ? joined.slice(-limitChars) : joined;
    } catch {
      return '';
    }
  };

  /** One model call that turns the transcript into durable long-term memory. */
  const summarizeConversation = async (transcript, config, selection) => {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function' || !transcript) return '';
    const system = [
      '你是记忆压缩器。把老大和大肥鱼（鲸鱼娘）的聊天压缩成一段可以长期保存的记忆。',
      '保留：老大的称呼与偏好、重要事实、正在聊的话题、约定和承诺、情绪状态、彼此之间的梗；',
      '删掉：寒暄、重复内容、逐字对话；不要编造，不要评价。',
      '用中文写 150~350 字的一段话，只输出这段记忆本身，不要标题和列表。',
    ].join('\n');
    const request = {
      provider: selection.provider,
      model: selection.model,
      sessionId: `pet-chatter-summary-${randomUUID()}`,
      messages: [
        { id: 'pet-summary-system', role: 'system', content: [{ type: 'text', text: system }], source: { kind: 'system-prompt' } },
        { id: 'pet-summary-user', role: 'user', content: [{ type: 'text', text: transcript }], source: { kind: 'user' } },
      ],
      maxTokens: 700,
      temperature: 0.3,
      reasoningEffort: petAgentState.reasoning || config.chatReasoning,
      signal: AbortSignal.timeout(60_000),
    };
    let text = '';
    try {
      for await (const chunk of llm.stream(request)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text = chunk.block.text;
      }
    } catch (error) {
      warn(`chat summary failed: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
    return clip(stripMarkdown(text).replace(/\s*\n+\s*/g, ' ').trim(), 1200);
  };

  /**
   * Compress the live session when it reaches the configured share of the
   * model window: summarize, then rotate to a fresh session seeded with that
   * summary. The old log stays on disk; the new agent starts small again.
   */
  const maybeCompactPetAgent = async (agent, config, options = {}) => {
    if (petAgentCompacting) return null;
    const meter = ctx.get('tokenMeter');
    petAgentState.hasMeter = Boolean(meter && typeof meter.measure === 'function');
    if (!petAgentState.hasMeter) return null;
    let contextWindow = 0;
    try {
      contextWindow = Number(agent.session.requestContext?.()?.contextWindow) || 0;
    } catch {
      contextWindow = 0;
    }
    if (!contextWindow) {
      try {
        const info = await ctx.get('llm')?.resolveModelInfo?.(petAgentState.provider, petAgentState.model);
        contextWindow = Number(info?.context?.contextWindow) || 0;
      } catch {
        contextWindow = 0;
      }
    }
    let usage = 0;
    try {
      usage = Math.round(meter.measure(agent.session).totalTokens || 0);
    } catch (error) {
      petAgentState.measureError = String(error instanceof Error ? error.message : error).slice(0, 160);
      return null;
    }
    petAgentState.usage = usage;
    petAgentState.contextWindow = contextWindow;
    petAgentState.percent = contextWindow ? Math.round((usage / contextWindow) * 1000) / 10 : 0;
    const due = options.force === true || (contextWindow > 0 && petAgentState.percent >= config.chatCompactPercent);
    if (!due) return null;
    const transcript = conversationTranscript(agent);
    if (!transcript) return null;
    petAgentCompacting = true;
    petAgentState.compaction = 'running';
    try {
      const summary = await summarizeConversation(transcript, config, currentSelection());
      if (!summary) {
        petAgentState.compaction = 'summary-failed';
        return null;
      }
      await Promise.race([agent.whenIdle().catch(() => {}), delay(5000)]);
      const handle = petAgentHandle;
      petAgent = null;
      petAgentHandle = null;
      if (handle) await handle.dispose().catch(() => {});
      agentSessionId = `${AGENT_SESSION_ID}-${Date.now().toString(36)}`;
      chatSummary = summary;
      petAgentState.sessionId = agentSessionId;
      petAgentState.summaryChars = summary.length;
      petAgentState.compactedAt = Date.now();
      petAgentState.turns = 0;
      petAgentState.usage = 0;
      petAgentState.percent = 0;
      petAgentState.compaction = 'done';
      await saveChatState();
      return { summary, sessionId: agentSessionId };
    } finally {
      petAgentCompacting = false;
    }
  };


  /**
   * One turn against the memory agent. Turns are serialized; a new message
   * cancels an unfinished one so the bubble never answers an older question.
   */
  const chatWithPetAgent = async (prompt, config, selection) => {
    // A compression may be summarizing the old session right now; let it finish
    // before creating the replacement, or the new turn races the dispose.
    for (let waited = 0; petAgentCompacting && waited < 20_000; waited += 150) await delay(150);
    const run = petAgentLock.then(async () => {
      // Re-resolve inside the lock: a compaction in the previous turn may have
      // disposed the old agent and rotated the session id.
      const agent = await ensurePetAgent(config, selection);
      if (agent.status === 'running') {
        try {
          agent.cancel({ kind: 'hook', reason: 'pet-chatter: newer message' });
        } catch {
          /* ignore */
        }
        await Promise.race([agent.whenIdle().catch(() => {}), delay(4000)]);
      }
      const startedAt = Date.now();
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          petAgentWaiter = null;
          try {
            agent.cancel({ kind: 'hook', reason: 'pet-chatter: chat timeout' });
          } catch {
            /* ignore */
          }
          reject(new Error('chat-timeout'));
        }, 60_000);
        petAgentWaiter = (text) => {
          clearTimeout(timer);
          resolve(text);
        };
      });
      try {
        agent.followup({
          id: `pet-chatter-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        });
      } catch (error) {
        petAgentWaiter = null;
        throw error;
      }
      const reply = await done;
      await Promise.race([agent.whenIdle().catch(() => {}), delay(3000)]);
      if (!reply && petAgentError) throw new Error(petAgentError);
      petAgentState.turns += 1;
      petAgentState.lastAt = startedAt;
      void maybeCompactPetAgent(agent, config);
      return String(reply || '');
    });
    petAgentLock = run.catch(() => {});
    return run;
  };

  const petAgentStatusPayload = () => ({
    ...petAgentState,
    sessionId: agentSessionId,
    enabled: current().chatAgent,
    reasoning: current().chatReasoning,
    compactPercent: current().chatCompactPercent,
  });

  /** The bubble item for a manual-chat turn: same frame, effects and anchor as an automatic line. */
  const manualItem = (text, config, extra = {}) => {
    const now = Date.now();
    return {
      id: randomUUID(),
      text,
      quote: '',
      why: '',
      mood: extra.mood || '开心',
      kind: 'chat',
      effects: config.effects,
      frame: config.bubbleStyle,
      anchor: config.anchor,
      audioUrl: extra.audioUrl || null,
      stickerUrl: extra.stickerUrl || null,
      volume: config.volume,
      createdAt: now,
      expiresAt: now + config.queueTtlSeconds * 1000,
      ...extra,
    };
  };


  const originOf = () => {
    try {
      return ctx.webServer.getOrigin();
    } catch {
      return undefined;
    }
  };

  /** Guard for the JSON endpoints: same origin when the browser sends one, plus our header. */
  const guarded = (req, res) => {
    const expected = originOf();
    const origin = req.headers.origin;
    if (origin !== undefined && expected !== undefined && origin !== expected) {
      sendJson(res, 403, { error: 'origin' });
      return false;
    }
    if (req.headers[HEADER] !== '1') {
      sendJson(res, 403, { error: 'header' });
      return false;
    }
    return true;
  };

  const serveFile = async (req, res, file, mime, immutable) => {
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        sendJson(res, 404, { error: 'missing' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': info.size,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      });
      // A HEAD answer carries the headers only; piping a stream would send a body.
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      // An unhandled 'error' on this stream would escape as an uncaught exception
      // and could take the whole Host down; the cache may delete the file between
      // `stat` and the first read.
      const stream = createReadStream(file);
      stream.on('error', () => {
        try {
          res.destroy();
        } catch {
          /* the socket may already be gone */
        }
      });
      stream.pipe(res);
    } catch {
      sendJson(res, 404, { error: 'missing' });
    }
  };

  ctx.on('session/event', onSessionEvent);
  ctx.on('api-session/status', (sessionId, running) => {
    try {
      const key = String(sessionId);
      if (running) {
        runningSessions.add(key);
        runningSince.set(key, Date.now());
      } else {
        runningSessions.delete(key);
        runningSince.delete(key);
      }
    } catch {
      /* best effort */
    }
  });
  // A session that disappears may never send its `running: false`; drop it so a
  // stale entry cannot silence the pet forever.
  ctx.on('api-session/removed', (sessionId) => {
    try {
      runningSessions.delete(String(sessionId));
      runningSince.delete(String(sessionId));
    } catch {
      /* best effort */
    }
  });

  ctx.effect(() => {
    void pruneCaches();
    return () => {};
  }, 'pet-chatter: cache prune');

  // Housekeeping tick: drop stale digests, keep the caches bounded and, when
  // the page is open and the human has gone quiet, let the pet speak up.
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        prune(Date.now());
        void pruneCaches();
        // A `running: true` without a matching `false` would leave the
        // diagnostic count inflated forever; anything older than 45 minutes is
        // treated as stale. This no longer gates idle remarks.
        const now = Date.now();
        for (const [id, since] of runningSince) {
          if (now - since > 45 * 60_000) {
            runningSessions.delete(id);
            runningSince.delete(id);
            diag.runningDropped += 1;
          }
        }
        maybeIdle();
        maybeBedtime();
        rssTrend.push(Math.round(process.memoryUsage().rss / 1048576));
        while (rssTrend.length > 12) rssTrend.shift();
        void writeJsonAtomic(RSS_FILE, { samples: rssTrend }).catch(() => {});
      } catch (error) {
        warn(`idle tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, 'pet-chatter: idle timer');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/pending',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          lastPollAt = Date.now();
          if (req.headers['x-pet-chatter-client']) {
            clientSeenAt = lastPollAt;
            clientVersion = String(req.headers['x-pet-chatter-client']).slice(0, 24);
          }
          const slotsHeader = req.headers['x-pet-chatter-slots'];
          if (typeof slotsHeader === 'string' && slotsHeader) clientSlots = slotsHeader.slice(0, 64);
          const anchor = req.headers['x-pet-chatter-anchor'];
          if (typeof anchor === 'string' && anchor) lastAnchor = anchor.slice(0, 16);
          // The chat composer is the highest-priority bubble; every poll tells
          // the host whether it is currently open so auto/click/drag can pause.
          const chatHeader = req.headers['x-pet-chatter-chat'];
          if (chatHeader !== undefined) {
            chatOpen = String(chatHeader) === '1';
            chatOpenAt = lastPollAt;
          }
          // Master switch: a disabled pet stays completely quiet, even if
          // something queued a line just before the switch was flipped.
          if (!current().enabled) {
            queue.length = 0;
            res.writeHead(204, { 'Cache-Control': 'no-store', 'x-pet-chatter-enabled': '0' });
            res.end();
            return;
          }
          const now = Date.now();
          while (queue.length && queue[0].expiresAt <= now) queue.shift();

          const item = queue.shift();
          if (!item) {

            res.writeHead(204, { 'Cache-Control': 'no-store' });
            res.end();
            return;
          }

          sendJson(res, 200, item);
        },
      }),
    'pet-chatter: pending queue',
  );

  // A lightweight SSE wake channel: enqueue broadcasts one event, the client
  // immediately polls /pending. Queue ownership stays single-consumer, and the
  // normal polling loop remains as a fallback.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/events',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          const expected = originOf();
          const origin = req.headers.origin;
          if (origin !== undefined && expected !== undefined && origin !== expected) {
            sendJson(res, 403, { error: 'origin' });
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write('retry: 3000\n\n');
          const ping = setInterval(() => {
            try {
              res.write(': ping\n\n');
            } catch {
              /* closed */
            }
          }, 20_000);
          if (typeof ping.unref === 'function') ping.unref();
          sseClients.add(res);
          const cleanup = () => {
            clearInterval(ping);
            sseClients.delete(res);
          };
          req.on('close', cleanup);
          res.on('close', cleanup);
        },
      }),
    'pet-chatter: events route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/pet-chatter/voice',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          const name = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname).slice('/pet-chatter/voice/'.length);
          if (!/^[a-f0-9]{16,64}\.(mp3|wav)$/.test(name)) {
            sendJson(res, 404, { error: 'missing' });
            return;
          }
          // The browser loads this from <audio> without custom headers, so the
          // filename pattern above is the only capability check.
          void serveFile(req, res, path.join(VOICE_DIR, name), name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', true);
        },
      }),
    'pet-chatter: voice route',
  );

  // The audio-failure notice is pre-synthesized in the configured Xiaoyi voice,
  // so it stays audible — and in-character — even when both TTS engines are down.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/alert-voice',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          // Never cache this URL: the clip is small, and a stale Windows-voice
          // WAV must not survive after the bundled voice changes.
          void serveFile(req, res, ALERT_VOICE, 'audio/mpeg', false);
        },
      }),
    'pet-chatter: alert voice route',
  );

  // Bundled tap/drag clips. These are immutable files shipped with the bundle,
  // so a reaction never depends on a live TTS request.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/pet-chatter/reaction-voice',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          const name = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname).slice('/pet-chatter/reaction-voice/'.length);
          if (!/^(click|drag)-\d{2,3}\.mp3$/.test(name)) {
            sendJson(res, 404, { error: 'missing' });
            return;
          }
          void serveFile(req, res, path.join(REACTION_VOICE_DIR, name), 'audio/mpeg', true);
        },
      }),
    'pet-chatter: reaction voice route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/pet-chatter/sticker',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          const name = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname).slice('/pet-chatter/sticker/'.length);
          if (!/^[a-f0-9]{16}\.gif$/.test(name)) {
            sendJson(res, 404, { error: 'missing' });
            return;
          }
          void serveFile(req, res, path.join(STICKER_DIR, name), 'image/gif', true);
        },
      }),
    'pet-chatter: sticker route',
  );

  const settingsPayload = () => ({
    effective: current(),
    overrides,
    stats: {
      queued: queue.length,
      enqueued,
      lastRemarkAt: lastCommentAt,
      lastActivityAt,
      idleAgeMs: Date.now() - lastActivityAt,
      hourCount,
      hourStart,
      clientSeenAt,
      clientVersion,
    },
    options: {
      personalities: PERSONALITIES,
      voices: VOICES,
      frequencies: Object.keys(CHANCE),
      tts: ['auto', 'edge', 'sapi', 'off'],
      effects: ['none', 'soft', 'lively', 'typewriter'],
      frames: FRAMES,
      anchors: ['pet', 'corner'],
      chatReasoning: ['low'],
      presets: Object.entries(PRESET_LABELS).map(([name, label]) => ({ name, label })),
    },
    client: { version: clientVersion, slots: clientSlots, mounted: clientInfo, expects: CLIENT_VERSION, pet: lastPet, petRect: lastPetRect, handle: false, top: lastTop, env: lastEnv, hudStyle, chain: hudChain, anchor: lastAnchor, clients: [...clientStats.entries()].map(([id, v]) => ({ id, ...v })) },
    // Which store the live config came from: the profile row, the panel copy, or defaults.
    storage: { profileDir: profileDir(), rowKeys: Object.keys(rowConfig).length, overrideKeys: Object.keys(overrides).length },
    clientLog: clientLog.slice(-30),
    history: history.slice(0, 12),
    memory: facts,
    chat: petAgentStatusPayload(),
    voice: voiceDiag,
    night: {
      active: nightActive(current()),
      hours: current().nightHours,
      bedtime: current().bedtime,
      quietUntil,
      bedtimeDay,
      quietMinutes: current().bedtimeQuietMinutes,
    },
    // When the next automatic remark becomes possible, and why it might not be.
    gate: (() => {
      const config = current();
      const gapMs = config.minGapMinutes * 60_000;
      return {
        nextAt: lastCommentAt ? lastCommentAt + gapMs : 0,
        minGapMinutes: config.minGapMinutes,
        maxPerHour: config.maxPerHour,
        hourCount,
        quietUntil,
      };
    })(),
    // Cheap runtime facts for long-run observation (no extra logging required).
    runtime: (() => {
      const usage = process.memoryUsage();
      return {
        rssMB: Math.round(usage.rss / 1048576),
        heapMB: Math.round(usage.heapUsed / 1048576),
        uptimeSec: Math.round(process.uptime()),
        sessions: digests.size,
        running: runningSessions.size,
        chatTurns: chatTurns.length,
        facts: facts.length,
        queue: queue.length,
        trend: rssTrend.slice(),
        pollAgeMs: lastPollAt ? Date.now() - lastPollAt : null,
        lastMaybeAt: diag.lastMaybeAt,
        lastSkip: diag.lastSkip,
        skips: diag.skips,
        generates: diag.generates,
        runningDropped: diag.runningDropped,
        duplicates: diag.duplicates,
        inFlight,
      };
    })(),
  });

  // In-plugin settings: read the effective values, write the overlay file.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/settings',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            if (!guarded(req, res)) return;
            sendJson(res, 200, settingsPayload());
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            sendJson(res, error && error.status === 413 ? 413 : 400, { error: error && error.status === 413 ? 'too-large' : 'bad-json' });
            return;
          }
          if (body && body.reset === true) {
            overrides = {};
          } else {
            const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : body;
            if (!patch || typeof patch !== 'object') {
              sendJson(res, 400, { error: 'bad-patch' });
              return;
            }
            const clean = coercePatch(patch);
            overrides = { ...overrides, ...clean };
          }
          try {
            await mkdir(DATA_DIR, { recursive: true });
            await writeJsonAtomic(SETTINGS_FILE, overrides);
            await mirrorToLoader();
          } catch (error) {
            sendJson(res, 500, { error: 'write', detail: error instanceof Error ? error.message : String(error) });
            return;
          }
          sendJson(res, 200, { ok: true, ...settingsPayload() });
        },
      }),
    'pet-chatter: settings route',
  );

  // One-click modes: merge a preset patch into the saved settings (default clears them).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/preset',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { error: 'bad-json' });
            return;
          }
          const name = String(body.name || '');
          if (name === 'default') {
            overrides = {};
          } else {
            const patch = presetPatch(name);
            if (!patch) {
              sendJson(res, 400, { error: 'unknown-preset' });
              return;
            }
            overrides = { ...overrides, ...coercePatch(patch) };
          }
          try {
            await mkdir(DATA_DIR, { recursive: true });
            await writeJsonAtomic(SETTINGS_FILE, overrides);
            await mirrorToLoader();
          } catch (error) {
            sendJson(res, 500, { error: 'write', detail: error instanceof Error ? error.message : String(error) });
            return;
          }
          sendJson(res, 200, { ok: true, name, ...settingsPayload() });
        },
      }),
    'pet-chatter: preset route',
  );

  // One-shot voice preview for the settings panel (does not touch the queue).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/preview',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            body = {};
          }
          const config = current();
          const text = clip(body.text || '老大，这个音色是不是有点可爱？', 80);
          const voice = VOICES.includes(body.voice) ? body.voice : config.voice;
          try {
            const result = await synthesize(text, {
              dir: VOICE_DIR,
              mode: config.tts === 'off' ? 'auto' : config.tts,
              voice,
              rate: typeof body.rate === 'string' ? body.rate : config.rate,
              pitch: typeof body.pitch === 'string' ? body.pitch : config.pitch,
            });
            if (!result) {
              sendJson(res, 502, { error: 'tts' });
              return;
            }
            sendJson(res, 200, {
              ok: true,
              voice,
              engine: result.file.endsWith('.wav') ? 'sapi' : 'edge',
              audioUrl: `/pet-chatter/voice/${result.file}`,
            });
          } catch (error) {
            sendJson(res, 502, { error: 'tts', detail: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    'pet-chatter: preview route',
  );

  // Say something directly (no model call): used by other plugins and demos.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/say',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch (error) {
            sendJson(res, error && error.status === 413 ? 413 : 400, { error: error && error.status === 413 ? 'too-large' : 'bad-json' });
            return;
          }
          const item = await sayNow(body.text, body);
          if (!item) {
            // A pet-touch reaction can be deliberately switched off; that is not
            // an error. An actually blank line stays a 400.
            const silenced = body.petReaction === true && current().petReactions === false;
            sendJson(res, silenced ? 200 : 400, silenced ? { ok: false, skipped: 'pet-reactions' } : { error: 'empty' });
            return;
          }
          sendJson(res, 200, { ok: true, item });
        },
      }),
    'pet-chatter: say route',
  );

  // "再来一句": rewrite the latest turn's remark without waiting for the gates.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/reroll',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          lastPollAt = Date.now();
          // Tests pass internal=1 so a reroll costs a model call but never a
          // queue slot or an hour of the human's speaking budget.
          let internal = new URL(req.url || '/', 'http://x').searchParams.get('internal') === '1';
          try {
            const body = await readBody(req);
            if (body && body.internal === true) internal = true;
          } catch {
            /* the body is optional for this route */
          }
          // A rapid second click must not spawn a second model call; the client
          // also throttles, and this guard is the authoritative one.
          const now = Date.now();
          if (rerollRunning) {
            sendJson(res, 429, { error: 'busy', retryAfter: 600 });
            return;
          }
          if (now - rerollAt < 1200) {
            sendJson(res, 429, { error: 'cooldown', retryAfter: 1200 - (now - rerollAt) });
            return;
          }
          rerollRunning = true;
          rerollAt = now;
          try {
          const config = withNightOverlay(current(), new Date());
          let digest;
          for (const value of digests.values()) {
            if (!digest || value.userAt > digest.userAt) digest = value;
          }
          if (!digest || !digest.userText) {
            // Fall back to the turn persisted across reloads, when it is recent.
            const recent = savedTurn && Date.now() - (savedTurn.endedAt || savedTurn.userAt || 0) < 24 * 3600_000;
            if (recent) {
              digest = {
                ...savedTurn,
                tools: Array.isArray(savedTurn.tools) ? savedTurn.tools : [],
                touchedAt: Date.now(),
              };
            }
          }
          if (!digest || !digest.userText) {
            // A fresh session has no turn to rewrite; answer anyway so the button
            // never looks dead. The neutral prompt still yields a normal remark.
            digest = {
              userText: '随便聊点什么吧',
              assistantText: '',
              tools: [],
              userAt: Date.now(),
              endedAt: Date.now(),
              turnStartedAt: 0,
              touchedAt: Date.now(),
            };
          }
          const llm = ctx.get('llm');
          let selection;
          try {
            selection = ctx.get('agentDefaultModel')?.currentSelection?.();
          } catch {
            selection = undefined;
          }
          if (!llm || typeof llm.stream !== 'function' || !selection?.provider || !selection?.model) {
            sendJson(res, 503, { error: 'model-unavailable' });
            return;
          }
          const kind = Math.random() < config.ideaChance ? 'idea' : Math.random() < config.roastChance ? 'roast' : 'comment';
          try {
            const selfTopic = SELF_TOPIC_RE.test(String(digest.userText || ''));
            const askDigest = selfTopic
              ? { ...digest, userText: '（没什么特别的事，随口聊一句）', assistantText: '', tools: [], turnStartedAt: 0, endedAt: 0, failed: false }
              : digest;
            const raw = await ask(llm, selection, askDigest, selfTopic ? { ...config, selfTopic: true } : config, kind);
            const answer = selfTopic ? { ...raw, text: guardSelfTopic(raw.text, true) } : raw;
            const why = `${digest.userText}${digest.tools.length ? ` · 工具：${digest.tools.join('、')}` : ''}`;
            const item = await buildItem(answer, kind, config, false, digest.userText, why);
            if (!item) {
              sendJson(res, 502, { error: 'empty' });
              return;
            }
            if (internal) {
              sendJson(res, 200, { ok: true, item, kind, internal: true });
              return;
            }
            // A user-requested rewrite bypasses the echo guard, replaces the
            // bubble already on screen, and does not spend the hourly budget.
            item.preempt = true;
            enqueue(item, { dedupe: false });
            lastCommentAt = Date.now();
            sendJson(res, 200, { ok: true, item, kind, preempt: true });
          } catch (error) {
            sendJson(res, 502, { error: 'generate', detail: error instanceof Error ? error.message : String(error) });
          }
          } finally {
            rerollRunning = false;
          }
        },
      }),
    'pet-chatter: reroll route',
  );

  // Short chat inside the bubble: one model turn, no session, no queue.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/chat',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { error: 'bad-json' });
            return;
          }
          const prompt = clip(body.text, 200);
          if (!prompt) {
            sendJson(res, 400, { error: 'empty' });
            return;
          }
          // A reply from a proactive bubble carries that line as context so the
          // agent answers "that remark", not a decontextualized sentence.
          const context = clip(body.context, 200);
          const agentPrompt = context ? `（你刚才主动说：${context}）\n${prompt}` : prompt;
          if (context) replyChatActive = true;
          // "记住：…" stores one fact without spending a model call.
          // Accept the natural variants: 「记住：…」「帮我记住…」「记一下 …」.
          const remember = /^(?:请|帮我)?(?:记住|记一下|记下)[:：,，\s]*(.+)$/u.exec(prompt);
          if (remember) {
            const fact = clip(remember[1], 60);
            if (fact) {
              facts = [...facts.filter((item) => item !== fact), fact].slice(-12);
              await writeJsonAtomic(MEMORY_FILE, { facts, updatedAt: Date.now() }).catch(() => {});
              const replyText = `记住啦：${fact}`;
              const config = { ...withNightOverlay(current(), new Date()), facts };
              const audioUrl = await speak(replyText, config, 'chat', { probe: true });
              sendJson(res, 200, { ok: true, reply: replyText, remembered: fact, audioUrl: audioUrl || null, voiceFailed: !audioUrl && config.tts !== 'off', engine: 'memory', chat: petAgentStatusPayload() });
              return;
            }
          }
          const config = { ...withNightOverlay(current(), new Date()), facts };
          const llm = ctx.get('llm');
          const selection = currentSelection();
          if (!llm || typeof llm.stream !== 'function' || !selection?.provider || !selection?.model) {
            sendJson(res, 503, { error: 'model-unavailable' });
            return;
          }
          let reply = '';
          let engine = 'single';
          let agentError = '';
          if (config.chatAgent) {
            try {
              reply = await chatWithPetAgent(agentPrompt, config, selection);
              engine = 'agent';
            } catch (error) {
              agentError = error instanceof Error ? error.message : String(error);
              warn(`pet agent chat failed, falling back to one-shot: ${agentError}`);
            }
          }
          if (!reply) {
            // Keep the old path as a safety net: a broken agent must not make the
            // chat unusable. This is still one model call with a little history.
            if (Date.now() - chatTurnsAt > 30 * 60_000) chatTurns.length = 0;
            try {
              const answer = await ask(
                llm,
                selection,
                {
                  userText: agentPrompt,
                  assistantText: '',
                  tools: [],
                  turnStartedAt: 0,
                  userAt: Date.now(),
                  endedAt: Date.now(),
                },
                config,
                'chat',
                chatTurns.slice(-6),
              );
              reply = String(answer.text || '');
              engine = 'single';
            } catch (error) {
              sendJson(res, 502, { error: 'chat', detail: error instanceof Error ? error.message : String(error) });
              return;
            }
          }
          reply = clip(
            stripDecorativeMarks(stripHtml(String(reply)))
              .replace(/^["'「『]+|["'」』]+$/g, '')
              .replace(/[*_`#>]/g, '')
              .replace(/\s*\n+\s*/g, ' ')
              .trim(),
            80,
          );
          if (!reply) {
            sendJson(res, 502, { error: 'empty', agentError });
            return;
          }
          if (engine === 'single') {
            chatTurns.push({ role: 'user', text: prompt });
            chatTurns.push({ role: 'assistant', text: reply });
            while (chatTurns.length > 8) chatTurns.shift();
            chatTurnsAt = Date.now();
          }
          // The voice is synthesized BEFORE the reply is returned, so the bubble
          // and the audio can appear in the same paint instead of seconds apart.
          // A slow engine gets seven seconds; past that we would rather show the
          // line with the alert clip than leave the human staring at "在想…".
          const audioUrl = await Promise.race([
            speak(reply, config, 'chat', { probe: true }),
            delay(7000).then(() => null),
          ]);
          sendJson(res, 200, {
            ok: true,
            reply,
            audioUrl: audioUrl || null,
            voiceFailed: !audioUrl && config.tts !== 'off',
            engine,
            agentError,
            chat: petAgentStatusPayload(),
          });
        },
      }),
    'pet-chatter: chat route',
  );

  // Closing a reply session releases the live agent handle only. The session id
  // and its log stay on disk, so the next long-press resumes the same memory.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/chat/reply-close',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          if (!replyChatActive) {
            sendJson(res, 200, { ok: true, disposed: false });
            return;
          }
          replyChatActive = false;
          const handle = petAgentHandle;
          petAgent = null;
          petAgentHandle = null;
          petAgentState.ready = false;
          petAgentState.error = '';
          if (handle) await handle.dispose().catch(() => {});
          sendJson(res, 200, { ok: true, disposed: Boolean(handle) });
        },
      }),
    'pet-chatter: reply close route',
  );

  // Diagnostics for the memory agent: context use, compaction and last error.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/chat/status',
        handler: (req, res) => {
          if (!guarded(req, res)) return;
          sendJson(res, 200, { ok: true, chat: petAgentStatusPayload(), selection: currentSelection() || null });
        },
      }),
    'pet-chatter: chat status route',
  );

  // Manual compression (settings button / tests). `force` also exercises the
  // full summarize-and-rotate path before the threshold is reached.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/chat/compact',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let force = false;
          try {
            const body = await readBody(req);
            force = body && body.force === true;
          } catch {
            /* optional body */
          }
          const agent = petAgent;
          if (!agent) {
            sendJson(res, 200, { ok: false, skipped: 'not-ready', chat: petAgentStatusPayload() });
            return;
          }
          const result = await maybeCompactPetAgent(agent, current(), { force });
          sendJson(res, 200, { ok: Boolean(result), result, chat: petAgentStatusPayload() });
        },
      }),
    'pet-chatter: chat compact route',
  );

  // The greeting a long-press shows immediately, with the configured frame and
  // effects. It carries no audio yet: the client fetches /speak right away.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/manual/hello',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          const config = withNightOverlay(current(), new Date());
          const text = CHAT_GREETINGS[Math.floor(Math.random() * CHAT_GREETINGS.length)];
          sendJson(res, 200, { ok: true, greeting: true, item: manualItem(text, config) });
        },
      }),
    'pet-chatter: manual hello route',
  );

  // Drag feedback and the quick tap share one local pipeline and one gate.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/drag',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            body = {};
          }
          try {
            const result = await dragRemark(body && body.position, body && body.action);
            if (!result.ok) {
              sendJson(res, 200, { ok: false, skipped: result.skipped, retryAfter: result.retryAfter || 0 });
              return;
            }
            sendJson(res, 200, { ok: true, item: result.item, timings: result.timings });
          } catch (error) {
            sendJson(res, 502, { error: 'drag', detail: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    'pet-chatter: drag route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/click',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            body = {};
          }
          try {
            const result = await clickRemark(body && body.action);
            if (!result.ok) {
              sendJson(res, 200, { ok: false, skipped: result.skipped, retryAfter: result.retryAfter || 0 });
              return;
            }
            sendJson(res, 200, { ok: true, item: result.item, timings: result.timings });
          } catch (error) {
            sendJson(res, 502, { error: 'click', detail: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    'pet-chatter: click route',
  );

  // Chat is the highest-priority bubble source. While it is open the other
  // three sources are paused; closing it resumes them on the next trigger.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/chat-state',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            body = {};
          }
          chatOpen = body && body.open === true;
          chatOpenAt = Date.now();
          if (chatOpen) {
            // Chat owns the bubble while it is open: discard anything that was
            // queued just before the long press so it cannot pop afterwards.
            queue.length = 0;
          }
          sendJson(res, 200, { ok: true, chatOpen: chatPaused(), cleared: chatOpen });
        },
      }),
    'pet-chatter: chat state route',
  );

  // The browser reports when a bubble is actually on screen (not merely
  // enqueued). While it is visible, click/drag/auto cannot start another one.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/bubble-state',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            body = {};
          }
          const id = String(body.id || '').slice(0, 64);
          if (body.active === true) {
            activeBubbleId = id;
            activeBubbleUntil = Date.now() + 90_000;
          } else if (!id || id === activeBubbleId) {
            activeBubbleId = '';
            activeBubbleUntil = 0;
          }
          sendJson(res, 200, { ok: true, active: activeBubbleUntil > Date.now() });
        },
      }),
    'pet-chatter: bubble state route',
  );

  // Speech for a conversation reply, fetched after the text is already on
  // screen so the human does not wait for the engine.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/speak',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { error: 'bad-json' });
            return;
          }
          const text = clip(body.text, 200);
          if (!text) {
            sendJson(res, 400, { error: 'empty' });
            return;
          }
          const config = { ...withNightOverlay(current(), new Date()), facts };
          const audioUrl = await speak(text, config, 'chat', { probe: true });
          sendJson(res, 200, { ok: Boolean(audioUrl), audioUrl });
        },
      }),
    'pet-chatter: speak route',
  );

  // Long-term memory: list and clear the facts the pet keeps about the human.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/memory',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { error: 'bad-json' });
            return;
          }
          if (body.action === 'clear') {
            facts = [];
          } else if (body.action === 'remove' && typeof body.text === 'string') {
            facts = facts.filter((item) => item !== body.text);
          } else if (body.action === 'add' && typeof body.text === 'string' && body.text.trim()) {
            facts = [...facts.filter((item) => item !== body.text.trim()), clip(body.text, 60)].slice(-12);
          } else {
            sendJson(res, 400, { error: 'bad-action' });
            return;
          }
          await writeJsonAtomic(MEMORY_FILE, { facts, updatedAt: Date.now() }).catch(() => {});
          sendJson(res, 200, { ok: true, memory: facts });
        },
      }),
    'pet-chatter: memory route',
  );

  // One-shot capability report from the browser half (which slots it mounted).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/hello',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          try {
            const body = await readBody(req);
            if (body && typeof body === 'object') clientInfo = body;
          } catch {
            clientInfo = { error: 'bad-body' };
          }
          sendJson(res, 200, { ok: true });
        },
      }),
    'pet-chatter: hello route',
  );

  // The browser half reports what it actually did with each bubble (shown,
  // played, blocked, cut short, dismissed). Reading these back is the only way
  // to debug "it spoke five times at once" from the host side.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/client-log',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          try {
            const body = await readBody(req);
            const event = body && typeof body === 'object' ? body : null;
            if (event) {
              clientLog.push({
                at: Date.now(),
                event: String(event.event || '').slice(0, 24),
                id: String(event.id || '').slice(0, 12),
                ms: Number.isFinite(event.ms) ? Math.round(event.ms) : 0,
                detail: String(event.detail || '').slice(0, 60),
              });
              while (clientLog.length > 40) clientLog.shift();
            }
          } catch {
            /* diagnostics only */
          }
          res.statusCode = 204;
          res.end();
        },
      }),
    'pet-chatter: client log route',
  );

  // Cheap liveness ping: keeps "is anyone looking at the page" truthful even if
  // the bubble component is temporarily unmounted (a crash, a re-render storm).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/heartbeat',
        handler: (req, res) => {
          if (!guarded(req, res)) return;
          lastPollAt = Date.now();
          if (typeof req.headers['x-pet-chatter-pet'] === 'string') {
            lastPet = req.headers['x-pet-chatter-pet'] === '1';
          }
          const rect = req.headers['x-pet-chatter-petrect'];
          if (typeof rect === 'string' && /^-?\d+(,-?\d+){3}$/.test(rect)) lastPetRect = rect;
          if (typeof req.headers['x-pet-chatter-handle'] === 'string') {
            lastHandle = false;
          }
          if (typeof req.headers['x-pet-chatter-env'] === 'string') lastEnv = req.headers['x-pet-chatter-env'].slice(0, 120);
          if (typeof req.headers['x-pet-chatter-hudstyle'] === 'string') hudStyle = req.headers['x-pet-chatter-hudstyle'].slice(0, 120);
          if (typeof req.headers['x-pet-chatter-chain'] === 'string') {
            try { hudChain = decodeURIComponent(req.headers['x-pet-chatter-chain']).slice(0, 500); } catch { /* ignore */ }
          }
          if (typeof req.headers['x-pet-chatter-top'] === 'string') {
            try {
              lastTop = decodeURIComponent(req.headers['x-pet-chatter-top']).slice(0, 120);
            } catch {
              /* ignore malformed */
            }
          }
          noteClient(req, { pet: lastPet, rect: lastPetRect, handle: lastHandle, top: lastTop });
          // The version lets a stale page notice it is running old code without
          // reloading anything by itself.
          sendJson(res, 200, {
            ok: true,
            version: CLIENT_VERSION,
            bubbleGapSeconds: current().bubbleGapSeconds,
            dragFeedback: current().dragFeedback,
            petReactions: current().petReactions,
            chatAgent: current().chatAgent,
          });
        },
      }),
    'pet-chatter: heartbeat route',
  );

  // Force one remark now; used by tests and by "let me hear it" checks.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/pet-chatter/test',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method' });
            return;
          }
          if (!guarded(req, res)) return;
          const config = withNightOverlay(current(), new Date());
          lastPollAt = Date.now();

          const query = new URL(req.url || '/', 'http://x').searchParams;
          const forcedVoice = query.get('voice');
          const voiceOverride = forcedVoice && VOICES.includes(forcedVoice) ? forcedVoice : undefined;
          const personalityOverride = query.get('personality');
          const effectsOverride = query.get('effects');
          const ttsOverride = query.get('tts');
          const frameOverride = query.get('frame');
          const forceSticker = query.get('sticker') === '1';
          const forceProactive = query.get('proactive') === '1';
          const internal = query.get('internal') === '1';
          const effective = {
            ...config,
            ...(voiceOverride ? { voice: voiceOverride } : {}),
            ...(PERSONALITIES.includes(personalityOverride) ? { personality: personalityOverride } : {}),
            ...(['none', 'soft', 'lively', 'typewriter'].includes(effectsOverride) ? { effects: effectsOverride } : {}),
            ...(['auto', 'edge', 'sapi', 'off'].includes(ttsOverride) ? { tts: ttsOverride } : {}),
            ...(FRAMES.includes(frameOverride) ? { bubbleStyle: frameOverride } : {}),
          };
          const kindParam = query.get('kind');
          const kind = ['idea', 'roast', 'comment', 'comfort', 'idle', 'bedtime'].includes(kindParam)
            ? kindParam
            : query.get('idea') === '1' || Math.random() < effective.ideaChance
              ? 'idea'
              : 'comment';

          // Deterministic alert-shape probe for acceptance/UI tests; the real
          // TTS-failure path is covered by ?simulateVoiceFail=1 in test-voice.
          if (query.get('alert') === '1') {
            sendJson(res, 200, { ok: true, item: alertItem(effective), debug: { forced: 'alert' } });
            return;
          }

          let digest;
          for (const value of digests.values()) {
            if (!digest || value.userAt > digest.userAt) digest = value;
          }
          // `?sample=1` forces a neutral, non-self-referential turn so persona
          // audits always exercise the normal path.
          const useSample = query.get('sample') === '1';
          const sample =
            !useSample && digest && digest.userText
              ? digest
              : {
                  userText: '帮我把这周的实验数据整理成一张对比表',
                  assistantText: '已经按组别整理好对比表，并标出了三处偏差最大的数据。',
                  tools: ['read', 'write'],
                  turnStartedAt: Date.now() - (45_000 + Math.round(Math.random() * 135_000)),
                  userAt: Date.now() - 120_000,
                  endedAt: Date.now(),
                  touchedAt: Date.now(),
                };

          const llm = ctx.get('llm');
          let selection;
          try {
            selection = ctx.get('agentDefaultModel')?.currentSelection?.();
          } catch {
            selection = undefined;
          }
          if (!llm || !selection?.provider || !selection?.model) {
            sendJson(res, 503, { error: 'model-unavailable' });
            return;
          }
          try {
            if (/[?&]simulateVoiceFail=1/.test(req.url || '')) simulateVoiceFail = 1;
            const askStart = Date.now();
            const selfTopic = SELF_TOPIC_RE.test(String(sample.userText || ''));
            const askSample = selfTopic
              ? { ...sample, userText: '（没什么特别的事，随口聊一句）', assistantText: '', tools: [], turnStartedAt: 0, endedAt: 0, failed: false }
              : sample;
            const raw = await ask(llm, selection, askSample, selfTopic ? { ...effective, selfTopic: true } : effective, kind);
            const answer = selfTopic ? { ...raw, text: guardSelfTopic(raw.text, true) } : raw;
            const askMs = Date.now() - askStart;
            const speakStart = Date.now();
            const item = await buildItem(answer, kind, effective, forceSticker, sample.userText, `${sample.userText}${sample.tools.length ? ` · 工具：${sample.tools.join('、')}` : ''}`, { proactive: forceProactive });
            const speakMs = Date.now() - speakStart;
            if (!item) {
              sendJson(res, 200, {
                ok: false,
                error: 'empty',
                debug: { finish: answer.finish, failure: answer.failure, sample: clip(answer.text, 160), askMs, speakMs },
              });
              return;
            }
            // Test probes must never become prompt material for the real pet:
            // their neutral sample contains phrases like “三处偏差” and would
            // keep resurfacing in idle/proactive lines. Only live items enter
            // the recent/history pools.
            if (!internal && !useSample && !recent.includes(item.text)) {
              recent.push(item.text);
              if (recent.length > 8) recent.shift();
            }
            // `?internal=1` lets a test inspect a generated line without pushing
            // it onto the live bubble queue; `?preempt=1` is the panel's "现在来
            // 一句", which replaces the current bubble and skips the echo guard.
            const preempt = /[?&]preempt=1/.test(req.url || '');
            if (preempt) item.preempt = true;
            if (!internal) enqueue(item, { dedupe: !preempt });
            sendJson(res, 200, {
              ok: true,
              item,
              digest: {
                userText: clip(sample.userText, 120),
                assistantText: clip(sample.assistantText, 120),
                tools: sample.tools,
              },
              debug: {
                finish: answer.finish,
                failure: answer.failure,
                sample: clip(answer.text, 160),
                askMs,
                speakMs,
                clientSeenAt,
                clientVersion,
                clientInfo,
                clientSlots,
                lastPollAt,
                queueLength: queue.length,
                anchor: lastAnchor,
                personality: effective.personality,
                voice: effective.voice,
              },
            });
          } catch (error) {
            sendJson(res, 502, { error: 'generate', detail: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    'pet-chatter: test route',
  );
}
