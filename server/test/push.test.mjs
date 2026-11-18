// Web push: /push/* endpoints, tick jobs, admin ops (mock sender, JSON stores).
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';
import { createJsonCatalogStore } from '../catalog-store.js';
import { createJsonPushStore, REMINDERS } from '../push.js';

const guard = setTimeout(() => { console.error('push test timed out'); process.exit(1); }, 30000);
const H = 3600e3, now = Date.now();
delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_SUBJECT;
const catStore = createJsonCatalogStore(null), pushStore = createJsonPushStore(null);
await catStore.putEvents([
  { id: 'soon', title: 'SOON', start: now + 30 * 60e3, end: now + 5 * H, html: '', quests: [] },
  { id: 'late', title: 'LATE', start: now - 5 * H, end: now + 30 * 60e3, html: '', quests: [] },
  { id: 'far', title: 'FAR', start: now + 10 * H, end: now + 20 * H, html: '', quests: [] },
]);
const sent = []; let failWith = null;
const pushSender = async (sub, payload) => { if (failWith) throw Object.assign(new Error('gone'), { statusCode: failWith }); sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); };
const mk = (extra) => createGameServer({ auth: createDevAuth(), store: createJsonStore('/nonexistent-dir-sb/ranks.json'), social: createJsonSocialStore(null), catalog: catStore, push: pushStore, pushSender, adminUsernames: 'boss', log: () => {}, ...extra });
const app = mk({ vapid: { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:a@b.c' } });
const port = await app.listen(0);
const bare = mk({ catalog: createJsonCatalogStore(null), push: createJsonPushStore(null) }), barePort = await bare.listen(0);

const req = (p, path, method, body) => new Promise((resolve, reject) => { const r = http.request({ port: p, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (x) => (b += x)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); }); r.on('error', reject); r.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)); });
const post = (path, body) => req(port, path, 'POST', body);
const sub = (n, extra = {}) => ({ endpoint: `https://push.example/send/${n}`, keys: { p256dh: 'BPk_abc-123', auth: 'au_th-1' }, ...extra });
const subs = () => pushStore.subs();

// key: null without env, the key when configured
assert.deepEqual((await req(barePort, '/push/key', 'GET')).body, { key: null });
assert.deepEqual((await req(port, '/push/key', 'GET')).body, { key: 'PUB' });
assert.equal((await req(barePort, '/push/tick', 'POST')).body.sent, 0); // unconfigured tick: nothing, no crash

// validation
const bad = async (s, code) => { const r = await post('/push/sub', { sub: s }); assert.equal(r.status, 400); assert.equal(r.body.code, code, JSON.stringify(s)); };
await bad(sub(1, { endpoint: 'http://push.example/x' }), 'bad_endpoint');
await bad(sub(1, { endpoint: 'https://p/' + 'a'.repeat(1100) }), 'bad_endpoint');
await bad({ endpoint: 'https://p/x' }, 'bad_keys');
await bad(sub(1, { keys: { p256dh: 'bad key!', auth: 'ok' } }), 'bad_keys');
assert.equal((await post('/push/sub', 'not json')).status, 400);
assert.equal((await post('/push/sub', { sub: sub(1), pad: 'x'.repeat(2100) })).status, 413);
assert.equal((await subs()).length, 0);

// upsert updates lastSeen, resets reminded
assert.equal((await post('/push/sub', { sub: sub(1) })).body.ok, true);
const [s1] = await subs(); assert.equal(s1.reminded, false);
await pushStore.putSub({ ...s1, lastSeen: 1, reminded: true });
await post('/push/sub', { sub: sub(1) });
const all = await subs(); assert.equal(all.length, 1); assert.ok(all[0].lastSeen >= now && all[0].reminded === false);

// unsub
await post('/push/sub', { sub: sub(2) });
assert.equal((await subs()).length, 2);
assert.equal((await post('/push/unsub', { endpoint: sub(2).endpoint })).body.ok, true);
assert.deepEqual((await subs()).map((s) => s.endpoint), [sub(1).endpoint]);

// tick: start + end once each, idempotent
assert.equal(await app.push.tick(), 2);
assert.deepEqual(sent.map((m) => m.body).sort(), ['LATE: 1 hour left!', 'SOON starts in 1 hour!']);
assert.equal(sent[0].url, '/');
assert.equal(await app.push.tick(), 0); assert.equal(sent.length, 2);
assert.deepEqual((await post('/push/tick')).body, { ok: true, sent: 0 });
assert.equal((await post('/push/tick')).status, 429); // ~1 per 30 s per IP

// inactive reminder: once, reset by a new /push/sub
sent.length = 0;
await pushStore.putSub({ ...(await subs())[0], lastSeen: now - 4 * 24 * H });
assert.equal(await app.push.tick(), 1);
assert.ok(REMINDERS.some(([ti, bo]) => ti === sent[0].title && bo === sent[0].body));
assert.equal(await app.push.tick(), 0);
await post('/push/sub', { sub: sub(1) });
assert.equal(await app.push.tick(), 0); // seen again: no reminder
assert.equal((await subs())[0].reminded, false);

// 410 removes the sub
failWith = 410; assert.deepEqual(await app.push.broadcast('t', 'b'), { sent: 0, failed: 1 }); failWith = null;
assert.equal((await subs()).length, 0);

// admin ops
function client(uid, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.next = (test) => new Promise((resolve, reject) => { c.waiters.push({ test, resolve }); setTimeout(() => reject(new Error('no reply')), 4000); });
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; const w = c.next((m) => m.t === 'welcome'); ws.send(JSON.stringify({ t: 'hello', dev: true, uid, username })); return w; };
  let n = 0; c.op = async (op, a = {}) => { await new Promise((ok) => setTimeout(ok, 60)); const id = ++n, r = c.next((m) => m.t === 'ares' && m.id === id); ws.send(JSON.stringify({ t: 'admin', op, id, a })); return r; };
  c.close = () => ws.close();
  return c;
}
const boss = client('uBoss', 'Boss'), alice = client('uAlice', 'Alice');
await boss.hello(); await alice.hello();
await pushStore.putSub({ ...sub(3), lastSeen: Date.now(), reminded: false }); sent.length = 0;
for (const op of ['pushsend', 'pushstats']) assert.equal((await alice.op(op, { title: 'x', body: 'y', kind: 'custom' })).code, 'forbidden', op);
assert.equal(sent.length, 0);
const badSend = async (a, code) => assert.equal((await boss.op('pushsend', a)).code, code, JSON.stringify(a));
await badSend({ title: 'x', body: 'y', kind: 'nope' }, 'bad_kind');
await badSend({ title: '', body: 'y', kind: 'custom' }, 'bad_title');
await badSend({ title: 'x'.repeat(61), body: 'y', kind: 'custom' }, 'bad_title');
await badSend({ title: 'x', body: '', kind: 'custom' }, 'bad_body');
await badSend({ title: 'x', body: 'y'.repeat(201), kind: 'custom' }, 'bad_body');
assert.equal(sent.length, 0);
let r = await boss.op('pushsend', { title: 'Hi', body: 'There', kind: 'custom' });
assert.deepEqual([r.ok, r.sent, r.failed], [true, 1, 0]); assert.equal(sent[0].title, 'Hi');
await boss.op('pushsend', { title: '', body: '', kind: 'update' });
assert.deepEqual([sent[1].title, sent[1].body], ['HUGE UPDATE!', 'A huge update just dropped. Come check it out!']);
r = await boss.op('pushstats', {}); assert.deepEqual([r.ok, r.subs, r.configured], [true, 1, true]);

// per-IP rate limit on /push/sub (runs last: it exhausts the bucket)
let limited = false; for (let i = 0; i < 30 && !limited; i++) limited = (await post('/push/sub', { sub: sub(100 + i) })).status === 429;
assert.ok(limited, 'rate limited');

boss.close(); alice.close(); await app.close(); await bare.close(); clearTimeout(guard);
console.log('push tests passed');
