// Undo / redo for the editors (map editor, bike editor) by JSON snapshots. get() -> the editable state, set(state) puts a snapshot back.
// note() after every change: changes merge into one action until busy() is false (no drag in progress) and 350 ms pass; now() ends the action at once.
export function makeHistory(get, set, busy = () => false) {
  let last = JSON.stringify(get()), t = 0; const past = [], future = [];
  const now = () => {
    clearTimeout(t); t = 0; const s = JSON.stringify(get()); if (s === last) return;
    past.push(last); if (past.length > 100) past.shift(); future.length = 0; last = s; // in place: step() already holds this array
  };
  const note = () => { clearTimeout(t); t = setTimeout(() => (busy() ? note() : now()), 350); };
  const step = (from, to) => { now(); if (!from.length) return false; to.push(last); last = from.pop(); set(JSON.parse(last)); return true; };
  return { note, now, undo: () => step(past, future), redo: () => step(future, past) };
}
/** Ctrl+Z = undo, Ctrl+Y / Ctrl+Shift+Z = redo. Returns true when the key was one of them. */
export function undoKey(e, h) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (e.code === 'KeyZ' && !e.shiftKey) h.undo(); else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) h.redo(); else return false;
  e.preventDefault(); return true;
}
