import assert from 'node:assert/strict';
import { makeHistory, undoKey } from '../js/history.js';

let st = { a: 1 };
const h = makeHistory(() => st, (s) => { st = s; });
assert.equal(h.undo(), false, 'nothing to undo yet');
st = { a: 2 }; h.now(); st = { a: 3 }; h.now();
st = { a: 4 }; // not committed yet: undo commits it first, then steps back
assert.equal(h.undo(), true); assert.deepEqual(st, { a: 3 });
h.undo(); assert.deepEqual(st, { a: 2 }); h.undo(); assert.deepEqual(st, { a: 1 }); assert.equal(h.undo(), false);
h.redo(); assert.deepEqual(st, { a: 2 }); h.redo(); h.redo(); assert.deepEqual(st, { a: 4 }); assert.equal(h.redo(), false);
h.undo(); st = { a: 9 }; h.now(); assert.equal(h.redo(), false, 'a new change drops the redo list');
h.undo(); assert.deepEqual(st, { a: 3 });

// keys
const calls = []; const k = { undo: () => calls.push('u'), redo: () => calls.push('r') };
const ev = (code, o = {}) => ({ code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, ...o });
assert.equal(undoKey(ev('KeyZ'), k), true); undoKey(ev('KeyY'), k); undoKey(ev('KeyZ', { shiftKey: true }), k);
assert.equal(undoKey(ev('KeyZ', { ctrlKey: false }), k), false); assert.equal(undoKey(ev('KeyS'), k), false);
undoKey(ev('', { key: 'z' }), k); // code missing: falls back to key
assert.deepEqual(calls, ['u', 'r', 'r', 'u']);
console.log('history tests passed');
