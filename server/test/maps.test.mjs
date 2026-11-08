// MAPS admin ops (dev-auth server, in-memory stores) + custom maps in the room pool / start message.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';
import { createJsonAdminStore } from '../admin-store.js';
import { createJsonMapStore, createMapPool } from '../admin-maps.js';
import { Room } from '../room.js';
import { defaultRank } from '../../js/ranks.js';
import { validateMap } from '../../js/mapdef.js';
import { MAPS, groundAt } from '../../js/maps.js';

const guard = setTimeout(() => { console.error('maps test timed out'); process.exit(1); }, 60000);
const social = createJsonSocialStore(null), ranks = createJsonStore('/nonexistent-dir-sb/ranks.json'), adminStore = createJsonAdminStore(null, social), mapStore = createJsonMapStore(null);
const app = createGameServer({ auth: createDevAuth(), store: ranks, social, admin: adminStore, maps: mapStore, adminUsernames: 'boss', log: () => {} });
const port = await app.listen(0);

function client(uid, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.next = (test) => new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error('timeout')), 5000); c.waiters.push({ test, resolve: (m) => { clearTimeout(to); resolve(m); } }); });
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; const w = c.next((m) => m.t === 'welcome'); ws.send(JSON.stringify({ t: 'hello', dev: true, uid, username })); return w; };
  let n = 0;
  c.op = async (op, a = {}) => { await new Promise((ok) => setTimeout(ok, 60)); const id = ++n, r = c.next((m) => m.t === 'ares' && m.id === id); ws.send(JSON.stringify({ t: 'admin', op, id, a })); return r; };
  return c;
}
const boss = client('uBoss', 'Boss'), alice = client('uAlice', 'Alice');
await boss.hello(); await alice.hello();

const good = (name = 'Test Map') => ({ name, half: 36, killY: -14, platforms: [{ x0: -30, z0: -30, x1: 30, z1: 30, y: 0, rot: 0.2 }],
  spawns: [{ x: 0, z: 18, dx: 0, dz: -1 }, { x: -18, z: 0, dx: 1, dz: 0 }, { x: 0, z: -18, dx: 0, dz: 1 }, { x: 18, z: 0, dx: -1, dz: 0 }] });
const base = (name) => ({ ...good(name), half: 60 });

// non-admin refused everything, nothing stored
for (const [op, a] of [['mapList', {}], ['mapGet', { id: 'u0123456789' }], ['mapSave', { map: base() }], ['mapDelete', { id: 'u0123456789' }]]) {
  const r = await alice.op(op, a); assert.deepEqual([r.ok, r.code], [false, 'forbidden'], op);
}
assert.equal((await mapStore.list()).length, 0);

// validation at the trust boundary
for (const [a, why] of [[{ map: null }, /MAP MISSING/], [{ map: { ...base(), name: '<script>' } }, /NAME/], [{ map: { ...base(), spawns: base().spawns.slice(0, 3) } }, /SPAWN/],
  [{ map: { ...base(), platforms: [{ x0: 0, z0: 0, x1: NaN, z1: 5, y: 0 }] } }, /NUMBER/], [{ map: { ...base(), spawns: base().spawns.map((s) => ({ ...s, x: 99 })) } }, /OUTSIDE|SPAWN/],
  [{ map: { ...base(), half: 34 } }, /OUTSIDE/]]) {
  const r = await boss.op('mapSave', a); assert.equal(r.ok, false); assert.equal(r.code, 'bad_map'); assert.match(r.why, why);
}
assert.equal((await boss.op('mapSave', { id: 'nope', map: base() })).code, 'bad_id');
assert.equal((await boss.op('mapSave', { id: 'u0123456789', map: base() })).code, 'not_found', 'cannot create with a chosen id');
assert.equal((await boss.op('mapGet', { id: '../x' })).code, 'bad_id');
assert.equal((await mapStore.list()).length, 0);

// save / list / get / update / delete
const s1 = await boss.op('mapSave', { map: { ...base('Alpha'), id: 'evil', extra: 1 } });
assert.ok(s1.ok, s1.why); assert.match(s1.mapId, /^u[0-9a-f]{10}$/); assert.equal(s1.map.platforms[0].rot, 0.2); assert.equal(s1.map.extra, undefined); assert.equal(s1.map.spawns[0].y, 0);
const s2 = await boss.op('mapSave', { map: base('Beta') });
const ls = await boss.op('mapList'); assert.deepEqual(ls.maps.map((m) => [m.name, m.platforms, m.spawns]), [['Alpha', 1, 4], ['Beta', 1, 4]]);
const g = await boss.op('mapGet', { id: s1.mapId }); assert.equal(g.map.name, 'Alpha'); assert.ok(g.updatedAt > 0);
const up = await boss.op('mapSave', { id: s1.mapId, map: { ...g.map, name: 'Alpha2' } }); assert.equal(up.mapId, s1.mapId); assert.equal((await boss.op('mapGet', { id: s1.mapId })).map.name, 'Alpha2');
assert.equal((await boss.op('mapList')).maps.length, 2, 'update does not duplicate');
// ramps: rx/rz are stored; too steep is refused; spawn y follows the slope; then removed again so the pool checks below stay exact
const rampMap = (a) => { const m = base('Ramp'); m.platforms = [{ x0: -20, z0: -20, x1: 20, z1: 20, y: 0, rx: 0.2, rz: -0.1, ...a }]; m.killY = -20; return m; };
const sr = await boss.op('mapSave', { map: rampMap() }); assert.ok(sr.ok, sr.why);
assert.deepEqual([sr.map.platforms[0].rx, sr.map.platforms[0].rz], [0.2, -0.1]); assert.notEqual(sr.map.spawns[1].y, 0, 'spawn height derived from the tilted surface');
const stp = await boss.op("mapSave", { map: rampMap({ rx: 1.2 }) }); assert.equal(stp.ok, false); assert.match(stp.why, /TOO STEEP/);
assert.equal((await boss.op('mapSave', { map: rampMap({ rz: 'x' }) })).ok, false);
assert.ok((await boss.op('mapDelete', { id: sr.mapId })).ok);

// pool: custom maps join standard + deathmatch (not hyper; 3d only when tiered)
const pool = app.mapPool;
assert.deepEqual(Object.keys(pool.defs).sort(), [s1.mapId, s2.mapId].sort());
assert.deepEqual(pool.poolFor('standard').map, ['arena', 'crater', 'stairs', ...Object.keys(pool.defs)]);
assert.ok(pool.poolFor('deathmatch')); assert.equal(pool.poolFor('hyper'), null); assert.equal(pool.poolFor('3d'), null, 'flat custom maps stay out of 3D');
const tiered = base('Tiered'); tiered.platforms.push({ x0: -4, z0: -4, x1: 4, z1: 4, y: 3 });
const s3 = await boss.op('mapSave', { map: tiered }); assert.ok(s3.ok, s3.why); assert.deepEqual(pool.poolFor('3d').map, ['tiers', 'stairs', s3.mapId]);

// modes: validated, normalised, default for maps saved without; a map joins exactly the pools of its modes
assert.deepEqual(s1.map.modes, ['standard', 'deathmatch'], 'old maps: standard + deathmatch'); assert.deepEqual(s3.map.modes, ['standard', 'deathmatch', '3d'], 'tiered old maps also 3d');
for (const bad of [[], 'hyper', ['nope'], ['standard', 5], null]) { const r = await boss.op('mapSave', { map: { ...base('X'), modes: bad } }); assert.equal(r.ok, false, JSON.stringify(bad)); assert.match(r.why, /MODES/); }
const sm = await boss.op('mapSave', { map: { ...base('Modal'), modes: ['3d', 'hyper', 'hyper'] } }); assert.ok(sm.ok, sm.why); assert.deepEqual(sm.map.modes, ['hyper', '3d'], 'deduped, canonical order');
assert.deepEqual((await boss.op('mapGet', { id: sm.mapId })).map.modes, ['hyper', '3d']);
assert.deepEqual(pool.poolFor('hyper'), { map: ['arena', sm.mapId], maps: { [sm.mapId]: pool.defs[sm.mapId] } });
assert.ok(pool.poolFor('3d').map.includes(sm.mapId), 'flat map explicitly in 3d joins it'); assert.ok(!pool.poolFor('standard').map.includes(sm.mapId) && !pool.poolFor('deathmatch').map.includes(sm.mapId));
// GET /maps: public, validated defs with modes, CORS like /catalog
const url = `http://127.0.0.1:${port}/maps`;
let hr = await fetch(url, { headers: { Origin: 'http://localhost:8814' } }); const hj = await hr.json();
assert.equal(hr.status, 200); assert.equal(hr.headers.get('access-control-allow-origin'), 'http://localhost:8814'); assert.equal(hr.headers.get('cache-control'), 'public, max-age=60');
assert.equal(hj.maps.length, Object.keys(pool.defs).length); const jm = hj.maps.find((m) => m.id === sm.mapId);
assert.deepEqual([jm.name, jm.modes], ['Modal', ['hyper', '3d']]); assert.equal(validateMap(jm.def).ok, true); assert.deepEqual(jm.def.modes, jm.modes);
hr = await fetch(url, { headers: { Origin: 'https://evil.example' } }); assert.equal(hr.headers.get('access-control-allow-origin'), null); assert.equal(hr.status, 200);
hr = await fetch(url, { method: 'POST' }); assert.equal(hr.status, 405);
assert.ok((await boss.op('mapDelete', { id: sm.mapId })).ok);

// a room whose seed picks a custom map: start message carries the full def, the server sim uses the same one
function room(mode, seed) {
  const msgs = [[], [], [], []];
  const players = [0, 1, 2, 3].map((i) => ({ uid: 'u' + i, username: 'P' + i, rank: defaultRank(), colorIdx: i, send: (m) => msgs[i].push(m) }));
  return { r: new Room({ id: 1, mode, players, seed, mapPool: pool.poolFor(mode) }), msgs };
}
let hit = null, builtin = null;
for (let seed = 1; seed < 200 && !(hit && builtin); seed++) { const x = room('standard', seed); if (MAPS[x.msgs[0][0].mapId]) builtin ||= x; else hit ||= x; }
assert.ok(hit && builtin, 'both custom and built-in maps are picked');
const st = hit.msgs[0][0];
assert.equal(st.t, 'start'); assert.ok(pool.defs[st.mapId]); assert.deepEqual(st.map, pool.defs[st.mapId]); assert.ok(JSON.stringify(st).length < 30000);
assert.equal(hit.r.state.map, pool.defs[st.mapId], 'server simulates the same definition');
const { id: _id, ...noId } = st.map;
assert.deepEqual(validateMap(st.map).map, noId, 'client re-validation is lossless');
assert.equal(builtin.msgs[0][0].map, undefined, 'built-in maps only send the id');
for (const b of hit.r.state.bikes) assert.ok(groundAt(hit.r.state.map, b.x, b.z) > -Infinity, 'bikes spawn on the custom map');
assert.equal(room('hyper', 3).msgs[0][0].mapId, 'arena');

// delete: gone from the store and the pool
assert.equal((await boss.op('mapDelete', { id: s1.mapId })).ok, true);
assert.equal((await boss.op('mapGet', { id: s1.mapId })).code, 'not_found'); assert.equal((await boss.op('mapDelete', { id: s1.mapId })).code, 'not_found');
assert.equal(pool.defs[s1.mapId], undefined); assert.ok(!pool.poolFor('standard').map.includes(s1.mapId));

// persistence: a fresh pool on the same JSON file loads the maps at startup; invalid stored maps are skipped
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbmaps-')), 'maps.json');
fs.writeFileSync(file, JSON.stringify({ u0000000001: { map: base('Disk') }, u0000000002: { map: { name: 'bad' } } }));
const p2 = createMapPool(createJsonMapStore(file), () => {}); await p2.ready;
assert.deepEqual(Object.keys(p2.defs), ['u0000000001']); assert.equal(p2.defs.u0000000001.name, 'Disk');

for (const c of [boss, alice]) c.ws.close();
await app.close(); clearTimeout(guard);
console.log('maps tests passed');
