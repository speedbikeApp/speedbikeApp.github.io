// GARAGE ops + GET /catalog end to end (dev-auth server, in-memory stores).
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';
import { createJsonCatalogStore } from '../catalog-store.js';

const guard = setTimeout(() => { console.error('catalog test timed out'); process.exit(1); }, 30000);
const catStore = createJsonCatalogStore(null);
const app = createGameServer({ auth: createDevAuth(), store: createJsonStore('/nonexistent-dir-sb/ranks.json'), social: createJsonSocialStore(null), catalog: catStore, adminUsernames: 'boss', allowedOrigins: ['https://game.example'], log: () => {} });
const port = await app.listen(0);
function client(uid, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://game.example' }), c = { waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.next = (test) => new Promise((resolve, reject) => { c.waiters.push({ test, resolve }); setTimeout(() => reject(new Error('no reply')), 4000); });
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; const w = c.next((m) => m.t === 'welcome'); ws.send(JSON.stringify({ t: 'hello', dev: true, uid, username })); return w; };
  let n = 0; c.op = async (op, a = {}) => { await new Promise((ok) => setTimeout(ok, 60)); const id = ++n, r = c.next((m) => m.t === 'ares' && m.id === id).catch((e) => { throw new Error(op + ' ' + JSON.stringify(a)); }); ws.send(JSON.stringify({ t: 'admin', op, id, a })); return r; };
  c.close = () => ws.close();
  return c;
}
const get = (headers = {}, method = 'GET') => new Promise((resolve, reject) => http.request({ port, path: '/catalog', method, headers }, (res) => { let b = ''; res.on('data', (x) => (b += x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject).end());
const boss = client('uBoss', 'Boss'), alice = client('uAlice', 'Alice');
await boss.hello(); await alice.hello();

// non-admin refused, nothing stored
for (const [op, a] of [['itemList', {}], ['itemSave', { item: { cat: 'body', name: 'X', price: 1, base: 'sleek' } }], ['itemDelete', { id: 'armored' }]]) {
  const r = await alice.op(op, a); assert.deepEqual([r.ok, r.code], [false, 'forbidden'], op);
}
assert.deepEqual(await catStore.all(), { items: [], overrides: {} });

// validation
const bad = async (item, code, id) => assert.equal((await boss.op('itemSave', id ? { id, item } : { item })).code, code, JSON.stringify(item));
const ok = { cat: 'body', name: 'Razor', price: 250, base: 'wedge', color: 0x336699 };
await bad({ ...ok, cat: 'wheel' }, 'bad_cat'); await bad({ ...ok, base: 'sleek2' }, 'bad_base'); await bad({ ...ok, base: 'slim' }, 'bad_base');
await bad({ ...ok, name: '' }, 'bad_name'); await bad({ ...ok, name: 'a'.repeat(21) }, 'bad_name'); await bad({ ...ok, name: '<script>' }, 'bad_name');
await bad({ ...ok, price: -1 }, 'bad_price'); await bad({ ...ok, price: 1.5 }, 'bad_price'); await bad({ ...ok, price: 1000001 }, 'bad_price'); await bad({ ...ok, price: '5' }, 'bad_price');
await bad({ ...ok, ach: 'nonsense' }, 'bad_ach'); await bad({ ...ok, color: 0x1000000 }, 'bad_color'); await bad({ ...ok, color: -1 }, 'bad_color'); await bad(null, 'bad_cat');
assert.equal((await boss.op('itemSave', { id: 'c_nope', item: ok })).code, 'not_found');

// create / update / list
const c = await boss.op('itemSave', { item: { ...ok, ach: 'streak10' } });
assert.ok(c.ok && /^c_[0-9a-f]{10}$/.test(c.item.id), 'server-generated c_ id'); assert.deepEqual([c.item.name, c.item.ach, c.item.hidden], ['Razor', 'streak10', undefined]);
const u = await boss.op('itemSave', { id: c.item.id, item: { name: 'Razor 2', price: 300, ach: null, cat: 'tire' } });
assert.deepEqual([u.ok, u.item.name, u.item.price, u.item.ach, u.item.cat, u.item.base], [true, 'Razor 2', 300, undefined, 'body', 'wedge'], 'cat is fixed, ach cleared');
assert.equal((await boss.op('itemSave', { id: c.item.id, item: { base: 'slim' } })).code, 'bad_base');
const l = await boss.op('itemList'); assert.equal(l.items.length, 1);

// built-in override + reset
assert.equal((await boss.op('itemSave', { id: 'armored', item: { price: 99, name: 'Tank', ach: 'wins100' } })).ok, true);
assert.equal((await boss.op('itemSave', { id: 'armored', item: { price: -5 } })).code, 'bad_price');
assert.equal((await boss.op('itemSave', { id: 'armored', item: { base: 'x', color: 5 } })).ok, true, 'unknown fields ignored');
let cat = JSON.parse((await get()).body); assert.deepEqual(cat.overrides.armored, { price: 99, name: 'Tank', ach: 'wins100' });

// delete = hide (item stays, owners keep it); built-in delete = reset
assert.deepEqual((await boss.op('itemDelete', { id: c.item.id })).hidden, true);
assert.equal((await boss.op('itemDelete', { id: 'nonexistent' })).code, 'not_found');
assert.equal((await boss.op('itemDelete', { id: 'armored' })).reset, true);

// public endpoint: no auth, CORS only for allowed origins, cached copy matches
let r = await get({ Origin: 'https://game.example' });
assert.equal(r.status, 200); assert.equal(r.headers['access-control-allow-origin'], 'https://game.example'); assert.match(r.headers['cache-control'], /max-age/);
cat = JSON.parse(r.body); assert.equal(cat.ok, true); assert.equal(cat.items.length, 1); assert.equal(cat.items[0].hidden, true); assert.deepEqual(cat.overrides, {});
assert.equal((await get({ Origin: 'https://evil.example' })).headers['access-control-allow-origin'], undefined);
assert.equal((await get({ Origin: 'http://localhost:8000' })).headers['access-control-allow-origin'], 'http://localhost:8000', 'local dev origin');
assert.equal((await get({}, 'POST')).status, 405);
// stored survives a fresh server read
assert.equal((await catStore.all()).items[0].hidden, true);

// DROPS ops: admin only, validated, served in GET /catalog, reset restores defaults
import { DEFAULT_DROPS } from '../../js/dropdef.js';
for (const op of ['dget', 'dset', 'dreset']) { const r = await alice.op(op, { drops: DEFAULT_DROPS }); assert.deepEqual([r.ok, r.code], [false, 'forbidden'], op); }
assert.deepEqual((await boss.op('dget')).drops, DEFAULT_DROPS);
const D = () => structuredClone(DEFAULT_DROPS), badD = async (f) => { const d = D(); f(d); assert.equal((await boss.op('dset', { drops: d })).code, 'bad_drops'); };
await badD((d) => { d.tiers.common.weight = 59; }); await badD((d) => { d.tiers.epic.weight = 13; }); await badD((d) => { d.tiers.rare.rewards[0] = { kind: 'coins', amount: 0 }; });
await badD((d) => { d.tiers.rare.rewards[0] = { kind: 'ability', pool: 'bogus', count: 1 }; }); await badD((d) => { d.tiers.rare.rewards = Array(13).fill({ kind: 'coins', amount: 5 }); });
await badD((d) => { d.tiers.rare.rewards = []; }); await badD((d) => { d.unlimitedOdds = 1; });
assert.equal((await boss.op('dset', {})).code, 'bad_drops');
const nd = D(); nd.tiers.common.weight = 65; nd.tiers.common.rewards.push({ kind: 'coins', amount: 7, junk: 1 }); nd.extraChance = 0.25;
const sd = await boss.op('dset', { drops: nd }); assert.equal(sd.ok, true); assert.equal(sd.drops.tiers.common.rewards[4].junk, undefined, 'clean copy');
assert.deepEqual(JSON.parse((await get()).body).drops, sd.drops); assert.deepEqual((await catStore.getDrops()), sd.drops);
assert.deepEqual((await boss.op('dreset')).drops, DEFAULT_DROPS); assert.deepEqual(JSON.parse((await get()).body).drops, DEFAULT_DROPS);

boss.close(); alice.close(); await app.close(); clearTimeout(guard);
console.log('catalog server tests passed');
