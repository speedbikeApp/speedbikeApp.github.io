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

const KEYS = { KeyA: -1, ArrowLeft: -1, KeyD: 1, ArrowRight: 1 };
const ACTION_KEYS = { ShiftLeft: 'boost', ShiftRight: 'boost', Space: 'jump', KeyE: 'ability', KeyQ: 'swap' };

export function initInput() {
  addEventListener('keydown', (e) => {
    if (e.repeat) return; // holding does nothing
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.code !== 'Escape') return; // typing in a menu field
    if (e.code === 'Escape' || e.code === 'KeyP') { if (onPause) onPause(); e.preventDefault(); return; }
    if (onPress) onPress();
    const side = KEYS[e.code];
    if (side) { queue.push({ side, t: performance.now() }); e.preventDefault(); }
    const act = ACTION_KEYS[e.code];
    if (act) { pushAction(act); e.preventDefault(); }
  });
  // pointerdown fires per finger => multi-touch works. Buttons (HUD boost/jump/pause) take priority.
  addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('button, [data-ui]')) return;
    if (onPress) onPress();
    queue.push({ side: e.clientX < innerWidth / 2 ? -1 : 1, t: performance.now() });
  });
  addEventListener('contextmenu', (e) => e.preventDefault());
}
