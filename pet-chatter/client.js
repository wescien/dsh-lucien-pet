window.__ModuleLoader__.load({
  id: '@local/pet-chatter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useRef, useState } = React;

    // A local request is cheap, and the pet should speak within a second or two of
    // the turn ending rather than up to five.
    const POLL_MS = 2000;
    const HIDDEN_POLL_MS = 9000;
    const FOLLOW_MS = 120;
    /** Proactive bubbles linger this long after the pet stops speaking. */
    const PROACTIVE_CLOSE_MS = 3_000;
    // The alert clip used to be a Windows WAV at this exact URL and was cached
    // immutably by the browser. A version suffix makes the Xiaoyi MP3 replace it.
    const ALERT_URL = '/pet-chatter/alert-voice?v=xiaoyi-1';
    const OFFSET_KEY = 'dsh.pet-chatter.offset';
    /** Timestamp of the last keystroke inside an editable field. */
    let lastTypingAt = 0;
    const GAP = 10;
    // Stable per-page id so the host can tell which window is polling.
    const CLIENT_ID = Math.random().toString(36).slice(2, 10);
    const INSET = 6;
    const CORNER = 24;
    const CORNER_BOTTOM = 236;

    const CSS = `
      .pc-bubble {
        position: fixed; z-index: 2147483001; box-sizing: border-box;
        display: flex; gap: 9px; align-items: center;
        /* Do not let the right-edge clamp squeeze the text into a narrow column:
           measure the whole line first, then clamp the position. */
        width: max-content;
        max-width: min(320px, calc(100vw - 16px)); min-width: 150px;
        padding: 10px 32px 10px 12px; border-radius: 14px;
        background: var(--dsw-alias-bg-overlay, #fff);
        color: var(--dsw-alias-label-primary, #1f2328);
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
        box-shadow: 0 10px 28px rgba(20, 30, 60, 0.18);
        font-size: 13px; line-height: 1.5; font-family: inherit;
        opacity: 0; transform: translateY(6px) scale(0.98);
        transition: opacity 0.18s ease, transform 0.18s ease;
        pointer-events: auto; cursor: grab; user-select: none; -webkit-user-select: none;
      }
      .pc-bubble.is-visible { opacity: 1; transform: none; }
      .pc-bubble.is-plain { transition: none; }
      .pc-bubble.is-dragging { cursor: grabbing; }
      .pc-sticker { width: 54px; height: 54px; object-fit: contain; flex: none; border-radius: 8px; }
      .pc-body { min-width: 0; }
      .pc-kind {
        display: inline-block; margin-bottom: 4px; padding: 1px 7px; border-radius: 999px;
        font-size: 10.5px; line-height: 1.7;
        background: var(--dsw-alias-bg-layer-2, rgba(120, 160, 255, 0.14));
        color: var(--dsw-alias-label-secondary, #6b7280);
      }
      .pc-quote { margin-bottom: 4px; font-size: 11.5px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
      .pc-notice { margin-top: 6px; font-size: 11.5px; color: #b45309; }
      .pc-chat { display: flex; gap: 6px; margin-top: 8px; }
      .pc-chat-input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border-radius: 7px; font: inherit; font-size: 12px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12));
        background: var(--dsw-alias-bg-layer-1, #f7f8fb); color: inherit; }
      .pc-chat-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
      .pc-chat-send { height: 26px; padding: 0 10px; border-radius: 7px; border: 0; font: inherit; font-size: 12px; cursor: pointer;
        background: #4d6bfe; color: #fff; }
      .pc-chat-send:disabled { opacity: 0.6; cursor: default; }
      .pc-chat-reply { margin-top: 6px; font-size: 12.5px; line-height: 1.5; opacity: 0.9; white-space: normal; word-break: break-word; }
      .pc-chat-pending { margin-top: 6px; font-size: 12px; opacity: 0.65; }
      .pc-chat-pending::after { content: '…'; animation: pcBlink 1s steps(1) infinite; }
      .pc-text { white-space: normal; word-break: break-word; }
      /* The full line reserves its final width/height while the typewriter
         reveals a prefix on top, so the bubble never reflows mid-sentence. */
      .pc-text-stack { position: relative; display: block; }
      .pc-text-ghost { display: block; visibility: hidden; }
      .pc-text-live { position: absolute; inset: 0; display: block; pointer-events: none; text-align: left; }
      /* Even when the bubble is pinned near the right edge, every line starts
         at the same left margin; only the bubble anchor is right-aligned. */
      .pc-text-live.is-rtl { text-align: left; }
      .pc-caret { opacity: 0.55; animation: pcBlink 1s steps(1) infinite; }
      @keyframes pcBlink { 50% { opacity: 0; } }
      .pc-dismiss {
        position: absolute; top: 3px; right: 5px; z-index: 2;
        width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
        background: transparent; color: inherit; cursor: pointer;
        font-family: system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif;
        font-size: 17px; line-height: 24px; text-align: center;
        opacity: 0.45;
      }
      .pc-dismiss:hover, .pc-dismiss:focus-visible {
        opacity: 1; background: var(--dsw-alias-bg-layer-2, rgba(120, 160, 255, 0.12));
        outline: none;
      }
      .pc-reply {
        position: absolute; top: 31px; right: 5px; z-index: 2;
        width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
        background: transparent; color: inherit; cursor: pointer;
        font-family: system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif;
        font-size: 14px; line-height: 24px; text-align: center;
        opacity: 0.45;
      }
      .pc-reply:hover, .pc-reply:focus-visible {
        opacity: 1; background: var(--dsw-alias-bg-layer-2, rgba(120, 160, 255, 0.12));
        outline: none;
      }
      .pc-bubble[data-reply='1'] { min-height: 64px; }
      .pc-tail {
        position: absolute; right: 18px; bottom: -5px; width: 10px; height: 10px;
        background: inherit; transform: rotate(45deg);
        border-right: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
      }
      .pc-bubble.is-flip .pc-tail {
        bottom: auto; top: -5px; border: 0;
        border-left: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
      }
      /* Frame variants: only the surface changes. Text, sticker and layout keep
         their own rules, so switching frames can never crop the content. */
      .pc-bubble[data-frame='glass'] {
        background: linear-gradient(155deg, rgba(255,255,255,0.66), rgba(206,230,255,0.5));
        -webkit-backdrop-filter: blur(14px) saturate(1.35);
        backdrop-filter: blur(14px) saturate(1.35);
        border: 1px solid rgba(255,255,255,0.95);
        box-shadow: 0 16px 36px rgba(40,80,160,0.22), inset 0 1px 0 rgba(255,255,255,0.95);
      }
      .pc-bubble[data-frame='glass'] .pc-tail {
        background: rgba(246,250,255,0.78);
        border-color: rgba(255,255,255,0.9);
      }
      .pc-bubble[data-frame='outline'] {
        background: rgba(255,255,255,0.82);
        border: 1.5px solid rgba(31,41,55,0.7);
        box-shadow: none;
      }
      .pc-bubble[data-frame='outline'] .pc-tail {
        background: rgba(255,255,255,0.82);
        border-color: rgba(31,41,55,0.7);
      }
      .pc-bubble[data-frame='paper'] {
        background: repeating-linear-gradient(0deg, #fffaf0 0 25px, #fbf1dc 25px 26px), #fffaf0;
        border: 1px dashed rgba(176,128,58,0.6);
        border-radius: 10px;
        box-shadow: 0 8px 20px rgba(120,90,40,0.18);
        color: #5b4636;
      }
      .pc-bubble[data-frame='paper'] .pc-kind { background: rgba(176,128,58,0.16); color: #7a5a2e; }
      .pc-bubble[data-frame='paper'] .pc-chat-input { background: rgba(255,255,255,0.72); }
      .pc-bubble[data-frame='paper'] .pc-tail {
        background: #fffaf0;
        border-color: rgba(176,128,58,0.6);
      }
      .pc-bubble[data-frame='neon'] {
        background: linear-gradient(160deg, #0b1220 0%, #161335 58%, #241033 100%);
        border: 1px solid rgba(96,220,255,0.6);
        box-shadow: 0 0 0 1px rgba(255,86,220,0.18), 0 0 20px rgba(72,208,255,0.35), 0 16px 32px rgba(6,10,24,0.55);
        color: #e9f6ff;
      }
      .pc-bubble[data-frame='neon'] .pc-kind { background: rgba(72,208,255,0.16); color: #9fe8ff; }
      .pc-bubble[data-frame='neon'] .pc-quote { opacity: 0.5; }
      .pc-bubble[data-frame='neon'] .pc-notice { color: #ffd479; }
      .pc-bubble[data-frame='neon'] .pc-chat-input {
        background: rgba(255,255,255,0.08);
        border-color: rgba(120,220,255,0.32);
        color: #e9f6ff;
      }
      .pc-bubble[data-frame='neon'] .pc-tail {
        background: #0f1128;
        border-color: rgba(96,220,255,0.6);
      }
      .pc-bubble[data-frame='comic'] {
        background: #ffffff;
        border: 2px solid #111827;
        border-radius: 16px;
        box-shadow: 4px 4px 0 rgba(17,24,39,0.88);
        color: #111827;
      }
      .pc-bubble[data-frame='comic'] .pc-kind { background: #ffe066; color: #111827; }
      .pc-bubble[data-frame='comic'] .pc-tail {
        background: #ffffff;
        border-color: #111827;
        border-width: 0 2px 2px 0;
      }
      /* Native skin: white hand-drawn cloud with a thick black outline and a
         bold rounded face, matching the pet's own sticker bubbles. */
      .pc-bubble[data-frame='native'] {
        background: #fff;
        border: 3px solid #16161a;
        border-radius: 34px 27px 36px 24px / 30px 38px 26px 32px;
        box-shadow: 2px 3px 0 -1px rgba(22, 22, 26, 0.10), 0 10px 22px rgba(20, 30, 60, 0.10);
        color: #111114;
        padding: 10px 32px 10px 15px;
        font-family: 'YouYuan', '幼圆', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif;
        animation: pcNativePop 0.24s cubic-bezier(0.2, 0.9, 0.25, 1.12) both;
      }
      .pc-bubble[data-frame='native'] .pc-kind { display: none; }
      .pc-bubble[data-frame='native'] .pc-text {
        font-family: inherit;
        font-size: 16px;
        font-weight: 700;
        line-height: 1.45;
        letter-spacing: 0.02em;
        -webkit-font-smoothing: antialiased;
      }
      .pc-bubble[data-frame='native'] .pc-quote { font-family: inherit; font-size: 12px; }
      .pc-bubble[data-frame='native'] .pc-chat,
      .pc-bubble[data-frame='native'] .pc-chat-input,
      .pc-bubble[data-frame='native'] .pc-chat-send,
      .pc-bubble[data-frame='native'] .pc-notice {
        font-family: system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      }
      /* Dark mode: keep only the outline black; a white field keeps the
         inherited black chat text readable. */
      .pc-bubble[data-frame='native'] .pc-chat-input {
        background: #fff;
        color: #111114;
        border: 2px solid #16161a;
      }
      .pc-bubble[data-frame='native'] .pc-chat-input::placeholder {
        color: rgba(17, 17, 20, 0.5);
      }
      .pc-bubble[data-frame='native'] .pc-tail {
        left: var(--pc-tail-x, calc(50% - 7px));
        right: auto;
        bottom: -7px;
        width: 14px;
        height: 14px;
        background: #fff;
        border-width: 0 3px 3px 0;
        border-color: #16161a;
        border-bottom-right-radius: 3px;
      }
      .pc-bubble[data-frame='native'].is-flip .pc-tail {
        top: -7px;
        bottom: auto;
        border-width: 3px 0 0 3px;
        border-top-left-radius: 3px;
      }
      @keyframes pcNativePop {
        0% { transform: translateY(7px) scale(0.94); }
        60% { transform: translateY(-1px) scale(1.01); }
        100% { transform: none; }
      }
      .pc-bubble.is-lively { animation: pcPop 0.42s cubic-bezier(0.2, 0.9, 0.3, 1.2) both; }
      @keyframes pcPop {
        0% { transform: translateY(10px) scale(0.9) rotate(-1.5deg); }
        60% { transform: translateY(-2px) scale(1.03) rotate(0.6deg); }
        100% { transform: none; }
      }
      .pc-spark {
        position: absolute; font-size: 11px; pointer-events: none;
        color: var(--dsw-alias-brand-primary, #4d6bfe);
        animation: pcSpark 0.9s ease-out forwards; animation-delay: var(--pc-delay, 0ms);
      }
      @keyframes pcSpark {
        0% { opacity: 0; transform: translate(0, 0) scale(0.4); }
        30% { opacity: 1; }
        100% { opacity: 0; transform: translate(var(--pc-dx, 0), var(--pc-dy, -24px)) scale(1.1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .pc-bubble { transition: none; }
        .pc-bubble.is-lively { animation: none; }
        .pc-bubble[data-frame='native'] { animation: none; }
        .pc-spark { display: none; }
      }
    `;

    const SPARKS = [
      { left: 8, top: 4, dx: -10, dy: -26, delay: 0, glyph: '✦' },
      { left: 32, top: 0, dx: 2, dy: -30, delay: 60, glyph: '✧' },
      { left: 74, top: 6, dx: 12, dy: -24, delay: 30, glyph: '✦' },
      { left: 102, top: 16, dx: 16, dy: -18, delay: 90, glyph: '✧' },
    ];

    function readStored(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch {
        return fallback;
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage may be disabled; the bubble still works */
      }
    }

    /** A value from a fixed vocabulary, else the fallback. */
    function pickOne(value, allowed, fallback) {
      return allowed.includes(value) ? value : fallback;
    }

    /** The 大肥鱼 web pet, owned by the sticker plugin: a fixed-position div with this data attribute. */
    function findPet() {
      try {
        const direct = document.querySelector('[data-nekowhale-pet]');
        if (direct) return direct;
        const frame = document.querySelector('iframe[src*="pet.html"]');
        return frame && frame.parentElement ? frame.parentElement : null;
      } catch {
        return null;
      }
    }

    /** The iframe inside the pet box (same-origin wrapper, remote pet inside). */
    function findPetFrame() {
      const pet = findPet();
      if (!pet) return null;
      if (pet.tagName === 'IFRAME') return pet;
      return pet.querySelector('iframe');
    }

    /**
     * Make the sticker pet react: the pet accepts `core-pet-v1` commands from the
     * page that embeds it, so a bubble can trigger a matching little action.
     * Purely cosmetic; failure must never affect the bubble.
     */
    function petPlay(action) {
      if (!action) return;
      try {
        const frame = findPetFrame();
        if (!frame || !frame.src) return;
        const target = new URL(frame.src).origin;
        frame.contentWindow?.postMessage(
          { channel: 'core-pet-v1', type: 'command', command: 'play', value: action },
          target,
        );
      } catch {
        /* pet not ready or blocked */
      }
    }

    /** Tell the host whether a bubble is actually visible right now. */
    function reportBubbleState(active, id = '') {
      try {
        void window
          .fetch('/pet-chatter/bubble-state', {
            method: 'POST',
            headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: active === true, id }),
            keepalive: true,
          })
          .catch(() => {});
      } catch {
        /* diagnostics only */
      }
    }

    /** Fire-and-forget lifecycle report so the host can explain odd playback. */
    function reportClientEvent(event, detail = {}) {
      try {
        void window
          .fetch('/pet-chatter/client-log', {
            method: 'POST',
            headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, ...detail }),
            keepalive: true,
          })
          .catch(() => {});
      } catch {
        /* diagnostics must never break the bubble */
      }
    }

    function Bubble() {
      const [queue, setQueue] = useState([]);
      const [box, setBox] = useState(null);
      const [visible, setVisible] = useState(false);
      const [revealState, setRevealState] = useState({ id: '', n: 0 });
      const [chatOpen, setChatOpen] = useState(false);
      const [chatDraft, setChatDraft] = useState('');
      const [chatPending, setChatPending] = useState(false);
      const [chatItemId, setChatItemId] = useState('');
      const [panelOpen, setPanelOpen] = useState(false);
      const [notice, setNotice] = useState('');
      /** Notice set for one item must not leak onto the next bubble. */
      const setNoticeFor = (text, id = '') => {
        noticeForRef.current = id;
        setNotice(text);
      };

      const item = queue.length ? queue[0] : null;
      // Keyed by item id so a new bubble always starts at zero: otherwise the
      // previous line's length would flash in full before the reveal resets.
      const revealed = item && revealState.id === item.id ? revealState.n : 0;

      const cardRef = useRef(null);
      const offsetRef = useRef(readStored(OFFSET_KEY, { dx: 0, dy: 0 }));
      /** Last body-action name from the pet's status channel. */
      const lastPetActionRef = useRef('');
      const hideTimer = useRef(0);
      const capTimer = useRef(0);
      const dragRef = useRef(null);
      const audioRef = useRef(null);
      const openManualRef = useRef(() => {});
      /** Last pet gesture, to tell a tap from a drag like the sticker client does. */
      const petGestureRef = useRef(null);
      const petTapAtRef = useRef(0);
      const petDragRequestAtRef = useRef(0);
      const chatOpenRef = useRef(false);
      const chatItemIdRef = useRef('');
      const replyModeRef = useRef(false);
      const replyContextRef = useRef('');
      const wakeRef = useRef(() => {});
      const shownAt = useRef(0);
      const noticeForRef = useRef('');
      const panelOpenRef = useRef(false);
      const hoveredRef = useRef(false);
      const visibleRef = useRef(false);
      const dismissRef = useRef(() => {});

      /** How long the typewriter reveal needs before the text is fully shown. */
      const revealMs = (entry) => {
        if (!entry || entry.effects !== 'typewriter') return 0;
        const total = Math.max(1, entry.text.length);
        const step = Math.max(18, Math.min(45, Math.round(1400 / total)));
        return step * total;
      };
      const isProactive = (entry) => Boolean(entry && entry.proactive);

      const scheduleHide = (ms) => {
        window.clearTimeout(hideTimer.current);
        window.clearTimeout(capTimer.current);
        hideTimer.current = window.setTimeout(() => {
          // A conversation or settings panel keeps a normal bubble alive.
          // Proactive remarks are different: if the human never replies, they
          // should close shortly after the pet finishes, even under the pointer.
          if (chatOpenRef.current) {
            scheduleHide(20_000);
            return;
          }
          if (!isProactive(item) && (panelOpenRef.current || hoveredRef.current)) {
            scheduleHide(20_000);
            return;
          }
          setVisible(false);
          visibleRef.current = false;
          reportBubbleState(false, item && item.id);
          window.setTimeout(() => setQueue((current) => current.slice(1)), 500);
        }, Math.max(1000, ms));
      };

      // Esc dismisses the current bubble, but only when one is actually showing.
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && visibleRef.current) dismissRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      // Tell the host when the long-press chat opens or closes. While it is
      // open the host pauses auto remarks, taps and drags; closing it resumes
      // them on the next trigger.
      useEffect(() => {
        void window
          .fetch('/pet-chatter/chat-state', {
            method: 'POST',
            headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ open: chatOpen }),
          })
          .catch(() => {});
      }, [chatOpen]);

      const place = () => {
        const card = cardRef.current;
        const width = card && card.offsetWidth ? card.offsetWidth : 280;
        const height = card && card.offsetHeight ? card.offsetHeight : 90;
        const offset = offsetRef.current || { dx: 0, dy: 0 };
        const dx = Number.isFinite(offset.dx) ? offset.dx : 0;
        const dy = Number.isFinite(offset.dy) ? offset.dy : 0;
        const pet = item && item.anchor === 'corner' ? null : findPet();
        let left;
        let top;
        let flip = false;
        let petCenterX = 0;

        if (pet) {
          const rect = pet.getBoundingClientRect();
          petCenterX = rect.left + rect.width / 2;
          if (item && item.frame === 'native') {
            // Native skin points at the head: centred above the pet, not the
            // top-right corner used by the other frames.
            left = rect.left + rect.width / 2 - width / 2 + dx;
            top = rect.top - height - 2 + dy;
            if (top < 8) {
              top = rect.bottom + 4 + dy;
              flip = true;
            }
          } else {
            left = rect.right - width + INSET + dx;
            top = rect.top - height - GAP + dy;
            if (top < 8) {
              top = rect.bottom + GAP + dy;
              flip = true;
            }
          }
        } else {
          left = window.innerWidth - width - CORNER + dx;
          top = window.innerHeight - height - CORNER_BOTTOM + dy;
          if (top < 8) {
            top = 8;
            flip = true;
          }
        }

        left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
        top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));
        // Near a screen edge the bubble body is clamped; slide its tail so it
        // still points at the pet's head.
        let tailX = null;
        if (petCenterX && item && item.frame === 'native') {
          tailX = Math.min(Math.max(12, petCenterX - left - 7), Math.max(12, width - 26));
        }
        // A bubble pinned to the right edge should reveal from its right side:
        // otherwise the caret crawls towards the edge and the line looks like it
        // is growing out of the screen. Left/centre bubbles keep LTR.
        const rtl = window.innerWidth - (left + width) < 56;

        setBox((previous) =>
          previous &&
          Math.abs(previous.left - left) < 0.5 &&
          Math.abs(previous.top - top) < 0.5 &&
          previous.flip === flip &&
          previous.rtl === rtl &&
          previous.tailX === tailX
            ? previous
            : { left, top, flip, tailX, rtl },
        );
      };

      // Poll the host queue; the Host only generates while somebody is polling.
      useEffect(() => {
        let alive = true;
        let timer = 0;
        const tick = async () => {
          if (!alive) return;
          if (document.visibilityState !== 'visible') {
            timer = window.setTimeout(tick, HIDDEN_POLL_MS);
            return;
          }
          // Do not pop a bubble while the human is actively typing: it steals
          // attention exactly when they are composing. A focused-but-idle
          // composer must not block the pet, so only recent keystrokes count.
          if (Date.now() - lastTypingAt < 3000) {
            timer = window.setTimeout(tick, 4000);
            return;
          }
          try {
            const anchored = document.querySelector('[data-nekowhale-pet]') ? 'pet' : 'corner';
            const response = await window.fetch('/pet-chatter/pending', {
              headers: {
                'x-pet-chatter': '1',
                'x-pet-chatter-client': MY_VERSION,
                'x-pet-chatter-anchor': anchored,
                'x-pet-chatter-slots': 'bubble,settings',
                'x-pet-chatter-chat': chatOpenRef.current ? '1' : '0',
              },
              cache: 'no-store',
            });
            if (response.status === 200) {
              const next = await response.json().catch(() => null);
              // Every item arrives with its audio already resolved, so a bubble
              // is never shown mute and needs no follow-up request.
              if (next && typeof next.text === 'string' && next.text) {
                // An explicit preview replaces whatever is showing, so every
                // click answers immediately instead of waiting behind a bubble.
                if (next.preempt === true) setQueue([next]);
                else setQueue((current) => (current.length >= 2 ? current : current.concat(next)));
              }
            }
          } catch {
            /* offline or host restart: try again next tick */
          }
          if (alive) timer = window.setTimeout(tick, POLL_MS);
        };
        timer = window.setTimeout(tick, 600);
        // Coming back to the window should not wait for the hidden cadence.
        const wake = () => {
          if (document.visibilityState !== 'visible' || !alive) return;
          window.clearTimeout(timer);
          timer = window.setTimeout(tick, 60);
        };
        wakeRef.current = wake;
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        return () => {
          alive = false;
          wakeRef.current = () => {};
          window.clearTimeout(timer);
          document.removeEventListener('visibilitychange', wake);
          window.removeEventListener('focus', wake);
        };
      }, []);

      // Event-driven wake-up; polling above remains the fallback if SSE is
      // unavailable. Only a wake signal crosses this channel, never queue data.
      useEffect(() => {
        if (typeof window.EventSource !== 'function') return undefined;
        let source;
        try {
          source = new window.EventSource('/pet-chatter/events');
        } catch {
          return undefined;
        }
        const wake = () => wakeRef.current();
        source.addEventListener('wake', wake);
        return () => {
          source.removeEventListener('wake', wake);
          source.close();
        };
      }, []);

      // Show the head of the queue, keep it glued to the pet, hide it again.
      useLayoutEffect(() => {
        if (!item) return undefined;
        if (noticeForRef.current && noticeForRef.current !== item.id) {
          noticeForRef.current = '';
          setNotice('');
        }
        place();
        setVisible(true);
        visibleRef.current = true;
        reportBubbleState(true, item.id);
        shownAt.current = Date.now();
        reportClientEvent('show', { id: item.id, detail: `${item.kind} ${item.effects}${item.audioUrl ? ' audio' : ' silent'}` });
        const bubbleFree = item.frame === 'native';
        const reaction = item.manualReply
          ? 'happy'
          : item.kind === 'click' || item.kind === 'drag'
            ? null
            : {
                idea: bubbleFree ? 'curious' : 'think',
                roast: 'wink',
                comfort: 'nod-yes',
                alert: 'curious',
                idle: bubbleFree ? 'happy' : 'greet',
                bedtime: 'nod-yes',
                // Chat greetings must not spawn the pet's own "打招呼" bubble:
                // two bubbles at once was the exact conflict we are avoiding.
                chat: 'happy',
              }[item.kind] || 'happy';
        petPlay(reaction);
        // Fallback duration for the silent case; playback takes over when it runs.
        // A proactive remark closes three seconds after its text is fully shown
        // (or after audio ends, below), unless the human opens a reply first.
        const normalMs = Math.min(14_000, Math.max(5_000, 1200 + item.text.length * 130));
        scheduleHide(isProactive(item) ? PROACTIVE_CLOSE_MS + revealMs(item) : normalMs);
        return () => {
          window.clearTimeout(hideTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [item && item.id]);

      // Follow the pet while a bubble is on screen (it is draggable).
      useEffect(() => {
        if (!item) return undefined;
        const timer = window.setInterval(place, FOLLOW_MS);
        const onResize = () => place();
        window.addEventListener('resize', onResize);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('resize', onResize);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [item && item.id]);

      // Typewriter reveal: only for the typewriter effect, otherwise show at once.
      useEffect(() => {
        if (!item || item.effects !== 'typewriter') return undefined;
        const total = item.text.length;
        const step = Math.max(18, Math.min(45, Math.round(1400 / Math.max(1, total))));
        setRevealState({ id: item.id, n: 0 });
        const timer = window.setInterval(() => {
          setRevealState((current) => {
            if (current.id !== item.id) return { id: item.id, n: 1 };
            if (current.n >= total) {
              window.clearInterval(timer);
              return current;
            }
            return { id: item.id, n: current.n + 1 };
          });
        }, step);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [item && item.id, item && item.effects, item && item.text]);

      // Observable completion, so a test can prove the reveal really ran.
      useEffect(() => {
        if (item && item.effects === 'typewriter' && item.text.length > 0 && revealed >= item.text.length) {
          reportClientEvent('typewriter-done', { id: item.id });
          // No audio to wait for: close three seconds after the last character.
          if (isProactive(item) && !item.audioUrl) scheduleHide(PROACTIVE_CLOSE_MS);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [revealed, item && item.id, item && item.effects, item && item.text, item && item.proactive, item && item.audioUrl]);

      const play = () => {
        if (!item || !item.audioUrl) {
          if (item) reportClientEvent('silent', { id: item.id });
          return;
        }
        if (audioRef.current) {
          try {
            audioRef.current.pause();
          } catch {
            /* ignore */
          }
        }
        const audio = new window.Audio(item.audioUrl);
        audio.volume = typeof item.volume === 'number' ? Math.min(Math.max(item.volume, 0), 1) : 0.9;
        audioRef.current = audio;
        // The bubble lives as long as the line is being spoken: hiding it first
        // would cut the last syllables.
        window.clearTimeout(hideTimer.current);
        window.clearTimeout(capTimer.current);
        const startedAt = Date.now();
        audio.addEventListener('ended', () => {
          reportClientEvent('ended', { id: item.id, ms: Date.now() - startedAt });
          scheduleHide(isProactive(item) ? PROACTIVE_CLOSE_MS : 700);
        }, { once: true });
        audio.addEventListener('error', () => {
          reportClientEvent('audio-error', { id: item.id, detail: String(audio.error?.code ?? '') });
          // The text still deserves a normal reading time even when the clip is gone.
          scheduleHide(isProactive(item) ? PROACTIVE_CLOSE_MS + revealMs(item) : 6000);
        }, { once: true });
        capTimer.current = window.setTimeout(() => {
          try {
            audio.pause();
          } catch {
            /* ignore */
          }
          reportClientEvent('cut', { id: item.id, ms: Date.now() - startedAt });
          scheduleHide(isProactive(item) ? PROACTIVE_CLOSE_MS : 600);
        }, 25_000);
        const promise = audio.play();
        if (promise && typeof promise.play === 'function') {
          /* noop: some browsers return a non-promise */
        }
        if (promise && typeof promise.catch === 'function') {
          promise
            .then(() => reportClientEvent('playing', { id: item.id }))
            .catch(() => {
              reportClientEvent('blocked', { id: item.id });
              scheduleHide(isProactive(item) ? PROACTIVE_CLOSE_MS + revealMs(item) : 6000);
            });
        }
      };

      // Speak the current line. Keyed on id + audio URL: attaching the drag
      // voice must not re-run the show/typewriter effects.
      useEffect(() => {
        if (!item) return undefined;
        play();
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [item && item.id, item && item.audioUrl]);

      // Drag feedback is text-first: the bubble appears as soon as the model
      // answer is ready, then the voice is fetched and attached in place. The
      // bubble never waits for TTS, and a TTS failure keeps the remark text.
      useEffect(() => {
        if (!item || !item.voicePending || item.audioUrl) return undefined;
        const id = item.id;
        let cancelled = false;
        void window
          .fetch('/pet-chatter/speak', {
            method: 'POST',
            headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: item.text }),
          })
          .then((response) => (response.ok ? response.json() : null))
          .then((voice) => {
            if (cancelled) return;
            const ok = Boolean(voice && voice.audioUrl);
            const url = ok ? voice.audioUrl : ALERT_URL;
            setQueue((current) => current.map((entry) => (entry.id === id ? { ...entry, audioUrl: url, voicePending: false } : entry)));
            setNotice(ok ? '' : '语音没合成出来，先放个提示音。');
            if (!ok) noticeForRef.current = id;
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [item && item.id, item && item.voicePending, item && item.audioUrl]);

      // Leaving the page must not keep the audio object alive.
      useEffect(
        () => () => {
          try {
            audioRef.current?.pause();
          } catch {
            /* ignore */
          }
        },
        [],
      );

      const dismiss = () => {
        const dismissedId = item ? item.id : '';
        if (item) reportClientEvent('dismiss', { id: item.id, ms: Date.now() - (shownAt.current || Date.now()) });
        setVisible(false);
        visibleRef.current = false;
        reportBubbleState(false, dismissedId);
        if (replyModeRef.current) {
          replyModeRef.current = false;
          replyContextRef.current = '';
          void window
            .fetch('/pet-chatter/chat/reply-close', {
              method: 'POST',
              headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
              body: '{}',
              keepalive: true,
            })
            .catch(() => {});
        }
        window.clearTimeout(hideTimer.current);
        window.clearTimeout(capTimer.current);
        try {
          audioRef.current?.pause();
        } catch {
          /* ignore */
        }
        setChatOpen(false);
        chatOpenRef.current = false;
        setChatItemId('');
        chatItemIdRef.current = '';
        setChatDraft('');
        setChatPending(false);
        setNotice('');
        // Remove only the bubble that was dismissed: a preempting preview or
        // rewrite may already have replaced it, and slicing blindly would eat
        // the newer item and look like a dead click.
        window.setTimeout(() => {
          setQueue((current) => {
            if (!current.length) return current;
            if (dismissedId && current[0].id !== dismissedId) return current.filter((entry) => entry.id !== dismissedId);
            return current.slice(1);
          });
        }, 500);
      };
      dismissRef.current = dismiss;

      /**
       * Send one message. The host answers with text AND voice together, so the
       * reply replaces the greeting in the same paint the audio starts: no more
       * "text first, sound a few seconds later".
       */
      const sendChat = async (event) => {
        if (event) event.preventDefault();
        const text = chatDraft.trim();
        if (!text || chatPending) return;
        const context = replyContextRef.current || '';
        replyContextRef.current = '';
        setChatPending(true);
        setChatDraft('');
        setNotice('');
        try {
          const response = await window.fetch('/pet-chatter/chat', {
            method: 'POST',
            headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, context }),
          });
          const json = await response.json().catch(() => ({}));
          if (!response.ok || typeof json.reply !== 'string') throw new Error(json.error || 'chat');
          // The user closed the chat while the model was thinking: do not pop a
          // reply bubble they no longer asked for.
          if (!chatOpenRef.current) return;
          const base = queue.find((entry) => entry.id === chatItemIdRef.current) || queue[0] || {};
          const now = Date.now();
          const next = {
            ...base,
            id: `chat-${now}`,
            text: json.reply,
            quote: '',
            why: '',
            mood: '开心',
            kind: 'chat',
            manualReply: true,
            effects: pickOne(base.effects, ['none', 'soft', 'lively', 'typewriter'], 'soft'),
            frame: pickOne(base.frame, ['card', 'glass', 'outline', 'paper', 'neon', 'comic', 'native'], 'card'),
            anchor: base.anchor === 'corner' ? 'corner' : 'pet',
            audioUrl: json.audioUrl || (json.voiceFailed ? ALERT_URL : null),
            stickerUrl: null,
            volume: typeof base.volume === 'number' ? base.volume : 0.9,
            createdAt: now,
            expiresAt: now + 10 * 60_000,
          };
          setQueue([next]);
          chatItemIdRef.current = next.id;
          setChatItemId(next.id);
          setChatOpen(true);
          chatOpenRef.current = true;
          setVisible(true);
          visibleRef.current = true;
          reportBubbleState(true, next.id);
          if (json.voiceFailed) setNoticeFor('语音没合成出来，先放个提示音。', next.id);
          scheduleHide(120_000);
        } catch {
          setNotice('呜…我这会儿连不上模型。');
          scheduleHide(30_000);
        } finally {
          setChatPending(false);
        }
      };

      const closeChat = () => {
        chatOpenRef.current = false;
        chatItemIdRef.current = '';
        setChatOpen(false);
        setChatItemId('');
        setChatDraft('');
        setChatPending(false);
      };

      /** Open the chat under the proactive bubble, keeping its text as context. */
      const replyToBubble = () => {
        if (!item) return;
        replyModeRef.current = true;
        replyContextRef.current = item.text;
        chatOpenRef.current = true;
        chatItemIdRef.current = item.id;
        setChatOpen(true);
        setChatItemId(item.id);
        setChatDraft('');
        setChatPending(false);
        setNotice('');
        setVisible(true);
        visibleRef.current = true;
        reportBubbleState(true, item.id);
        reportClientEvent('reply-open', { id: item.id });
        scheduleHide(120_000);
      };

      /**
       * Long-press / 💬 opens the chat. The greeting is created by the host so it
       * carries exactly the configured frame, effects, anchor and volume; the
       * local placeholder only covers the few milliseconds before that arrives.
       */
      const openManualChat = () => {
        const now = Date.now();
        const base = queue[0] || {};
        const fallback = {
          ...base,
          id: `manual-${now}`,
          text: '我在，老大想聊什么？',
          quote: '',
          why: '',
          mood: '开心',
          kind: 'chat',
          effects: pickOne(base.effects, ['none', 'soft', 'lively', 'typewriter'], 'soft'),
          frame: pickOne(base.frame, ['card', 'glass', 'outline', 'paper', 'neon', 'comic', 'native'], 'card'),
          anchor: base.anchor === 'corner' ? 'corner' : 'pet',
          audioUrl: null,
          stickerUrl: null,
          volume: typeof base.volume === 'number' ? base.volume : 0.9,
          createdAt: now,
          expiresAt: now + 10 * 60_000,
        };
        setQueue([fallback]);
        setVisible(true);
        visibleRef.current = true;
        reportBubbleState(true, fallback.id);
        setChatOpen(true);
        chatOpenRef.current = true;
        setChatItemId(fallback.id);
        chatItemIdRef.current = fallback.id;
        setChatDraft('');
        setChatPending(false);
        setNotice('');
        scheduleHide(120_000);
        reportClientEvent('manual-chat', { id: fallback.id });
        void window
          .fetch('/pet-chatter/manual/hello', {
            method: 'POST',
            headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
            body: '{}',
          })
          .then((response) => (response.ok ? response.json() : null))
          .then((json) => {
            const item = json && json.item;
            if (!item) return;
            // The chat may have been closed while the greeting was in flight.
            if (!chatOpenRef.current) return;
            // Only replace the placeholder: a fast reply may already be on screen.
            setQueue((current) => (current[0] && current[0].id === fallback.id ? [item] : current));
            chatItemIdRef.current = item.id;
            setChatItemId(item.id);
            if (chatItemIdRef.current === item.id) {
              void window
                .fetch('/pet-chatter/speak', {
                  method: 'POST',
                  headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: item.text }),
                })
                .then((response) => (response.ok ? response.json() : null))
                .then((voice) => {
                  // A reply may already have replaced the greeting; its own
                  // audio is playing, so do not talk over it.
                  if (chatItemIdRef.current !== item.id) return;
                  // A failed greeting voice still gets the bundled alert clip:
                  // a silent greeting reads as "the mic is broken".
                  const url = voice && voice.audioUrl ? voice.audioUrl : ALERT_URL;
                  const audio = new window.Audio(url);
                  audio.volume = Math.min(Math.max(Number(item.volume) || 0.9, 0), 1);
                  audioRef.current = audio;
                  if (!voice || !voice.audioUrl) setNoticeFor('语音没合成出来，先放个提示音。', item.id);
                  void audio.play().catch(() => {});
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      };
      openManualRef.current = openManualChat;

      // Bind on the pet itself (same document) or inside the pet iframe, which
      // is same-origin, so a right-click works before any bubble exists.
      // The sticker pet broadcasts its gestures on `core-pet-v1`; every window
      // listener sees them, so the bubble can react to being petted or dragged
      // without modifying the sticker plugin or touching its iframe.
      useEffect(() => {
        let reportedShape = false;
        const onMessage = (event) => {
          const frame = findPetFrame();
          if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return;
          let origin;
          try {
            origin = new URL(frame.src).origin;
          } catch {
            return;
          }
          if (event.origin !== origin) return;
          const data = event.data;
          if (!data || data.channel !== 'core-pet-v1') return;
          if (data.type === 'status') {
            if (data.status && typeof data.status.action === 'string') {
              lastPetActionRef.current = data.status.action;
            }
            return;
          }
          if (data.type !== 'drag') return;
          if (data.phase === 'start' && !reportedShape) {
            reportedShape = true;
            reportClientEvent('pet-drag-shape', { detail: JSON.stringify(data).slice(0, 180) });
          }
          if (data.phase === 'start') {
            petGestureRef.current = { moved: false, startedAt: Date.now() };
            return;
          }
          if (data.phase === 'move' && petGestureRef.current) {
            petGestureRef.current.moved = true;
            return;
          }
          if (data.phase !== 'end' && data.phase !== 'cancel') return;
          const gesture = petGestureRef.current;
          petGestureRef.current = null;
          if (!gesture) return;
          if (data.phase === 'end' && !gesture.moved) {
            // A long press opens the chat; a quick tap always fires the local
            // click reaction. The server's shared bubble gate is the only
            // pacing rule, so a tap is never silently dropped client-side.
            if (Date.now() - (gesture.startedAt || Date.now()) >= 700) {
              openManualRef.current();
              return;
            }
            const now = Date.now();
            if (now - petTapAtRef.current < 500) return;
            petTapAtRef.current = now;
            // A bubble that is still visible owns the screen; do not replace it.
            if (visibleRef.current) return;
            // Leave the tap animation to the pet itself: it has its own tap
            // counter/reaction, and forcing `happy` on every click made every
            // tap look identical.
            void window
              .fetch('/pet-chatter/click', {
                method: 'POST',
                headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: lastPetActionRef.current || '' }),
              })
              .then((response) => (response.ok ? response.json() : null))
              .then((json) => {
                if (json && json.ok) wakeRef.current();
              })
              .catch(() => {});
          } else if (data.phase === 'end' && gesture.moved) {
            const now = Date.now();
            // Only debounce duplicate end events; the server owns the gap.
            // Let the pet play its own drag/release reaction instead of forcing
            // `curious`, so click and drag both keep the native variety.
            if (now - petDragRequestAtRef.current < 500) return;
            petDragRequestAtRef.current = now;
            if (visibleRef.current) return;
            const petEl = findPet();
            const petRect = petEl ? petEl.getBoundingClientRect() : null;
            void window
              .fetch('/pet-chatter/drag', {
                method: 'POST',
                headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: lastPetActionRef.current || '',
                  position: petRect && petRect.width
                    ? {
                        x: petRect.left,
                        y: petRect.top,
                        w: petRect.width,
                        h: petRect.height,
                        vw: window.innerWidth,
                        vh: window.innerHeight,
                      }
                    : null,
                }),
              })
              .then((response) => (response.ok ? response.json() : null))
              .then((json) => {
                if (json && json.ok) wakeRef.current();
              })
              .catch(() => {});
          }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // Keyboard fallback for the chat entry: Alt+Shift+P works even when the
      // pet is dragged somewhere awkward.
      useEffect(() => {
        const onKey = (event) => {
          if (!event.altKey || !event.shiftKey) return;
          if (String(event.key || '').toLowerCase() !== 'p') return;
          event.preventDefault();
          openManualRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      useEffect(() => {
        const handler = (event) => {
          event.preventDefault();
          event.stopPropagation();
          openManualRef.current();
        };
        let boundPet = null;
        let boundDoc = null;
        const bind = (doc) => {
          if (!doc || boundDoc === doc) return;
          try {
            boundDoc?.removeEventListener('contextmenu', handler);
            const pet = doc.querySelector('[data-nekowhale-pet]') || doc.body;
            if (!pet) return;
            pet.addEventListener('contextmenu', handler);
            boundDoc = doc;
            boundPet = pet;
          } catch {
            /* cross-origin frame: no way in */
          }
        };
        const attach = () => {
          const pet = document.querySelector('[data-nekowhale-pet]');
          if (pet) {
            if (boundPet !== pet) {
              boundPet?.removeEventListener('contextmenu', handler);
              pet.addEventListener('contextmenu', handler);
              boundPet = pet;
            }
            return;
          }
          const frame = document.querySelector('iframe[src*="pet.html"]');
          if (frame) bind(frame.contentDocument);
        };
        attach();
        const timer = window.setInterval(attach, 1500);
        return () => {
          window.clearInterval(timer);
          boundPet?.removeEventListener('contextmenu', handler);
          boundDoc?.removeEventListener('contextmenu', handler);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const togglePanel = () => {
        const next = !panelOpen;
        panelOpenRef.current = next;
        setPanelOpen(next);
        if (next) {
          scheduleHide(600_000);
        }
      };

      const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('button, input, textarea, form, .pc-sticker')) return;
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          dx: offsetRef.current.dx || 0,
          dy: offsetRef.current.dy || 0,
          moved: false,
        };
        try {
          cardRef.current?.setPointerCapture?.(event.pointerId);
        } catch {
          /* ignore */
        }
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const mx = event.clientX - drag.x;
        const my = event.clientY - drag.y;
        if (!drag.moved && Math.abs(mx) + Math.abs(my) < 5) return;
        drag.moved = true;
        offsetRef.current = { dx: Math.round(drag.dx + mx), dy: Math.round(drag.dy + my) };
        place();
      };

      const onPointerUp = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        try {
          cardRef.current?.releasePointerCapture?.(event.pointerId);
        } catch {
          /* ignore */
        }
        if (drag.moved) writeStored(OFFSET_KEY, offsetRef.current);
      };

      const panelNode = panelOpen
        ? h(
            'div',
            { key: 'panel', className: 'pc-panel', role: 'dialog', 'aria-label': '大肥鱼吐槽设置' },
            h('style', null, PANEL_CSS),
            h(
              'div',
              { className: 'pc-panel-head' },
              h('span', { className: 'pc-panel-title' }, '大肥鱼吐槽 · 设置'),
              h('button', { type: 'button', className: 'pc-panel-close', title: '关闭设置', onClick: togglePanel }, '×'),
            ),
            h('div', { className: 'pc-panel-body' }, h(Settings)),
          )
        : null;

      // The styles live inside the card; without a bubble they must still be
      // present so the settings panel keeps its styling.
      if (!item) return [h('style', { key: 'pc-css' }, CSS), panelNode].filter(Boolean);

      const style = box
        ? {
            left: `${box.left}px`,
            top: `${box.top}px`,
            ...(typeof box.tailX === 'number' ? { '--pc-tail-x': `${box.tailX}px` } : {}),
          }
        : { left: '8px', top: '8px', opacity: 0 };
      const lively = item.effects === 'lively';
      const plain = item.effects === 'none';
      const revealRtl = Boolean(box && box.rtl);
      const className = [
        'pc-bubble',
        visible ? 'is-visible' : '',
        box && box.flip ? 'is-flip' : '',
        plain ? 'is-plain' : '',
        lively ? 'is-lively' : '',
        dragRef.current ? 'is-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const sparks = lively
        ? SPARKS.map((spark, index) =>
            h('span', {
              key: `${item.id}-spark-${index}`,
              className: 'pc-spark',
              'aria-hidden': 'true',
              style: {
                left: `${spark.left}px`,
                top: `${spark.top}px`,
                '--pc-dx': `${spark.dx}px`,
                '--pc-dy': `${spark.dy}px`,
                '--pc-delay': `${spark.delay}ms`,
              },
            }, spark.glyph),
          )
        : null;

      const kindLabel = {
        idea: '💡 鬼点子',
        roast: '😼 吐槽',
        comfort: '🥺 安慰',
        idle: '🐋 主动搭话',
        bedtime: '🌙 该睡了',
        alert: '🔇 音频提醒',
        chat: '💬 聊天',
        click: '🐋 戳一下',
        drag: '🫳 拖动',
      }[item.kind];
      const canReply = ['idea', 'roast', 'comfort', 'idle', 'bedtime', 'comment'].includes(item.kind);

      const card = h(
        'div',
        {
          // Keyed by the item so the pop animation and revealing caret restart
          // for every new bubble instead of only the first one.
          key: item.id,
          ref: cardRef,
          className,
          'data-frame': item.frame || 'card',
          'data-reply': canReply ? '1' : undefined,
          style,
          role: 'status',
          'aria-live': 'polite',
          onPointerEnter: () => {
            hoveredRef.current = true;
          },
          onPointerLeave: () => {
            hoveredRef.current = false;
          },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onDoubleClick: (event) => {
            const target = event.target;
            if (target && typeof target.closest === 'function' && target.closest('button')) return;
            offsetRef.current = { dx: 0, dy: 0 };
            writeStored(OFFSET_KEY, offsetRef.current);
            place();
          },
        },
        h('style', null, CSS),
        sparks,
        h('button', {
          type: 'button',
          className: 'pc-dismiss',
          title: '关掉这条',
          'aria-label': '关掉这条',
          onClick: dismiss,
        }, '×'),
        canReply
          ? h('button', {
              type: 'button',
              className: 'pc-reply',
              title: '回复这条',
              'aria-label': '回复这条',
              onClick: replyToBubble,
            }, '↩')
          : null,
        item.stickerUrl
          ? h('img', {
              className: 'pc-sticker',
              src: item.stickerUrl,
              alt: '',
              draggable: false,
              title: '点一下复制这个表情的链接',
              onClick: async (event) => {
                event.stopPropagation();
                try {
                  const absolute = new URL(item.stickerUrl, window.location.href).href;
                  await navigator.clipboard.writeText(absolute);
                  setNotice('这个浏览器不让复制');
                } catch {
                  setNotice('这个浏览器不让复制');
                }
                window.setTimeout(() => setNotice(''), 2500);
              },
            })
          : null,
        h(
          'div',
          { className: 'pc-body' },
          kindLabel ? h('span', { className: 'pc-kind', title: item.why || '' }, kindLabel) : null,
          // A .wav means the Edge voice was unavailable and Windows' own (much
          // more robotic) voice spoke instead: say so instead of letting the
          // human wonder why it sounds like a newsreader.
          typeof item.audioUrl === 'string' && item.audioUrl.endsWith('.wav')
            ? h('span', { className: 'pc-kind', title: '当前设置使用的是 Windows 本地语音' }, '本地语音')
            : null,
          item.quote ? h('div', { className: 'pc-quote' }, `「${item.quote}」`) : null,
          notice ? h('div', { className: 'pc-notice' }, notice) : null,
          h('div', { className: 'pc-text' },
            item.effects === 'typewriter'
              ? h('span', { className: 'pc-text-stack' },
                  // Invisible full text: it reserves the final line breaks and
                  // bubble size before the first character appears.
                  h('span', { className: 'pc-text-ghost', 'aria-hidden': 'true' }, item.text),
                  h('span', { className: `pc-text-live${revealRtl ? ' is-rtl' : ''}` },
                    item.text.slice(0, revealed),
                    revealed < item.text.length
                      ? h('span', { className: 'pc-caret', 'aria-hidden': 'true' }, '▍')
                      : null))
              : item.text),
          chatPending ? h('div', { className: 'pc-chat-pending' }, '在想') : null,
          chatOpen && chatItemId === item.id
            ? h('form', { className: 'pc-chat', onSubmit: sendChat },
                h('input', {
                  className: 'pc-chat-input',
                  value: chatDraft,
                  maxLength: 120,
                  placeholder: chatPending ? '等大肥鱼说完…' : '跟大肥鱼说句话…',
                  'aria-label': '和大肥鱼聊天',
                  autoFocus: true,
                  disabled: chatPending,
                  onChange: (event) => setChatDraft(event.target.value),
                }),
                h('button', { type: 'submit', className: 'pc-chat-send', disabled: chatPending }, chatPending ? '…' : '发送'),
              )
            : null,
        ),
        h('span', { className: 'pc-tail', 'aria-hidden': 'true' }),
      );

      // A plain array keeps this component free of `React.Fragment`, which is not
      // guaranteed to exist on every host's React namespace.
      return [card, panelNode].filter(Boolean);
    }

    const MY_VERSION = 'bubble-83';

    const PANEL_CSS = `
      .pc-panel { position: fixed; z-index: 2147483002; right: 16px; top: 56px; width: min(430px, 92vw); max-height: 72vh;
        display: flex; flex-direction: column; border-radius: 14px; overflow: hidden; pointer-events: auto;
        background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, #1f2328);
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); box-shadow: 0 18px 48px rgba(20, 30, 60, 0.22); }
      .pc-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
        background: var(--dsw-alias-bg-layer-1, #f7f8fb); font-size: 13px; font-weight: 600; }
      .pc-panel-close { border: 0; background: transparent; color: inherit; font-size: 16px; line-height: 1; cursor: pointer;
        opacity: 0.6; padding: 2px 6px; border-radius: 6px; }
      .pc-panel-close:hover { opacity: 1; background: var(--dsw-alias-bg-layer-2, rgba(120, 160, 255, 0.12)); }
      .pc-panel-body { padding: 10px 14px 16px; overflow: auto; }
    `;

    const VOICE_LABELS = {
      'zh-CN-XiaoyiNeural': '晓伊 · 少女',
      'zh-CN-XiaoxiaoNeural': '晓晓 · 温柔',
      'zh-CN-XiaoxiaoMultilingualNeural': '晓晓 · 多语',
      'zh-CN-YunxiNeural': '云希 · 少年',
      'zh-CN-YunyangNeural': '云扬 · 播音男声',
      'zh-CN-YunjianNeural': '云健 · 解说男声',
      'zh-CN-liaoning-XiaobeiNeural': '小北 · 东北话',
      'zh-CN-shaanxi-XiaoniNeural': '小妮 · 陕西话',
      'zh-TW-HsiaoChenNeural': '曉臻 · 台湾',
      'zh-TW-HsiaoYuNeural': '曉雨 · 台湾',
      'zh-HK-HiuMaanNeural': '曉曼 · 粤语',
      'zh-HK-WanLungNeural': '雲龍 · 粤语男声',
    };
    const PERSONALITY_LABELS = {
      balance: '机灵小鲸鱼',
      tease: '毒舌小恶魔',
      clingy: '黏人精',
      gremlin: '捣蛋鬼',
      zen: '摸鱼哲学家',
      hype: '捧场王',
      random: '随机混搭',
    };
    const FREQ_LABELS = { rare: '偶尔', normal: '适中', often: '经常' };
    const TTS_LABELS = { auto: '自动（只用 Edge 神经语音）', edge: '只用 Edge', sapi: '只用系统语音', off: '不发声' };
    const EFFECTS_LABELS = { none: '无', soft: '柔和', lively: '活泼（星屑 + 弹跳）', typewriter: '打字机（逐字浮现）' };
    const ANCHOR_LABELS = { pet: '贴大肥鱼右上角', corner: '固定在屏幕右下角' };
    const FRAME_LABELS = {
      card: '奶白卡片',
      glass: '玻璃拟态',
      outline: '线框',
      paper: '便签纸',
      neon: '霓虹',
      comic: '漫画',
      native: '原生风（手写体 / 白底 / 贴头）',
    };

    const SETTINGS_CSS = `
      .pc-set { display: flex; flex-direction: column; gap: 10px; padding: 6px 2px 28px;
        font-size: 13px; color: var(--dsw-alias-label-primary, #1f2328); max-width: 720px; }
      .pc-set-title { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
      .pc-set-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); margin: 0 0 6px; }
      .pc-set-group { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b7280);
        margin: 14px 0 2px; letter-spacing: 0.02em; }
      .pc-set-row { display: flex; align-items: center; gap: 12px; min-height: 30px; }
      .pc-set-label { flex: 0 0 112px; color: var(--dsw-alias-label-secondary, #6b7280); }
      .pc-set-control { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
      .pc-set-input { height: 28px; border-radius: 7px; padding: 0 8px; font: inherit;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12));
        background: var(--dsw-alias-bg-layer-1, #f7f8fb); color: inherit; min-width: 0; }
      .pc-set-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
      .pc-set-range { flex: 1; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
      .pc-set-num { width: 52px; text-align: right; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; }
      .pc-set-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
      .pc-set-history { font-size: 12.5px; opacity: 0.85; white-space: normal; word-break: break-word; }
      .pc-set-json { width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px; line-height: 1.5; padding: 8px; border-radius: 8px; resize: vertical;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12));
        background: var(--dsw-alias-bg-layer-1, #f7f8fb); color: inherit; }
      .pc-set-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
      .pc-set-btn { height: 30px; padding: 0 12px; border-radius: 8px; font: inherit; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12));
        background: var(--dsw-alias-bg-overlay, #fff); color: inherit; }
      .pc-set-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(120,160,255,0.12)); }
      .pc-set-btn.primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
      .pc-set-btn.primary:hover { background: #3f5ae0; }
      .pc-set-btn:disabled { opacity: 0.55; cursor: default; }
      .pc-set-banner { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-radius: 8px;
        background: rgba(255, 186, 66, 0.16); border: 1px solid rgba(255, 186, 66, 0.45); font-size: 12px; }
      .pc-set-status { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); min-height: 16px; }
    `;

    function Settings() {
      const [data, setData] = useState(null);
      const [form, setForm] = useState(null);
      const [status, setStatus] = useState('');
      const [busy, setBusy] = useState(false);
      const [draftJson, setDraftJson] = useState('');
      const [historyAll, setHistoryAll] = useState(false);

      const load = async () => {
        try {
          const response = await window.fetch('/pet-chatter/settings', {
            headers: { 'x-pet-chatter': '1' },
            cache: 'no-store',
          });
          const json = await response.json();
          setData(json);
          setForm({ ...json.effective });
          setDraftJson(JSON.stringify(json.overrides || {}, null, 2));
        } catch {
          setStatus('读取设置失败，稍后重试');
        }
      };

      useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const response = await window.fetch('/pet-chatter/settings', {
              headers: { 'x-pet-chatter': '1' },
              cache: 'no-store',
            });
            const json = await response.json();
            if (!alive) return;
            setData(json);
            setForm({ ...json.effective });
            setDraftJson(JSON.stringify(json.overrides || {}, null, 2));
          } catch {
            if (alive) setStatus('读取设置失败，稍后重试');
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      // Keep the panel honest about the running build: the host knows which
      // client version it serves, so a stale page can say so instead of silently
      // running old code. Reloading is always the human's call — an automatic
      // reload would cut the reply that is streaming at that moment.
      useEffect(() => {
        const timer = window.setInterval(() => {
          void window
            .fetch('/pet-chatter/settings', { headers: { 'x-pet-chatter': '1' }, cache: 'no-store' })
            .then((response) => response.json())
            .then((json) => setData(json))
            .catch(() => {});
        }, 20_000);
        return () => window.clearInterval(timer);
      }, []);

      const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

      const post = async (path, body) => {
        const response = await window.fetch(path, {
          method: 'POST',
          headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(json.error || `http-${response.status}`);
        return json;
      };

      const flash = (message) => {
        setStatus(message);
        window.setTimeout(() => setStatus((current) => (current === message ? '' : current)), 2600);
      };

      const save = async () => {
        if (!form || busy) return;
        setBusy(true);
        setStatus('保存中…');
        try {
          const json = await post('/pet-chatter/settings', { patch: form });
          setData(json);
          setForm({ ...json.effective });
          setDraftJson(JSON.stringify(json.overrides || {}, null, 2));
          flash('已保存，立即生效');
        } catch (error) {
          flash(`保存失败：${error.message}`);
        } finally {
          setBusy(false);
        }
      };

      const reset = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const json = await post('/pet-chatter/settings', { reset: true });
          setData(json);
          setForm({ ...json.effective });
          setDraftJson('{}');
          flash('已恢复默认');
        } catch (error) {
          flash(`重置失败：${error.message}`);
        } finally {
          setBusy(false);
        }
      };

      const preview = async () => {
        if (!form) return;
        flash('正在想…');
        try {
          const json = await post('/pet-chatter/preview', { voice: form.voice, rate: form.rate, pitch: form.pitch });
          const audio = new window.Audio(json.audioUrl);
          audio.volume = Math.min(Math.max(form.volume, 0), 1);
          void audio.play().catch(() => {});
          const label = VOICE_LABELS[json.voice] || json.voice;
          flash(json.engine === 'sapi' ? `试听：${label}（Edge 不可用，已降级系统语音）` : `试听：${label}`);
        } catch (error) {
          flash(`试听失败：${error.message}`);
        }
      };

      const sayNow = async () => {
        flash('正在想…');
        try {
          const json = await post('/pet-chatter/test?preempt=1');
          if (json && json.item && json.item.text) flash(`它说：${json.item.text}`);
          else flash('这次没想出来，再试一次');
        } catch (error) {
          flash(`生成失败：${error.message}`);
        }
      };

      const importConfig = async () => {
        let parsed;
        try {
          parsed = JSON.parse(draftJson || '{}');
        } catch {
          flash('JSON 解析失败，检查一下格式');
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          flash('JSON 解析失败，检查一下格式');
          return;
        }
        setBusy(true);
        try {
          const json = await post('/pet-chatter/settings', { patch: parsed });
          setData(json);
          setForm({ ...json.effective });
          setDraftJson(JSON.stringify(json.overrides || {}, null, 2));
          flash('已导入并生效');
        } catch (error) {
          flash(`导入失败：${error.message}`);
        } finally {
          setBusy(false);
        }
      };

      const copyConfig = () => {
        try {
          const copy = window.navigator.clipboard && window.navigator.clipboard.writeText(draftJson || '{}');
          if (copy && typeof copy.then === 'function') {
            copy.then(() => flash('配置已复制')).catch(() => flash('浏览器不允许复制'));
          }
        } catch {
          flash('浏览器不允许复制');
        }
      };

      if (!form) {
        return h('div', { className: 'pc-set' }, h('style', null, SETTINGS_CSS),
          h('div', { className: 'pc-set-status' }, status || '加载中…'));
      }

      const options = (data && data.options) || {};
      const personalities = options.personalities || Object.keys(PERSONALITY_LABELS);
      const voices = options.voices || Object.keys(VOICE_LABELS);
      const effects = options.effects || ['none', 'soft', 'lively'];
      const frames = options.frames || Object.keys(FRAME_LABELS);
      const ttsModes = options.tts || ['auto', 'edge', 'sapi', 'off'];
      const trend = data && data.runtime && Array.isArray(data.runtime.trend) ? data.runtime.trend : [];
      const trendText = trend.length > 1 ? ` · 内存 ${Math.min(...trend)}–${Math.max(...trend)} MB` : '';

      const nightBits = [];
      if (data && data.night) {
        const night = data.night;
        if (night.active) nightBits.push('🌙 深夜模式生效中');
        if (night.bedtime) nightBits.push(`催睡 ${night.bedtime}（安静 ${night.quietMinutes ?? 20} 分钟）`);
        if (night.quietUntil && night.quietUntil > Date.now()) {
          nightBits.push(`安静到 ${new Date(night.quietUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
        }
        if (night.bedtimeDay) nightBits.push(`上次催睡 ${night.bedtimeDay}`);
      }

      const gateBits = [];
      if (data && data.gate) {
        const gate = data.gate;
        if (gate.nextAt && gate.nextAt > Date.now()) {
          gateBits.push(`下次自动发言 ≥ ${new Date(gate.nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
        }
        if (gate.maxPerHour > 0 && gate.hourCount >= gate.maxPerHour) gateBits.push('本小时配额已满');
      }
      // "Why didn't it talk?" is the most common mystery; surface the host's own
      // reason instead of leaving the user guessing.
      const SKIP_LABELS = {
        dice: '概率没中',
        gap: '间隔还没到',
        'hour-cap': '本小时说够了',
        'no-poll': '页面当时没在轮询',
        inflight: '还在生成上一条',
        'stale-turn': '上一轮已经过去太久',
        'quiet-until': '催睡后的安静期',
        'quiet-hours': '静音时段内',
        disabled: '总开关关着',
      };
      if (data && data.runtime && data.runtime.lastSkip && SKIP_LABELS[data.runtime.lastSkip]) {
        gateBits.push(`上次没吭声：${SKIP_LABELS[data.runtime.lastSkip]}`);
      }

      const row = (label, control, hint) =>
        h('div', { className: 'pc-set-row' },
          h('span', { className: 'pc-set-label' }, label),
          h('div', { className: 'pc-set-control' }, control,
            hint ? h('span', { className: 'pc-set-hint' }, hint) : null));

      const pick = (key, labels, values) =>
        h('select', {
          className: 'pc-set-input',
          value: form[key],
          onChange: (event) => set(key, event.target.value),
        }, values.map((value) => h('option', { key: value, value }, labels[value] || value)));

      const slider = (key, min, max, step, format) =>
        h('input', {
          className: 'pc-set-range',
          type: 'range',
          min, max, step,
          value: form[key],
          onChange: (event) => set(key, Number(event.target.value)),
        });

      const numberText = (key, placeholder) =>
        h('input', {
          className: 'pc-set-input',
          type: 'text',
          value: form[key],
          placeholder,
          style: { flex: '1' },
          onChange: (event) => set(key, event.target.value),
        });

      const timeLabel = (at) => {
        try {
          return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } catch {
          return '';
        }
      };
      const relTime = (at) => {
        if (!at) return '还没说过';
        const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
        if (minutes < 1) return '刚刚';
        if (minutes < 60) return `${minutes} 分钟前`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} 小时前`;
        return `${Math.round(hours / 24)} 天前`;
      };
      const kindBadge = { idea: '💡 ', roast: '😼 ', comfort: '🥺 ', idle: '🐋 ', bedtime: '🌙 ', drag: '🫳 ', click: '👆 ', chat: '💬 ', comment: '' };
      const historyNodes = data && Array.isArray(data.history) && data.history.length
        ? [
            h('div', { className: 'pc-set-group', key: 'history-title' },
              h('span', null, '最近说过'),
              h('button', {
                type: 'button',
                className: 'pc-set-btn',
                style: { marginLeft: '8px', height: '22px', padding: '0 8px', fontSize: '11.5px' },
                onClick: () => setHistoryAll((value) => !value),
              }, historyAll ? '收起' : `展开全部 ${data.history.length} 条`)),
            ...data.history.slice(0, historyAll ? 12 : 6).map((entry, index) =>
              h('div', { className: 'pc-set-row', key: `history-${index}` },
                h('span', { className: 'pc-set-label' }, timeLabel(entry.at)),
                h('div', { className: 'pc-set-control' },
                  h('span', { className: 'pc-set-history' }, `${kindBadge[entry.kind] || ''}${entry.text}`))),
            ),
          ]
        : [];

      return h('div', { className: 'pc-set' },
        h('style', null, SETTINGS_CSS),
        h('h3', { className: 'pc-set-title' }, '大肥鱼吐槽气泡'),
        h('p', { className: 'pc-set-sub' }, '大肥鱼会看一轮对话，在你宠物的右上角冒泡说一句，并用你选的音色念出来。这里的保存会同步到插件页表单。'),
        data && data.client && data.client.expects && data.client.expects !== MY_VERSION
          ? h('div', { className: 'pc-set-banner' },
              `插件已更新到 ${data.client.expects}，当前页面仍是 ${MY_VERSION}。空闲时点这里重载（会自动续上这次对话）；正在生成回复时请稍等。`,
              h('button', {
                type: 'button',
                className: 'pc-set-btn',
                style: { marginLeft: '8px', height: '22px', padding: '0 8px', fontSize: '11.5px' },
                onClick: () => window.location.reload(),
              }, '重载界面'))
          : null,

        h('div', { className: 'pc-set-group' }, '快捷模式'),
        h('div', { className: 'pc-set-actions', style: { marginTop: 0 } },
          ...(options.presets || []).map((preset) =>
            h('button', {
              key: preset.name,
              type: 'button',
              className: 'pc-set-btn',
              disabled: busy,
              onClick: async () => {
                setBusy(true);
                try {
                  const json = await post('/pet-chatter/preset', { name: preset.name });
                  setData(json);
                  setForm({ ...json.effective });
                  setDraftJson(JSON.stringify(json.overrides || {}, null, 2));
                  flash(`已切换到「${preset.label}」`);
                } catch (error) {
                  flash(`切换失败：${error.message}`);
                } finally {
                  setBusy(false);
                }
              },
            }, preset.label),
          ),
        ),

        h('div', { className: 'pc-set-group' }, '性格'),
        row('总开关', h('input', {
          type: 'checkbox',
          checked: Boolean(form.enabled),
          onChange: (event) => set('enabled', event.target.checked),
        })),
        row('性格', pick('personality', PERSONALITY_LABELS, personalities)),
        row('称呼', numberText('address', '老大')),
        row('额外风格', numberText('persona', '例如：多说成语、爱用颜文字'), '一句话即可'),

        h('div', { className: 'pc-set-group' }, '说话节奏'),
        row('话痨程度', pick('frequency', FREQ_LABELS, options.frequencies || ['rare', 'normal', 'often'])),
        row('鬼点子概率', slider('ideaChance', 0, 1, 0.05), `${Math.round(form.ideaChance * 100)}%`),
        row('吐槽概率', slider('roastChance', 0, 1, 0.05), `${Math.round(form.roastChance * 100)}%`),
        row('最小间隔', slider('minGapMinutes', 0, 30, 1), `${form.minGapMinutes} 分钟`),
        row('每小时上限', slider('maxPerHour', 0, 30, 1), `${form.maxPerHour} 条`),
        row('静音时段', numberText('quietHours', '01:00-08:00'), '留空表示全天可说话'),
        row('空闲搭话', h('input', {
          type: 'checkbox',
          checked: Boolean(form.idleEnabled),
          onChange: (event) => set('idleEnabled', event.target.checked),
        }), '没人聊时它自己找话说'),
        row('空闲阈值', slider('idleMinutes', 1, 120, 1), `${form.idleMinutes} 分钟`),
        row('自动深夜', h('input', {
          type: 'checkbox',
          checked: Boolean(form.nightAuto),
          onChange: (event) => set('nightAuto', event.target.checked),
        }), '到点自动降频、降音量、关空闲搭话'),
        row('深夜时段', numberText('nightHours', '01:00-08:00')),
        row('睡觉提醒', numberText('bedtime', '23:30'), '留空关闭'),
        row('催睡后安静', slider('bedtimeQuietMinutes', 0, 120, 5), `${form.bedtimeQuietMinutes} 分钟`),

        h('div', { className: 'pc-set-group' }, '声音'),
        row('语音引擎', pick('tts', TTS_LABELS, ttsModes)),
        row('音色', pick('voice', VOICE_LABELS, voices)),
        row('语速', numberText('rate', '+8%')),
        row('音高', numberText('pitch', '+15Hz')),
        row('音量', slider('volume', 0, 1, 0.05), `${Math.round(form.volume * 100)}%`),
        row('语音概率', slider('voiceChance', 0, 1, 0.05), `${Math.round(form.voiceChance * 100)}%`),
        row('语气化语速', h('input', {
          type: 'checkbox',
          checked: Boolean(form.expressive),
          onChange: (event) => set('expressive', event.target.checked),
        }), '鬼点子更快更高、安慰更慢更低'),

        h('div', { className: 'pc-set-group' }, '外观'),
        row('气泡位置', pick('anchor', ANCHOR_LABELS, options.anchors || ['pet', 'corner'])),
        row('气泡框', pick('bubbleStyle', FRAME_LABELS, frames), '只换边框和底色，文字、表情和布局不变'),
        row('气泡特效', pick('effects', EFFECTS_LABELS, effects)),
        row('表情概率', slider('stickerChance', 0, 1, 0.05), `${Math.round(form.stickerChance * 100)}%（自动/预览；点击/拖动强制带图）`),
        row('桌宠反应', h('input', {
          type: 'checkbox',
          checked: form.petReactions !== false,
          onChange: (event) => set('petReactions', event.target.checked),
        }), '点一下立刻本地语音回应'),
        row('点击冒泡概率', slider('clickBubbleChance', 0, 1, 0.05), `${Math.round(form.clickBubbleChance * 100)}%（没抽中只做表情反应）`),
        row('拖动反馈', h('input', {
          type: 'checkbox',
          checked: form.dragFeedback !== false,
          onChange: (event) => set('dragFeedback', event.target.checked),
        }), '拖到新位置后冒泡 + 表情 + 本地语音'),
        row('拖动冒泡概率', slider('dragBubbleChance', 0, 1, 0.05), `${Math.round(form.dragBubbleChance * 100)}%（没抽中只做表情反应）`),
        row('动作联动概率', slider('actionBiasChance', 0, 1, 0.05), `${Math.round(form.actionBiasChance * 100)}%（已知动作时偏向对应情绪；未知动作仍完全随机）`),
        row('气泡间隔', slider('bubbleGapSeconds', 0, 300, 5), `${form.bubbleGapSeconds} 秒（主动/点击/拖动共用）`),

        h('div', { className: 'pc-set-group' }, '主动聊天（长按桌宠 0.7 秒）'),
        row('长期记忆', h('input', {
          type: 'checkbox',
          checked: form.chatAgent !== false,
          onChange: (event) => set('chatAgent', event.target.checked),
        }), '独立 agent，重启后仍记得聊过什么'),
        row('思考强度', h('span', { className: 'pc-set-hint' }, '轻量思考（快速）'), '固定最轻档位；模型不支持时自动省略'),
        row('自动压缩阈值', slider('chatCompactPercent', 40, 95, 1), `上下文 ${form.chatCompactPercent}% 时压缩`),
        h('div', { className: 'pc-set-actions', style: { marginTop: '4px' } },
          h('button', {
            type: 'button',
            className: 'pc-set-btn',
            disabled: busy,
            title: '把当前聊天压缩成一段长期记忆，然后换一个干净的新会话继续',
            onClick: async () => {
              setBusy(true);
              try {
                const json = await post('/pet-chatter/chat/compact', { force: true });
                if (json?.ok) {
                  setData((previous) => ({ ...previous, chat: json.chat }));
                  flash(`记忆已压缩（${json.chat?.summaryChars || 0} 字）`);
                } else {
                  flash('还没有可压缩的聊天');
                }
              } catch (error) {
                flash(`压缩失败：${error.message}`);
              } finally {
                setBusy(false);
              }
            },
          }, '立即压缩聊天记忆'),
        ),

        h('div', { className: 'pc-set-group' },
          data && Array.isArray(data.memory) && data.memory.length
            ? `它记住的事（${data.memory.length}/12）`
            : '它记住的事'),
        data && Array.isArray(data.memory) && data.memory.length
          ? [
              ...data.memory.map((fact, index) =>
                h('div', { className: 'pc-set-row', key: `memory-${index}` },
                  h('span', { className: 'pc-set-label' }, `#${index + 1}`),
                  h('div', { className: 'pc-set-control' },
                    h('span', { className: 'pc-set-history' }, fact),
                    h('button', {
                      type: 'button',
                      className: 'pc-set-btn',
                      style: { height: '22px', padding: '0 7px', fontSize: '11px', flex: 'none' },
                      title: '忘掉这条',
                      disabled: busy,
                      onClick: async () => {
                        try {
                          const json = await post('/pet-chatter/memory', { action: 'remove', text: fact });
                          setData((previous) => ({ ...previous, memory: json.memory }));
                          flash('已经忘掉这条');
                        } catch (error) {
                          flash(`删除失败：${error.message}`);
                        }
                      },
                    }, '✕'))),
              ),
              h('div', { className: 'pc-set-actions', style: { marginTop: '6px' } },
                h('button', {
                  type: 'button',
                  className: 'pc-set-btn',
                  disabled: busy,
                  onClick: async () => {
                    try {
                      const json = await post('/pet-chatter/memory', { action: 'clear' });
                      setData((previous) => ({ ...previous, memory: json.memory }));
                      flash('记忆已清空');
                    } catch (error) {
                      flash(`清空失败：${error.message}`);
                    }
                  },
                }, '清空记忆'),
              ),
            ]
          : h('div', { className: 'pc-set-hint' }, '还没记住什么。在气泡里说「记住：你喜欢冰美式」就行。'),

        h('div', { className: 'pc-set-group' }, '配置'),
        h('textarea', {
          className: 'pc-set-json',
          rows: 4,
          value: draftJson,
          spellCheck: false,
          placeholder: '{"personality":"gremlin","effects":"lively"}',
          onChange: (event) => setDraftJson(event.target.value),
        }),
        h('div', { className: 'pc-set-actions' },
          h('button', { type: 'button', className: 'pc-set-btn', disabled: busy, onClick: copyConfig }, '复制配置'),
          h('button', { type: 'button', className: 'pc-set-btn', disabled: busy, onClick: importConfig }, '导入配置'),
          h('button', { type: 'button', className: 'pc-set-btn', disabled: busy, onClick: () => setDraftJson(JSON.stringify(form, null, 2)) }, '填入当前设置'),
        ),

        h('div', { className: 'pc-set-actions' },
          h('button', { type: 'button', className: 'pc-set-btn primary', disabled: busy, onClick: save }, '保存'),
          h('button', { type: 'button', className: 'pc-set-btn', disabled: busy, onClick: preview }, '试听音色'),
          h('button', {
            type: 'button',
            className: 'pc-set-btn',
            disabled: busy,
            onClick: async () => {
              try {
                await post('/pet-chatter/say', {
                  text: '这就是气泡的效果预览～',
                  speak: false,
                  effects: form.effects,
                  frame: form.bubbleStyle,
                  anchor: form.anchor,
                  force: true,
                  preempt: true,
                });
                flash('已把它叫出来（不发声）');
              } catch (error) {
                flash(`预览失败：${error.message}`);
              }
            },
          }, '预览气泡'),
          h('button', { type: 'button', className: 'pc-set-btn', disabled: busy, onClick: sayNow }, '现在来一句'),
          h('button', { type: 'button', className: 'pc-set-btn', disabled: busy, onClick: reset }, '恢复默认'),
          h('button', {
            type: 'button',
            className: 'pc-set-btn',
            disabled: busy,
            onClick: () => {
              try {
                window.localStorage.removeItem(OFFSET_KEY);
                flash('气泡位置已重置');
              } catch {
                flash('浏览器禁止了本地存储');
              }
            },
          }, '重置气泡位置'),
          h('button', { type: 'button', className: 'pc-set-btn', disabled: busy, onClick: () => { void load(); } }, '重新读取'),
        ),
        h('div', { className: 'pc-set-status' }, status),
        ...historyNodes,
        data && data.stats
          ? h('div', { className: 'pc-set-hint' },
              `${data.night && data.night.active ? '🌙 深夜模式生效中 · ' : ''}已生成 ${data.stats.enqueued} 条 · 队列 ${data.stats.queued} · 本小时 ${data.stats.hourCount} 条 · 上次 ${relTime(data.stats.lastRemarkAt)} · 浏览器端 ${data.stats.clientVersion || '未知'}${data.runtime ? ` · 宿主 ${data.runtime.rssMB} MB / 运行 ${Math.round((data.runtime.uptimeSec || 0) / 60)} 分钟${trendText}` : ''}`)
          : null,
        nightBits.length ? h('div', { className: 'pc-set-hint' }, nightBits.join(' · ')) : null,
        data && data.chat
          ? h('div', { className: 'pc-set-hint' },
              `聊天记忆：${data.chat.ready ? `会话 ${data.chat.sessionId}` : '未建立'} · ${data.chat.turns} 轮`
              + (data.chat.contextWindow ? ` · 上下文 ${data.chat.percent}%（${data.chat.usage}/${data.chat.contextWindow}）` : '')
              + (data.chat.compactedAt ? ` · 上次压缩 ${relTime(data.chat.compactedAt)}` : '')
              + (data.chat.error ? ` · 出错：${data.chat.error}` : ''))
          : null,
        data && data.voice
          ? h('div', { className: 'pc-set-hint' },
              data.voice.lastError
                ? `语音：上次失败 ${relTime(data.voice.lastErrorAt)}（${data.voice.lastError}）`
                  + (data.voice.cooldownUntil > Date.now() ? ` · 熔断到 ${timeLabel(data.voice.cooldownUntil)}` : '')
                  + (data.voice.lastOkAt ? ` · 最近成功 ${relTime(data.voice.lastOkAt)}` : '')
                : `语音：最近一次合成 ${relTime(data.voice.lastOkAt)}`)
          : null,
        gateBits.length ? h('div', { className: 'pc-set-hint' }, gateBits.join(' · ')) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const mounted = { version: MY_VERSION, bubble: false, settings: false, bundleConfig: false, pluginsTab: false, errors: [] };
        const report = () => {
          try {
            void window
              .fetch('/pet-chatter/hello', {
                method: 'POST',
                headers: { 'x-pet-chatter': '1', 'Content-Type': 'application/json' },
                body: JSON.stringify(mounted),
              })
              .catch(() => {});
          } catch {
            /* diagnostics only */
          }
        };

        // Liveness ping independent of the overlay: if the bubble ever fails to
        // render, the host must still learn that the page is open, otherwise it
        // stops generating and the pet goes silent for good.
        // Remember keystrokes in editable fields so the bubble never interrupts
        // the human mid-sentence.
        ctx.effect(() => {
          const onKey = (event) => {
            const target = event.target;
            if (!target) return;
            const tag = target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable === true) lastTypingAt = Date.now();
          };
          window.addEventListener('keydown', onKey, true);
          return () => window.removeEventListener('keydown', onKey, true);
        }, 'pet-chatter: typing watch');

        ctx.effect(() => {
          const ping = () => {
            try {
              if (document.visibilityState !== 'visible') return;
              const pet = findPet();
              const rect = pet ? pet.getBoundingClientRect() : null;
              const headers = { 'x-pet-chatter': '1', 'x-pet-chatter-client-id': CLIENT_ID, 'x-pet-chatter-pet': pet ? '1' : '0' };
              headers['x-pet-chatter-env'] = [innerWidth, innerHeight, devicePixelRatio, screenX, screenY, document.visibilityState, document.hasFocus() ? 1 : 0].join(',');
              if (rect && rect.width && rect.height) {
                headers['x-pet-chatter-petrect'] = [rect.left, rect.top, rect.width, rect.height].map((v) => Math.round(v)).join(',');
              }
              void window
                .fetch('/pet-chatter/heartbeat', { headers, cache: 'no-store' })
                .catch(() => {});
            } catch {
              /* best effort */
            }
          };
          ping();
          const timer = window.setInterval(ping, 10_000);
          return () => window.clearInterval(timer);
        }, 'pet-chatter: heartbeat');

        ctx.effect(() => {
          try {
            return ctx.slots.inject('shell.overlay', () => {
              mounted.bubble = true;
              report();
              return ctx.slots.register({ name: 'shell.overlay', id: 'pet-chatter', order: 101, label: '大肥鱼吐槽' }, Bubble);
            });
          } catch (error) {
            mounted.errors.push(`bubble:${error instanceof Error ? error.message : String(error)}`);
            report();
            return undefined;
          }
        }, 'pet-chatter: bubble');

        ctx.effect(() => {
          try {
            return ctx.slots.inject('settings.section', () => {
              mounted.settings = true;
              report();
              return ctx.slots.register({ name: 'settings.section', id: 'pet-chatter', order: 60, label: '大肥鱼吐槽' }, Settings);
            });
          } catch (error) {
            mounted.errors.push(`settings:${error instanceof Error ? error.message : String(error)}`);
            report();
            return undefined;
          }
        }, 'pet-chatter: settings panel');

        // Also mount on the bundle's own page in Plugins, where users look first.
        ctx.effect(() => {
          try {
            return ctx.slots.inject('plugins.bundle.config', () => {
              mounted.bundleConfig = true;
              report();
              return ctx.slots.register({ name: 'plugins.bundle.config', key: '@local/pet-chatter' }, Settings);
            });
          } catch (error) {
            mounted.errors.push(`bundleConfig:${error instanceof Error ? error.message : String(error)}`);
            report();
            return undefined;
          }
        }, 'pet-chatter: bundle config');

        // A dedicated tab on the Plugins settings page: the place a user looking
        // for "the plugin's settings" opens first.
        ctx.effect(() => {
          try {
            return ctx.slots.inject('settings.plugins.tab', () => {
              mounted.pluginsTab = true;
              report();
              return ctx.slots.register(
                { name: 'settings.plugins.tab', id: 'pet-chatter', order: 50, label: '大肥鱼吐槽' },
                Settings,
              );
            });
          } catch (error) {
            mounted.errors.push(`pluginsTab:${error instanceof Error ? error.message : String(error)}`);
            report();
            return undefined;
          }
        }, 'pet-chatter: plugins tab');
      },
    };
  },
});
