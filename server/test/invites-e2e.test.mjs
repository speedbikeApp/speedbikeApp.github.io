// End-to-end invite links over real WebSockets (dev auth, random port): code -> link -> friends + same party -> first finished online match pays both once.
// Also the Founder fields (welcome, name icon) and the public GET /invite lookup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';

const guard = setTimeout(() => { console.error('invites e2e timed out'); process.exit(1); }, 90000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-inv-'));
const mk = (extra = {}) => createGameServer({ auth: createDevAuth(), store: createJsonStore(path.join(dir, 'ranks.json')), social: createJsonSocialStore(path.join(dir, 'social.json')), timeScale: 40, countdownMs: 400, soloWaitMs: 600000, log: () => {}, ...extra });
const app = mk();
const port = await app.listen(0);

function client(uid, username, p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}`), c = { ws, uid, msgs: [], waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.next = (test, ms = 8000) => new Promise((resolve, reject) => {
    const f = typeof test === 'function' ? test : (m) => m.t === test;
    const to = setTimeout(() => reject(new Error(`${uid} timed out waiting for ${test}`)), ms);
    c.waiters.push({ test: f, resolve: (m) => { clearTimeout(to); resolve(m); } });
  });
  c.last = (t) => [...c.msgs].reverse().find((m) => m.t === t);
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; const w = c.next('welcome'); c.send({ t: 'hello', dev: true, uid, username }); return w; };
  c.play = () => { c.timer = setInterval(() => { if (ws.readyState === 1) c.send({ t: 'in', kind: 'turn', side: Math.random() < 0.5 ? -1 : 1, ctick: 0 }); }, 40); };
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return [r.status, await r.json()]; };

const [A, B] = [client('uidA', 'Alice'), client('uidB', 'Bobby')];
const wa = await A.hello(); await B.hello();
assert.equal(wa.founder, true, 'no FOUNDER_UNTIL: everybody is a founder'); assert.equal(wa.founderUntil, null);
assert.equal((await get('/health'))[1].founderUntil, null);

// the inviter gets a standing code; a bad / own code is a short answer, not an error
A.send({ t: 'invget' }); const { code } = await A.next('invcode');
assert.match(code, /^[\w-]{8,32}$/);
A.send({ t: 'invget' }); assert.equal((await A.next((m) => m.t === 'invcode' && A.msgs.filter((x) => x.t === 'invcode').length === 2)).code, code);
A.send({ t: 'invuse', code }); assert.equal((await A.next('invres')).code, 'own');
B.send({ t: 'invuse', code: 'nosuchcode123' }); assert.equal((await B.next('invres')).code, 'unknown');
assert.deepEqual(await get(`/invite?code=${code}`), [200, { ok: true, username: 'Alice' }]);
assert.equal((await get('/invite?code=nosuchcode123'))[0], 404); assert.equal((await get('/invite?code=x'))[0], 400);

// the invitee opens the link: friends + the inviter's party
B.msgs.length = 0;
B.send({ t: 'invuse', code });
const res = await B.next('invres');
assert.deepEqual([res.ok, res.username, res.joined], [true, 'Alice', true]);
await sleep(200);
const pa = A.last('party').party, pb = B.last('party').party;
assert.deepEqual(pa.members.map((m) => m.uid).sort(), ['uidA', 'uidB']); assert.equal(pa.leader, 'uidA'); assert.equal(pb.id, pa.id);
assert.ok(pa.members.every((m) => m.founder === true), 'party list carries the founder mark');
assert.ok(A.last('friends').friends.some((f) => f.uid === 'uidB' && f.founder === true) && B.last('friends').friends.some((f) => f.uid === 'uidA'));
B.send({ t: 'invuse', code }); assert.equal((await B.next((m) => m.t === 'invres' && m.code)).code, 'already_friends');

// a reset kills the old link
A.send({ t: 'invreset' }); const fresh = (await A.next((m) => m.t === 'invcode' && m.code !== code)).code;
assert.equal((await get(`/invite?code=${code}`))[0], 404); assert.equal((await get(`/invite?code=${fresh}`))[0], 200);

// the party plays its first online match: both get the reward, once. Name icon: founder is allowed, admin is not.
A.send({ t: 'icon', icon: 'founder' }); B.send({ t: 'icon', icon: 'admin' }); await sleep(100);
A.send({ t: 'queue', mode: 'standard' });
const [sa, sb] = await Promise.all([A.next('start'), B.next('start')]);
assert.equal(sa.players.find((p) => p.uid === 'uidA').icon, 'founder');
assert.equal(sb.players.find((p) => p.uid === 'uidB').icon, undefined, 'admin icon refused for a non-admin');
assert.ok(sa.players.filter((p) => p.bot).every((p) => !p.icon), 'bots never have an icon');
for (const c of [A, B]) c.play();
const [ea, eb] = await Promise.all([A, B].map((c) => c.next('end', 60000)));
for (const c of [A, B]) clearInterval(c.timer);
assert.ok(ea.ranks.some((r) => r.uid === 'uidA' && r.icon === 'founder'));
const seen = async (c, t) => { for (let i = 0; i < 80 && !c.last(t); i++) await sleep(50); return c.last(t); }; // (the reward may arrive before we look)
const ra = await seen(A, 'invreward'), rb = await seen(B, 'invreward');
assert.deepEqual([ra.coins, ra.name, rb.coins, rb.name], [500, 'Bobby', 500, 'Alice']);
await sleep(300);
assert.equal(A.msgs.filter((m) => m.t === 'invreward').length, 1); assert.equal(B.msgs.filter((m) => m.t === 'invreward').length, 1);

// a second match pays nothing more
A.send({ t: 'queue', mode: 'standard' });
await Promise.all([A.next((m) => m.t === 'start' && m !== sa), B.next((m) => m.t === 'start' && m !== sb)]);
for (const c of [A, B]) c.play();
await Promise.all([A, B].map((c) => c.next((m) => m.t === 'end' && m !== ea && m !== eb, 60000)));
for (const c of [A, B]) clearInterval(c.timer);
await sleep(300);
assert.equal(A.msgs.filter((m) => m.t === 'invreward').length, 1); assert.equal(B.msgs.filter((m) => m.t === 'invreward').length, 1);
for (const c of [A, B]) c.ws.close();
await app.close();

// founder cutoff: an account first seen after FOUNDER_UNTIL is no founder; the welcome carries the cutoff
{
  const until = Date.now() + 60000, late = createGameServer({ auth: createDevAuth(), store: createJsonStore(path.join(dir, 'r2.json')), founderUntil: until, createdAt: async (u) => (u === 'old' ? until - 1000 : until + 1000), log: () => {} });
  const p2 = await late.listen(0), o = client('old', 'Oldie', p2), n = client('new', 'Newbie', p2);
  const [wo, wn] = [await o.hello(), await n.hello()];
  assert.deepEqual([wo.founder, wn.founder, wo.founderUntil], [true, false, until]);
  n.send({ t: 'icon', icon: 'founder' }); await sleep(50); // refused: nothing shows
  assert.equal((await (await fetch(`http://127.0.0.1:${p2}/health`)).json()).founderUntil, until);
  for (const c of [o, n]) c.ws.close();
  await late.close();
}
clearTimeout(guard);
console.log('invites e2e passed');
