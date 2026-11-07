import { CFG } from './config.js';

const queue = []; // {side, t}
const actions = []; // {name: 'boost'|'jump'|'ability'|'swap', t}
let onPress = null; // called on any press
let onPause = null; // Esc / P

export function setOnPress(fn) { onPress = fn; }
export function setOnPause(fn) { onPause = fn; }
export function clearQueue() { queue.length = 0; actions.length = 0; }

// Next buffered turn (-1 / +1) or 0. Entries older than the buffer are dropped.
// ready=false (e.g. min turn gap not reached yet) leaves the entry queued for a later tick.
export function popTurn(now, ready = true) {
  while (queue.length && now - queue[0].t > CFG.inputBufferMs) queue.shift();
  return ready && queue.length ? queue.shift().side : 0;
}

// Boost / jump presses (keyboard or HUD buttons). Consumed once per tick by main.
export function pushAction(name) { actions.push({ name, t: performance.now() }); }
export function popAction(now) {
  while (actions.length && now - actions[0].t > CFG.inputBufferMs) actions.shift();
  return actions.length ? actions.shift().name : null;
}

// ---- key bindings: action -> KeyboardEvent.code list (Escape always pauses / backs out and is not rebindable) ----
export const ACTIONS = ['left', 'right', 'boost', 'jump', 'ability', 'swap', 'pause'];
export const ACTION_LABEL = { left: 'Turn Left', right: 'Turn Right', boost: 'Boost', jump: 'Jump', ability: 'Ability', swap: 'Swap ability', pause: 'Pause' };
export const DEFAULT_KEYS = {
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], boost: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'], ability: ['KeyE'], swap: ['KeyQ'], pause: ['KeyP'],
};
export const MAX_SLOTS = 2;
const BAD_CODE = /^(Escape|Tab|Meta.*|OS.*|ContextMenu|F\d+|Unidentified|)$/;
export const bindable = (code) => typeof code === 'string' && code.length <= 24 && !BAD_CODE.test(code);
export const defaultKeys = () => Object.fromEntries(ACTIONS.map((a) => [a, DEFAULT_KEYS[a].slice()]));
export const cloneKeys = (m) => Object.fromEntries(ACTIONS.map((a) => [a, (m[a] || []).slice()]));

// Sanitize a stored map: unknown actions dropped, bad / duplicate codes removed, missing or emptied actions get defaults.
export function validateKeys(raw) {
  const out = {}, used = new Set(), src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const a of ACTIONS) {
    let codes = Array.isArray(src[a]) ? src[a].filter((c) => bindable(c) && !used.has(c)) : [];
    codes = [...new Set(codes)].slice(0, 4);
    if (!codes.length) codes = DEFAULT_KEYS[a].filter((c) => !used.has(c));
    if (!codes.length) codes = DEFAULT_KEYS[a].slice();
    codes.forEach((c) => used.add(c));
    out[a] = codes;
  }
  return out;
}

// Display groups: ShiftLeft + ShiftRight collapse into one "Shift" cap. Each group is an array of codes.
export function groups(codes) {
  const out = [];
  for (const c of codes) {
    if (c === 'ShiftRight' && codes.includes('ShiftLeft')) continue;
    out.push(c === 'ShiftLeft' && codes.includes('ShiftRight') ? ['ShiftLeft', 'ShiftRight'] : [c]);
  }
  return out;
}
export function codeLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return 'Num ' + code.slice(6).replace('Add', '+').replace('Subtract', '-').replace('Multiply', '*').replace('Divide', '/').replace('Decimal', '.');
  const m = { Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', ShiftLeft: 'Shift', ShiftRight: 'Shift',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Enter: 'Enter', Backspace: 'Bksp', CapsLock: 'Caps' };
  return m[code] || code;
}

// Pure rebind. slot = group index to replace, or -1 to add a new slot; code = null removes the slot.
// A code already used by another action is swapped (that action receives the replaced key) or, when nothing was
// replaced, taken from it (refused with reason 'last' if that would leave it with no key). Returns {ok, map, swapped?}.
export function rebind(map, action, slot, code) {
  const m = cloneKeys(map);
  if (!ACTIONS.includes(action)) return { ok: false, map: m, reason: 'unknown' };
  const gs = groups(m[action]);
  if (code === null) { // remove
    if (gs.length <= 1 || !gs[slot]) return { ok: false, map: m, reason: 'last' };
    gs.splice(slot, 1); m[action] = gs.flat(); return { ok: true, map: m };
  }
  if (!bindable(code)) return { ok: false, map: m, reason: 'bad' };
  if (slot < 0 && gs.length >= MAX_SLOTS) return { ok: false, map: m, reason: 'full' };
  const old = slot >= 0 && gs[slot] ? gs[slot] : [];
  if (old.length === 1 && old[0] === code) return { ok: true, map: m };
  let swapped = null;
  for (const other of ACTIONS) {
    if (other === action || !m[other].includes(code)) continue;
    const left = m[other].filter((c) => c !== code);
    if (old.length) { m[other] = [...left, ...old.filter((c) => !left.includes(c))]; swapped = other; }
    else if (left.length) { m[other] = left; swapped = other; }
    else return { ok: false, map: cloneKeys(map), reason: 'last' };
  }
  const own = gs.filter((g, i) => i !== slot && !g.includes(code)); // drop a duplicate within the same action
  if (slot >= 0) own.splice(Math.min(slot, own.length), 0, [code]); else own.push([code]);
  m[action] = own.flat();
  return { ok: true, map: m, swapped };
}

let bindings = defaultKeys(), lookup = new Map();
function rebuild() { lookup = new Map(); for (const a of ACTIONS) for (const c of bindings[a]) lookup.set(c, a); }
rebuild();
export function setBindings(map) { bindings = validateKeys(map); rebuild(); }
export const getBindings = () => cloneKeys(bindings);
export const actionForCode = (code) => (code === 'Escape' ? 'pause' : lookup.get(code) || null);

// Key capture for the rebind UI: while armed the next keydown goes to cb(code) (Escape -> cb(null)) and nothing else sees it.
let capture = null;
export function captureNextKey(cb) { capture = cb; return () => { if (capture === cb) capture = null; }; }
export const isCapturing = () => !!capture;

function doAction(act) {
  if (act === 'left' || act === 'right') queue.push({ side: act === 'left' ? -1 : 1, t: performance.now() });
  else if (act === 'pause') { if (onPause) onPause(); }
  else if (act) pushAction(act);
}

// ---- gamepad (standard mapping), edge-triggered; polled from our own rAF loop (main may also call pollGamepad()) ----
export const GAMEPAD_LAYOUT = [
  ['Turn Left / Right', 'D-pad or left stick, LB / RB'], ['Jump', 'A'], ['Boost', 'X or RT'],
  ['Ability', 'B or Y'], ['Swap ability', 'Back / Select'], ['Pause', 'Start'],
];
const GP = { left: [14, 4], right: [15, 5], jump: [0], boost: [2, 7], ability: [1, 3], swap: [8], pause: [9] };
let padPrev = {}, padLoop = false;
export function pollGamepad() {
  const pads = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : [];
  const now = {};
  for (const p of pads) {
    if (!p || !p.connected) continue;
    const ax = p.axes[0] || 0;
    if (ax < -0.6) now.left = true;
    if (ax > 0.6) now.right = true;
    for (const act of Object.keys(GP)) for (const i of GP[act]) { const b = p.buttons[i]; if (b && (b.pressed || b.value > 0.5)) now[act] = true; }
  }
  for (const act of Object.keys(now)) if (!padPrev[act] && !capture) { if (act !== 'pause' && onPress) onPress(); doAction(act); }
  padPrev = now;
}
function padTick() { pollGamepad(); requestAnimationFrame(padTick); }

export function initInput() {
  // capture phase so a rebind in progress swallows the key before anything else sees it
  addEventListener('keydown', (e) => {
    if (capture) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const cb = capture; capture = null; cb(e.code === 'Escape' ? null : e.code); return;
    }
    if (e.repeat) return; // holding does nothing
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.code !== 'Escape') return; // typing in a menu field
    const act = actionForCode(e.code);
    if (!act) return;
    if (act !== 'pause' && onPress) onPress();
    doAction(act); e.preventDefault();
  }, true);
  addEventListener('keyup', (e) => { if (capture) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  // pointerdown fires per finger => multi-touch works. Buttons (HUD boost/jump/pause) take priority.
  addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('button, [data-ui]')) return;
    if (onPress) onPress();
    queue.push({ side: e.clientX < innerWidth / 2 ? -1 : 1, t: performance.now() });
  });
  addEventListener('contextmenu', (e) => e.preventDefault());
  if (!padLoop && typeof requestAnimationFrame === 'function') { padLoop = true; requestAnimationFrame(padTick); }
}
