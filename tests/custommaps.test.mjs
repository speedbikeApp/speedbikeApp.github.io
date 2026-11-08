// Custom maps in single-player: registry from /maps (cache + offline), pools per mode, spMap kept/fallback, validation of modes.
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const C = await import('../js/custommaps.js'), M = await import('../js/modes.js'), S = await import('../js/save.js'), D = await import('../js/mapdef.js');

const def = (name, extra = {}) => ({ name, half: 36, killY: -14, platforms: [{ x0: -30, z0: -30, x1: 30, z1: 30, y: 0 }],
  spawns: [{ x: 0, z: 18, dx: 0, dz: -1 }, { x: -18, z: 0, dx: 1, dz: 0 }, { x: 0, z: -18, dx: 0, dz: 1 }, { x: 18, z: 0, dx: -1, dz: 0 }], ...extra });
// modes: default for old maps, explicit validated
assert.deepEqual(D.validateMap(def('A')).map.modes, ['standard', 'deathmatch']);
assert.deepEqual(D.validateMap(def('A', { platforms: [...def('A').platforms, { x0: -4, z0: -4, x1: 4, z1: 4, y: 3 }] })).map.modes, ['standard', 'deathmatch', '3d']);
assert.deepEqual(D.validateMap(def('A', { modes: ['3d', 'hyper', '3d'] })).map.modes, ['hyper', '3d']);
for (const bad of [[], ['x'], 'standard', [1], null]) assert.equal(D.validateMap(def('A', { modes: bad })).ok, false);

const row = (id, name, modes) => { const v = D.validateMap(def(name, { modes })); return { id, name, modes: v.map.modes, def: v.map }; };
const reply = { ok: true, maps: [row('u000000000a', 'Zed', ['standard']), row('u000000000b', 'Hypo', ['hyper']), { id: 'bad', name: 'x', modes: ['standard'], def: def('x') }, { id: 'u000000000c', def: { name: 'broken' } }] };
assert.equal(C.useCustomMaps(null), false); assert.equal(C.useCustomMaps({ maps: 5 }), false);
// refresh: caches, bad entries dropped; failure keeps what we have; cache loads at startup
assert.equal(await C.refreshCustomMaps(async () => ({ ok: true, json: async () => reply }), 'http://x/maps'), true);
assert.deepEqual(Object.keys(C.CUSTOM).sort(), ['u000000000a', 'u000000000b']);
assert.equal(await C.refreshCustomMaps(async () => { throw new Error('offline'); }, 'http://x/maps'), false);
assert.equal(await C.refreshCustomMaps(async () => ({ ok: false, json: async () => ({}) }), 'http://x/maps'), false);
assert.equal(Object.keys(C.CUSTOM).length, 2, 'offline keeps the loaded set');
for (const k of Object.keys(C.CUSTOM)) delete C.CUSTOM[k];
assert.equal(C.loadCachedMaps(), true); assert.equal(Object.keys(C.CUSTOM).length, 2, 'cache restores');
assert.equal(C.mapsUrl('ws://h:1/'), 'http://h:1/maps');

// pools
assert.ok(M.modeMaps('standard').includes('u000000000a') && !M.modeMaps('standard').includes('u000000000b'));
assert.deepEqual(M.modeMaps('hyper'), ['arena', 'u000000000b']); assert.ok(!M.modeMaps('3d').includes('u000000000a'));
assert.deepEqual([].concat(M.modeWithMap('standard', 'u000000000a').map), ['u000000000a']);
assert.deepEqual([].concat(M.modeWithMap('standard', 'random').map), ['arena', 'crater', 'stairs', 'u000000000a'], 'random pool includes custom');
assert.deepEqual([].concat(M.modeWithMap('standard', 'u000000000b').map), ['arena', 'crater', 'stairs', 'u000000000a'], 'not in this mode -> random');
assert.equal(M.modeWithMap('3d', 'random'), M.MODES['3d'], 'no custom for the mode: untouched');
{ // the match resolves the custom def through hooks.maps
  const { createState, createBike } = await import('../js/state.js'); const st = createState(); st.playerId = 0; for (let i = 0; i < 4; i++) st.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  const m = M.createMatch(st, M.modeWithMap('standard', 'u000000000a'), Math.random, { maps: C.CUSTOM }); m.startMatch();
  assert.equal(st.map, C.CUSTOM.u000000000a);
}

// spMap: custom id kept before the cache loads, junk dropped; unknown at match start -> random
for (const [v, want] of [['u000000000a', 'u000000000a'], ['u12', 'random'], ['uzzzzzzzzzz', 'random']]) {
  store.set(S.KEY, JSON.stringify({ settings: { spMap: v } })); assert.equal(S.loadSave().settings.spMap, want, v);
}
for (const k of Object.keys(C.CUSTOM)) delete C.CUSTOM[k];
assert.deepEqual([].concat(M.modeWithMap('standard', 'u000000000a').map), ['arena', 'crater', 'stairs'], 'map vanished -> built-in random pool');
console.log('custommaps tests passed');
