/**
 * Dependency-free helpers shared by the Host half and the unit tests.
 *
 * Nothing here touches Cordis, the filesystem or the network, so
 * `node tools/test-pure.mjs` can exercise it without booting the plugin.
 */

export const MOODS = ['开心', '得意', '委屈', '吃瓜', '摸鱼', '困', '赞', '生气', '疑惑'];

/** A page that has not polled for this long counts as closed. */
export const POLL_FRESH_MS = 90_000;

/**
 * One-click modes: a partial config patch, applied over the saved settings.
 * `default` is special-cased by the caller (it clears the overrides instead).
 */
export const PRESETS = {
  quiet: {
    frequency: 'rare',
    ideaChance: 0.1,
    roastChance: 0.05,
    minGapMinutes: 10,
    maxPerHour: 3,
    voiceChance: 0.6,
    effects: 'soft',
    idleEnabled: false,
  },
  chatty: {
    frequency: 'often',
    ideaChance: 0.35,
    roastChance: 0.22,
    minGapMinutes: 1,
    maxPerHour: 15,
    voiceChance: 0.95,
    effects: 'lively',
    idleEnabled: true,
    idleMinutes: 25,
  },
  night: {
    frequency: 'rare',
    ideaChance: 0.15,
    roastChance: 0.08,
    minGapMinutes: 8,
    maxPerHour: 4,
    quietHours: '01:00-08:00',
    voiceChance: 0.5,
    volume: 0.5,
    effects: 'soft',
    idleEnabled: false,
  },
};

export const PRESET_LABELS = {
  quiet: '安静模式',
  chatty: '话痨模式',
  night: '深夜模式',
  default: '恢复默认',
};

/** Copy of one preset's patch, or null for an unknown name. */
export function presetPatch(name) {
  const preset = PRESETS[String(name ?? '')];
  return preset ? { ...preset } : null;
}

/** Values forced while the automatic night window is open. */
export const NIGHT_OVERLAY = {
  frequency: 'rare',
  ideaChance: 0.15,
  minGapMinutes: 8,
  maxPerHour: 4,
  voiceChance: 0.5,
  volume: 0.5,
  effects: 'soft',
  idleEnabled: false,
};

/** True when the automatic night window is enabled and the clock is inside it. */
export function nightActive(config, now = new Date()) {
  if (!config || !config.nightAuto) return false;
  return inQuietHours(config.nightHours || '01:00-08:00', now);
}

/**
 * Effective config for "right now": the stored settings, with the night overlay
 * applied while the automatic window is open. The settings page still shows the
 * stored values, so the overlay never rewrites what the user chose.
 */
export function withNightOverlay(config, now = new Date()) {
  if (!nightActive(config, now)) return config;
  return { ...config, ...NIGHT_OVERLAY, night: true };
}

/**
 * Gate for the unsolicited "the human has been quiet" remark.
 *
 * Kept pure so the decision table can be unit-tested: every input is explicit
 * (including `roll`, the random value the caller already drew), and `now` is
 * a parameter rather than the clock.
 */
export function shouldIdle(input) {
  const {
    config,
    now,
    lastPollAt,
    lastActivityAt,
    lastCommentAt,
    hourStart,
    hourCount,
    inFlight,
    roll = 0,
  } = input || {};
  if (!config || !config.enabled || !config.idleEnabled) return false;
  if (inQuietHours(config.quietHours, new Date(now))) return false;
  // Do not gate on unrelated background sessions. A long coding turn used to
  // keep `runningCount` above zero for hours, which silently disabled every
  // idle remark even though the human had long stopped typing. `lastActivityAt`
  // is the honest signal for "the human is quiet"; a bubble is non-modal and
  // must not be held hostage by another session's agent.
  if (now - lastPollAt > POLL_FRESH_MS) return false;
  if (now - lastActivityAt < config.idleMinutes * 60_000) return false;
  if (now - lastCommentAt < config.minGapMinutes * 60_000) return false;
  if (inFlight) return false;
  // Mirror the caller's hourly window reset: an expired hour means zero used.
  const usedThisHour = now - hourStart > 3_600_000 ? 0 : hourCount;
  if (usedThisHour >= config.maxPerHour) return false;
  return roll <= 0.45;
}

/** Remove HTML wrappers that some models put around plain prose. */
export function stripHtml(input) {
  return String(input ?? '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/<\s*\/?\s*(?:p|br|div|span|strong|em|b|i|u|s|ul|ol|li|h[1-6]|code|pre|blockquote)\b[^>]*>/gi, ' ')
    // Some models truncate the closing `>` mid-stream. Catch the visible
    // `<p` / `</p` wrappers at either end even without it.
    .replace(/^\s*<\s*p\s*/i, '')
    .replace(/<\s*\/\s*p\s*$/i, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Strip decorative upper macrons, including ones between sentences, while
 *  keeping the ones used inside common kaomoji such as `(￣▽￣)`. */
export function stripDecorativeMarks(input) {
  return String(input ?? '')
    .replace(/(?<![（(=▽ω])[￣¯‾]+(?![）)=▽ω])/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Flatten markdown so a model sees prose instead of tables and fences. */
export function stripMarkdown(input) {
  return stripHtml(input)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*[-:| ]{3,}\s*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

export function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Shift an SSML rate (`+8%`) by a delta in percent, clamped to the valid range. */
export function shiftRate(value, deltaPercent, fallback = '+8%') {
  const parse = (input) => {
    const match = /^([+-]?)(\d{1,3}(?:\.\d+)?)%$/.exec(String(input ?? '').trim());
    if (!match) return Number.NaN;
    return Number(match[2]) * (match[1] === '-' ? -1 : 1);
  };
  const base = Number.isFinite(parse(value)) ? parse(value) : parse(fallback);
  const next = Math.min(200, Math.max(-100, (Number.isFinite(base) ? base : 0) + deltaPercent));
  return `${next >= 0 ? '+' : '-'}${Math.abs(Math.round(next * 10) / 10)}%`;
}

/** Shift an SSML pitch (`+15Hz`) by a delta in hertz, clamped to ±100 Hz. */
export function shiftPitch(value, deltaHz, fallback = '+15Hz') {
  const parse = (input) => {
    const match = /^([+-]?)(\d{1,3}(?:\.\d+)?)Hz$/i.exec(String(input ?? '').trim());
    if (!match) return Number.NaN;
    return Number(match[2]) * (match[1] === '-' ? -1 : 1);
  };
  const base = Number.isFinite(parse(value)) ? parse(value) : parse(fallback);
  const next = Math.min(100, Math.max(-100, (Number.isFinite(base) ? base : 0) + deltaHz));
  return `${next >= 0 ? '+' : '-'}${Math.abs(Math.round(next * 10) / 10)}Hz`;
}

export function number(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function oneOf(value, allowed, fallback) {
  const text = String(value ?? '').trim();
  return allowed.includes(text) ? text : fallback;
}

/** True when the local clock sits inside `HH:MM-HH:MM` (may wrap midnight). */
export function inQuietHours(spec, now = new Date()) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim());
  if (!match) return false;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const current = now.getHours() * 60 + now.getMinutes();
  const valid = [start, end, current].every((value) => Number.isFinite(value));
  if (!valid || start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Pull the text blocks out of a message-shaped payload. */
export function textOf(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/** Cut at a sentence end when possible, so a bubble never looks chopped mid-word. */
export function trimRemark(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('～'),
    cut.lastIndexOf('~'),
  );
  if (stop >= max * 0.55) return cut.slice(0, stop + 1);
  return `${cut}…`;
}

/** Tolerant parse of the model answer: JSON first, plain text second. */
export function parseRemark(raw, max = 45) {
  const source = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let text = source;
  let mood = '开心';
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      if (parsed && typeof parsed.text === 'string') text = parsed.text;
      if (parsed && typeof parsed.mood === 'string' && MOODS.includes(parsed.mood)) mood = parsed.mood;
    } catch {
      /* keep the raw text */
    }
  }
  text = stripDecorativeMarks(stripHtml(text))
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
  return { text: trimRemark(text, max), mood };
}

/** Strict `HH:MM` check: 0-23 hours, 0-59 minutes. */
export function isClockTime(spec) {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(spec ?? '').trim());
}

/** Local day key used to fire a once-per-day reminder. */
export function dayKey(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/**
 * True when `HH:MM` has just come around today (a 15-minute window) and it has
 * not fired yet. `lastDay` is the key stored when it last fired.
 */
export function bedtimeDue(spec, now = new Date(), lastDay = '') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim());
  if (!match) return false;
  const target = Number(match[1]) * 60 + Number(match[2]);
  const current = now.getHours() * 60 + now.getMinutes();
  if (current < target || current > target + 15) return false;
  return dayKey(now) !== lastDay;
}