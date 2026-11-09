// GAMES ops (force start / stop / featured override) + pitems (give parts / power-ups) end to end (dev-auth server, in-memory stores).
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';
import { createJsonAdminStore } from '../admin-store.js';
import { createJsonCatalogStore } from '../catalog-store.js';
import { featuredMode } from '../../js/rotation.js';

const guard = setTimeout(() => { console.error('admin-games test timed out'); process.exit(1); }, 60000);
const social = createJsonSocialStore(null), ranks = createJsonStore('/nonexistent-dir-sb/ranks.json'), adminStore = createJsonAdminStore(null, social), catStore = createJsonCatalogStore(null);
const mk = () => createGameServer({ auth: createDevAuth(), store: ranks, social, admin: adminStore, catalog: catStore, adminUsernames: 'boss', log: () => {} });
let app = mk(), port = await app.listen(0);

function client(uid, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { msgs: [], waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.next = (test, ms = 5000) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${uid} timed out waiting for ${test}`)), ms);
    c.waiters.push({ test: typeof test === 'function' ? test : (m) => m.t === test, resolve: (m) => { clearTimeout(to); resolve(m); } });
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; const w = c.next('welcome'); c.send({ t: 'hello', dev: true, uid, username }); return w; };
  let n = 0;
  c.op = async (op, a = {}) => { await new Promise((ok) => setTimeout(ok, 60)); const id = ++n, r = c.next((m) => m.t === 'ares' && m.id === id); c.send({ t: 'admin', op, id, a }); return r; };
  return c;
}
const health = () => new Promise((resolve, reject) => http.get({ port, path: '/health' }, (res) => { let b = ''; res.on('data', (x) => (b += x)); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));

const boss = client('uBoss', 'Boss'), alice = client('uAlice', 'Alice'), bob = client('uBob', 'Bobby'), cy = client('uCy', 'Cyd');
await boss.hello(); await alice.hello(); await bob.hello(); await cy.hello();

// ---- non-admin refused everything
for (const [op, a] of [['gget', {}], ['gstart', { queue: 'standard' }], ['gstop', { id: 1 }], ['gfeatured', { mode: '3d' }], ['pitems', { uid: 'uBob', part: { cat: 'body', id: 'armored', own: true } }]]) {
  const r = await alice.op(op, a); assert.deepEqual([r.ok, r.code], [false, 'forbidden'], op);
}
assert.equal(await adminStore.getProgress('uBob'), null);

// ---- force start a lone queue, then a lobby; stop a running room without touching ranks
const rankBefore = JSON.stringify(await ranks.getRank('uAlice'));
alice.send({ t: 'queue', mode: 'standard' }); await alice.next('queued');
let g = await boss.op('gget');
assert.deepEqual(g.queues.map((q) => [q.mode, q.players]), [['standard', ['Alice']]]); assert.equal(g.rooms.length, 0);
assert.equal((await boss.op('gstart', { queue: 'nope' })).code, 'not_found');
assert.equal((await boss.op('gstart', { lobby: 999 })).code, 'not_found');
const started = alice.next('start');
assert.equal((await boss.op('gstart', { queue: 'standard' })).ok, true);
await started;
g = await boss.op('gget');
assert.equal(g.queues.length, 0); assert.equal(g.rooms.length, 1);
assert.deepEqual([g.rooms[0].mode, g.rooms[0].players.filter((p) => p.bot).length, g.rooms[0].players[0].username], ['standard', 3, 'Alice'], 'filled with bots');
const ended = alice.next('end');
assert.equal((await boss.op('gstop', { id: 12345 })).code, 'not_found');
assert.equal((await boss.op('gstop', { id: g.rooms[0].id })).ok, true);
const end = await ended;
assert.equal(end.reason, 'stopped'); assert.ok(end.ranks.every((r) => r.change === 'none'), 'no rank change');
assert.equal(JSON.stringify(await ranks.getRank('uAlice')), rankBefore);
assert.equal((await boss.op('gget')).rooms.length, 0);

// lobby of two humans
bob.send({ t: 'queue', mode: 'deathmatch' }); cy.send({ t: 'queue', mode: 'deathmatch' }); await cy.next('lobby');
g = await boss.op('gget'); assert.equal(g.lobbies.length, 1); assert.deepEqual(g.lobbies[0].players.slice().sort(), ['Bobby', 'Cyd']);
const s2 = bob.next('start'); assert.equal((await boss.op('gstart', { lobby: g.lobbies[0].id })).ok, true); await s2;
const e2 = bob.next('end'), e3 = cy.next('end'); assert.equal((await boss.op('gstop', { id: (await boss.op('gget')).rooms[0].id })).ok, true);
assert.equal((await e2).reason, 'stopped'); await e3;

// ---- featured override: immediate broadcast, /health, matchmaker, persistence, AUTO clears
const auto = featuredMode(Date.now()), other = ['hyper', '3d', 'multimap'].find((m) => m !== auto);
assert.equal((await boss.op('gfeatured', { mode: 'standard' })).code, 'bad_mode');
assert.equal((await boss.op('gfeatured', { mode: 'bogus' })).code, 'bad_mode');
const rot = alice.next('rotation');
const set = await boss.op('gfeatured', { mode: other });
assert.deepEqual([set.ok, set.featured.current, set.featured.override], [true, other, other]);
const rm = await rot; assert.deepEqual([rm.featured, rm.manual, rm.nextRotation], [other, true, 0]);
assert.equal((await health()).featured, other);
alice.send({ t: 'queue', mode: auto }); assert.equal((await alice.next('error')).code, 'bad_mode', 'old featured mode no longer allowed');
alice.send({ t: 'queue', mode: other }); await alice.next('queued'); alice.send({ t: 'leaveQueue' });
await app.close(); // restart with the same stores: the override survives
app = mk(); port = await app.listen(0);
const late = client('uAlice', 'Alice'); await late.hello();
const w2 = client('uBoss', 'Boss'); const w3 = await w2.hello();
assert.deepEqual([w3.featured, w3.manual], [other, true], 'persisted override applied after restart');
const back = late.next('rotation');
assert.equal((await w2.op('gfeatured', { mode: 'auto' })).featured.override, null);
const bm = await back; assert.deepEqual([bm.featured, bm.manual], [auto, false]); assert.ok(bm.nextRotation > Date.now());
assert.equal(await catStore.getFeatured(), null);

// ---- pitems: give / take parts and power-ups
const pg = async (uid) => (await w2.op('pget', { uid })).player.progress;
const bobC = client('uBob', 'Bobby'); await bobC.hello();
const it = (a) => w2.op('pitems', { uid: 'uBob', ...a });
assert.equal((await it({ part: { cat: 'body', id: 'armored', own: true } })).ok, true);
assert.deepEqual((await pg('uBob')).parts.body, ['armored']);
assert.equal((await it({ part: { cat: 'body', id: 'armored', own: false } })).ok, true); assert.deepEqual((await pg('uBob')).parts.body, []);
for (const part of [{ cat: 'wheel', id: 'armored', own: true }, { cat: 'body', id: 'nope', own: true }, { cat: 'body', id: 'sleek', own: false }, { cat: 'body', id: 'c_zzzz', own: true }, { cat: 'body', id: 'armored' }, { cat: 'tire', id: 'armored', own: true }]) assert.equal((await it({ part })).code, 'bad_item', JSON.stringify(part));
const c = (await w2.op('itemSave', { item: { cat: 'glow', name: 'Neon', price: 10, base: 'blue', color: 255 } })).item;
assert.equal((await it({ part: { cat: 'glow', id: c.id, own: true } })).ok, true, 'custom catalog items can be given');
assert.equal((await it({ part: { cat: 'body', id: c.id, own: true } })).code, 'bad_item', 'custom item only in its own category');
const ab = (ability) => it({ ability });
assert.equal((await ab({ id: 'rocketJump', count: 5 })).ok, true);
let p = await pg('uBob'); assert.deepEqual([p.abilityCount.rocketJump, p.abilityInf], [5, []]);
assert.equal((await ab({ id: 'rocketJump', inf: true })).ok, true); p = await pg('uBob'); assert.deepEqual(p.abilityInf, ['rocketJump']);
assert.equal((await ab({ id: 'rocketJump', count: 99 })).ok, true); p = await pg('uBob'); assert.deepEqual([p.abilityCount.rocketJump, p.abilityInf], [99, []], 'an amount ends unlimited');
await ab({ id: 'stealth', inf: true }); assert.equal((await ab({ id: 'stealth', inf: false })).ok, true); assert.deepEqual((await pg('uBob')).abilityInf, []);
assert.equal((await ab({ id: 'rocketJump', count: 0 })).ok, true); assert.equal((await pg('uBob')).abilityCount.rocketJump, undefined);
for (const a of [{ id: 'turbo', count: 5 }, { id: 'nope', count: 5 }, { id: 'stealth', count: 100 }, { id: 'stealth', count: -1 }, { id: 'stealth', count: 1.5 }, { id: 'stealth', count: '5' }, { id: 'stealth', inf: 'yes' }]) assert.ok(['bad_item', 'bad_value'].includes((await ab(a)).code), JSON.stringify(a));
assert.equal((await it({})).code, 'bad_item'); assert.equal((await w2.op('pitems', { uid: 'nobody0', part: {} })).ok, false);
// an online player is told to resync (force)
const rs = bobC.next('resync'); await it({ part: { cat: 'tire', id: 'wide', own: true } }); assert.equal((await rs).force, true);

clearTimeout(guard); await app.close(); process.exit(0);
