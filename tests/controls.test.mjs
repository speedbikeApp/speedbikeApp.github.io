import assert from 'node:assert/strict';
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
const I = await import('../js/input.js');
const S = await import('../js/save.js');
const { ACTIONS, DEFAULT_KEYS, defaultKeys, validateKeys, rebind, groups, codeLabel, setBindings, getBindings, actionForCode } = I;

// defaults
assert.deepEqual(getBindings(), defaultKeys());
assert.equal(actionForCode('KeyA'), 'left'); assert.equal(actionForCode('ArrowRight'), 'right');
assert.equal(actionForCode('ShiftRight'), 'boost'); assert.equal(actionForCode('Space'), 'jump');
assert.equal(actionForCode('Escape'), 'pause'); assert.equal(actionForCode('KeyP'), 'pause'); assert.equal(actionForCode('KeyZ'), null);
assert.deepEqual(groups(DEFAULT_KEYS.boost), [['ShiftLeft', 'ShiftRight']]);
assert.equal(codeLabel('KeyA'), 'A'); assert.equal(codeLabel('ArrowLeft'), '\u2190');
assert.equal(S.parseSave(null).settings.engineVol, 0.3);
assert.deepEqual(S.parseSave(null).settings.keys, defaultKeys());

// validation: unknown dropped, missing -> defaults, junk removed, duplicates across actions removed, Escape refused
let v = validateKeys({ left: ['KeyJ'], bogus: ['KeyX'], jump: [], ability: ['KeyJ', 5, 'Escape', 'F5'], swap: 'KeyZ' });
assert.ok(!('bogus' in v));
assert.deepEqual(v.left, ['KeyJ']); assert.deepEqual(v.right, DEFAULT_KEYS.right); assert.deepEqual(v.jump, ['Space']);
assert.deepEqual(v.ability, DEFAULT_KEYS.ability); assert.deepEqual(v.swap, DEFAULT_KEYS.swap);
assert.deepEqual(validateKeys(null), defaultKeys()); assert.deepEqual(validateKeys([1, 2]), defaultKeys());
const all = Object.values(v).flat(); assert.equal(new Set(all).size, all.length);
// through save.js
const ps = S.parseSave(JSON.stringify({ settings: { engineVol: 7, keys: { left: ['KeyJ'], nope: ['KeyQ'] } } }));
assert.equal(ps.settings.engineVol, 1); assert.deepEqual(ps.settings.keys.left, ['KeyJ']); assert.ok(!('nope' in ps.settings.keys));
assert.deepEqual(ps.settings.keys.right, DEFAULT_KEYS.right);
assert.equal(S.parseSave(JSON.stringify({ settings: { engineVol: -2 } })).settings.engineVol, 0);

// rebind: simple replace of second slot
let r = rebind(defaultKeys(), 'left', 1, 'KeyJ');
assert.ok(r.ok); assert.deepEqual(r.map.left, ['KeyA', 'KeyJ']); assert.equal(r.swapped, null);
// conflict -> swap: put KeyD (right) on left slot 0 => right gets KeyA
r = rebind(defaultKeys(), 'left', 0, 'KeyD');
assert.ok(r.ok); assert.equal(r.swapped, 'right'); assert.deepEqual(r.map.left, ['KeyD', 'ArrowLeft']); assert.deepEqual(r.map.right, ['ArrowRight', 'KeyA']);
// conflict with shift group: jump slot 0 -> ShiftLeft; boost keeps ShiftRight and receives Space
r = rebind(defaultKeys(), 'jump', 0, 'ShiftLeft');
assert.deepEqual(r.map.jump, ['ShiftLeft']); assert.deepEqual(r.map.boost, ['ShiftRight', 'Space']);
// rebind a shift group replaces both codes
r = rebind(defaultKeys(), 'boost', 0, 'KeyB'); assert.deepEqual(r.map.boost, ['KeyB']);
// add slot; clear other when nothing replaced; refuse when it would leave other empty
r = rebind(defaultKeys(), 'jump', -1, 'KeyW'); assert.deepEqual(r.map.jump, ['Space', 'KeyW']);
r = rebind(defaultKeys(), 'jump', -1, 'KeyE'); // ability would be emptied
assert.equal(r.ok, false); assert.equal(r.reason, 'last');
r = rebind(defaultKeys(), 'jump', -1, 'KeyA'); assert.ok(r.ok); assert.deepEqual(r.map.left, ['ArrowLeft']); assert.deepEqual(r.map.jump, ['Space', 'KeyA']);
r = rebind(rebind(defaultKeys(), 'jump', -1, 'KeyW').map, 'jump', -1, 'KeyX'); assert.equal(r.reason, 'full');
// remove slot
r = rebind(defaultKeys(), 'left', 1, null); assert.deepEqual(r.map.left, ['KeyA']);
assert.equal(rebind(defaultKeys(), 'jump', 0, null).ok, false);
// bad keys
assert.equal(rebind(defaultKeys(), 'jump', 0, 'Escape').ok, false); assert.equal(rebind(defaultKeys(), 'jump', 0, 'F5').ok, false);
// every rebind result is a valid, conflict-free map
for (const a of ACTIONS) for (const c of ['KeyA', 'KeyQ', 'Space', 'ShiftLeft', 'KeyP', 'KeyZ']) for (const slot of [-1, 0]) {
  const x = rebind(defaultKeys(), a, slot, c).map, f = Object.values(x).flat();
  assert.equal(new Set(f).size, f.length, `${a} ${c} ${slot}`); assert.deepEqual(validateKeys(x), x);
}
// applying to runtime + reset
setBindings(rebind(defaultKeys(), 'jump', -1, 'KeyW').map); assert.equal(actionForCode('KeyW'), 'jump');
setBindings(defaultKeys()); assert.deepEqual(getBindings(), defaultKeys()); assert.equal(actionForCode('KeyW'), null);
console.log('controls tests ok');
