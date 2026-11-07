// End-to-end parties over real WebSockets (dev-auth server, random port): friends -> invite / accept, leader changes, kick, transfer, size cap,
// the leader's queue pulls the whole party into ONE room, party members stay UNRANKED while a solo in the same match ranks normally.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';
import { defaultRank } from '../../js/ranks.js';

const guard = setTimeout(() => { console.error('party e2e timed out'); process.exit(1); }, 90000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-party-'));
const store = createJsonStore(path.join(dir, 'ranks.json'));
const mid = { ...defaultRank(), tier: 'He', div: 2, wins: 1 }; // any win promotes, any loss drops to 0 wins: the rank always changes when ranked
for (const u of ['uidA', 'uidB', 'uidC', 'uidD']) await store.setRank(u, mid, u);
const app = createGameServer({ auth: createDevAuth(), store, social: createJsonSocialStore(path.join(dir, 'social.json')), timeScale: 40, countdownMs: 400, log: () => {} });
const port = await app.listen(0);

function client(uid, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, uid, msgs: [], waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.next = (test, ms = 8000) => new Promise((resolve, reject) => {
    const f = typeof test === 'function' ? test : (m) => m.t === test;
    const to = setTimeout(() => reject(new Error(`${uid} timed out waiting for ${test}`)), ms);
    c.waiters.push({ test: f, resolve: (m) => { clearTimeout(to); resolve(m); } });
  });
  c.last = (t) => [...c.msgs].reverse().find((m) => m.t === t);
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; const w = c.next('welcome'), p = c.next('party'), f = c.next('friends'); c.send({ t: 'hello', dev: true, uid, username }); await Promise.all([w, p]); return f; };
  // send an intent and wait for its pres (and return it)
  c.do = async (msg) => { const p = c.next((m) => m.t === 'pres' && m.op === msg.t || (m.t === 'error' && msg.t === 'queue')); c.send(msg); return p; };
  c.party = () => c.last('party').party;
  c.play = () => { c.timer = setInterval(() => { if (ws.readyState === 1) c.send({ t: 'in', kind: 'turn', side: Math.random() < 0.5 ? -1 : 1, ctick: 0 }); }, 40); };
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const members = (c) => c.party().members.map((m) => m.uid);
const settle = () => sleep(120);

const [A, B, C, D, E] = [['uidA', 'Alice'], ['uidB', 'Bobby'], ['uidC', 'Carol'], ['uidD', 'Dave'], ['uidE', 'Erin']].map(([u, n]) => client(u, n));
for (const c of [A, B, C, D, E]) await c.hello();
// friendships: A-B, A-C, B-C, A-D, A-E (D and E are only A's friends)
for (const [x, y] of [[A, B], [A, C], [B, C], [A, D], [A, E]]) {
  x.send({ t: 'fadd', uid: y.uid }); await y.next((m) => m.t === 'friends' && m.incoming.some((i) => i.uid === x.uid));
  y.send({ t: 'faccept', uid: x.uid }); await x.next((m) => m.t === 'friends' && m.friends.some((f) => f.uid === y.uid));
}

// ---- invite / accept / decline ----
assert.equal((await B.do({ t: 'pinvite', uid: 'uidD' })).code, 'not_friend', 'only your own friends');
assert.equal((await A.do({ t: 'pinvite', uid: 'uidA' })).code, 'self');
assert.equal((await B.do({ t: 'paccept', uid: 'uidA' })).code, 'no_invite');
assert.equal((await A.do({ t: 'pinvite', uid: 'uidB' })).ok, true);
await settle(); const inv = B.last('pinvites');
assert.equal(inv.invites[0].uid, 'uidA'); assert.equal(inv.invites[0].username, 'Alice'); assert.ok(inv.invites[0].ttl > 50000);
assert.equal((await B.do({ t: 'pdecline', uid: 'uidA' })).ok, true);
assert.equal(B.last('pinvites').invites.length, 0);
assert.equal((await A.do({ t: 'pinvite', uid: 'uidB' })).ok, true);
assert.equal((await B.do({ t: 'paccept', uid: 'uidA' })).ok, true);
await settle();
assert.deepEqual(members(A), ['uidA', 'uidB']); assert.equal(A.party().leader, 'uidA'); assert.deepEqual(members(B), ['uidA', 'uidB']);
// a non-leader invites her own friend
assert.equal((await B.do({ t: 'pinvite', uid: 'uidC' })).ok, true);
assert.equal((await C.do({ t: 'paccept', uid: 'uidB' })).ok, true);
await settle();
assert.deepEqual(members(A), ['uidA', 'uidB', 'uidC']); assert.deepEqual(members(C), ['uidA', 'uidB', 'uidC']);

// ---- permissions: non-leaders cannot kick / transfer / queue ----
assert.equal((await B.do({ t: 'pkick', uid: 'uidC' })).code, 'not_leader');
assert.equal((await B.do({ t: 'ptransfer', uid: 'uidC' })).code, 'not_leader');
B.send({ t: 'queue', mode: 'standard' });
assert.equal((await B.next('error')).code, 'not_leader');
assert.equal(app.mm.stats().queued + app.mm.stats().inLobby, 0);

// ---- leader leaves: the member who joined earliest (B) leads ----
assert.equal((await A.do({ t: 'pleave' })).ok, true); await settle();
assert.equal(A.party(), null); assert.equal(B.party().leader, 'uidB'); assert.deepEqual(members(C), ['uidB', 'uidC']);
// rejoin (A is B's friend), transfer, kick
assert.equal((await B.do({ t: 'pinvite', uid: 'uidA' })).ok, true); assert.equal((await A.do({ t: 'paccept', uid: 'uidB' })).ok, true); await settle();
assert.deepEqual(members(B), ['uidB', 'uidC', 'uidA']);
assert.equal((await B.do({ t: 'ptransfer', uid: 'uidC' })).ok, true); await settle();
assert.equal(A.party().leader, 'uidC'); assert.equal((await B.do({ t: 'pkick', uid: 'uidA' })).code, 'not_leader', 'B gave up the lead');
assert.equal((await C.do({ t: 'pkick', uid: 'uidA' })).ok, true); await settle();
assert.equal(A.party(), null); assert.equal(A.last('party').reason, 'kicked'); assert.deepEqual(members(B), ['uidB', 'uidC']);
// transfer back so the test is deterministic: leader B
assert.equal((await C.do({ t: 'ptransfer', uid: 'uidB' })).ok, true);

// ---- max size 4 ----
// A is B's friend; D is only A's friend -> A joins first, then invites D (member invites own friend)
assert.equal((await B.do({ t: 'pinvite', uid: 'uidA' })).ok, true); assert.equal((await A.do({ t: 'paccept', uid: 'uidB' })).ok, true);
assert.equal((await A.do({ t: 'pinvite', uid: 'uidD' })).ok, true); assert.equal((await D.do({ t: 'paccept', uid: 'uidA' })).ok, true); await settle();
assert.deepEqual(members(B), ['uidB', 'uidC', 'uidA', 'uidD']);
assert.equal((await A.do({ t: 'pinvite', uid: 'uidE' })).code, 'party_full');
assert.equal((await D.do({ t: 'pleave' })).ok, true); await settle();
assert.equal((await A.do({ t: 'pinvite', uid: 'uidE' })).ok, true); assert.equal((await A.do({ t: 'pinvite', uid: 'uidD' })).ok, true);
assert.equal((await E.do({ t: 'paccept', uid: 'uidA' })).ok, true); await settle();
assert.equal((await D.do({ t: 'paccept', uid: 'uidA' })).code, 'party_full');
assert.equal(B.party().members.length, 4);
assert.equal((await B.do({ t: 'pkick', uid: 'uidE' })).ok, true);
assert.equal((await B.do({ t: 'pkick', uid: 'uidA' })).ok, true); await settle();
assert.deepEqual(members(B), ['uidB', 'uidC']);

// ---- party game: B (leader) + C in a party, D solo. Queue: the whole party goes into one room with the solo ----
D.send({ t: 'queue', mode: 'standard' });
await D.next('queued');
B.send({ t: 'queue', mode: 'standard' });
const [sb, sc, sd] = await Promise.all([B.next('start'), C.next('start'), D.next('start')]);
assert.ok(C.msgs.some((m) => m.t === 'queued' || m.t === 'lobby'), 'the member was pulled into the queue without asking');
assert.deepEqual(sb.players.map((p) => p.uid).sort(), ['uidB', 'uidC', 'uidD']); assert.equal(sb.seed, sc.seed); assert.equal(sc.seed, sd.seed);
// leader cannot queue again while in the match; the party survives the game
B.send({ t: 'queue', mode: 'deathmatch' }); assert.equal((await B.next('error')).code, 'busy');
for (const c of [B, C, D]) c.play();
const [eb, ec, ed] = await Promise.all([B, C, D].map((c) => c.next('end', 60000)));
for (const c of [B, C, D]) clearInterval(c.timer);
const row = (e, uid) => e.ranks.find((r) => r.uid === uid);
for (const uid of ['uidB', 'uidC']) {
  const r = row(eb, uid);
  assert.equal(r.party, true, `${uid} flagged as a party member`); assert.equal(r.change, 'none');
  assert.deepEqual(r.rankAfter, r.rankBefore, 'no rank change for party members'); assert.deepEqual(r.rankBefore, mid);
  assert.deepEqual(await store.getRank(uid), mid, 'nothing was persisted');
}
const rd = row(ed, 'uidD');
assert.ok(!rd.party); assert.notDeepEqual(rd.rankAfter, rd.rankBefore, 'the solo player is ranked as usual');
assert.deepEqual(await store.getRank('uidD'), rd.rankAfter);
assert.deepEqual(ec.ranks.map((r) => r.party), eb.ranks.map((r) => r.party));
assert.equal(B.party().leader, 'uidB', 'the party outlives the match'); assert.deepEqual(members(C), ['uidB', 'uidC']);
assert.equal(app.rooms.size, 0);

// ---- a party of 4 starts at once; leaving the party in the lobby removes you from it ----
{
  assert.equal((await B.do({ t: 'pinvite', uid: 'uidA' })).ok, true); assert.equal((await A.do({ t: 'paccept', uid: 'uidB' })).ok, true);
  assert.equal((await A.do({ t: 'pinvite', uid: 'uidD' })).ok, true); assert.equal((await D.do({ t: 'paccept', uid: 'uidA' })).ok, true); await settle();
  B.send({ t: 'queue', mode: 'deathmatch' });
  const starts = await Promise.all([A, B, C, D].map((c) => c.next('start')));
  assert.equal(starts[0].players.length, 4);
  // everybody leaves the match (counts as a loss, but for party members nothing is saved)
  for (const c of [A, B, C, D]) c.send({ t: 'leave' });
  await sleep(300);
  assert.deepEqual(await store.getRank('uidA'), mid, 'leaving a party match does not cost rank');
}
// ---- queue control: the leader's cancel reaches the members; a member leaving the party leaves the search ----
{
  await B.do({ t: 'pkick', uid: 'uidA' }); await B.do({ t: 'pkick', uid: 'uidD' }); await settle();
  assert.deepEqual(members(B), ['uidB', 'uidC']);
  B.send({ t: 'queue', mode: 'deathmatch' });
  await C.next('lobby'); assert.equal(app.mm.stats().inLobby, 2);
  B.send({ t: 'leaveQueue' });
  assert.equal((await C.next('unqueued')).reason, 'leader'); await settle();
  assert.equal(app.mm.stats().inLobby + app.mm.stats().queued, 0);
  C.send({ t: 'leaveQueue' }); assert.equal((await C.next('error')).code, 'not_leader');
  B.send({ t: 'queue', mode: 'deathmatch' }); await C.next('lobby');
  assert.equal((await C.do({ t: 'pleave' })).ok, true); await settle();
  assert.equal(C.last('unqueued').reason, 'party'); assert.equal(B.party(), null, 'party of 2 dissolved');
  assert.equal(app.mm.stats().inLobby + app.mm.stats().queued, 1, 'the leader is still searching, now as a solo');
  B.send({ t: 'leaveQueue' }); await settle();
  assert.equal((await B.do({ t: 'pinvite', uid: 'uidC' })).ok, true); assert.equal((await C.do({ t: 'paccept', uid: 'uidB' })).ok, true); await settle();
}
// ---- grace on disconnect: the seat is kept; reconnecting restores the party ----
{
  const bPartyBefore = members(B);
  C.ws.close(); await sleep(150);
  assert.equal(B.party().members.find((m) => m.uid === 'uidC').online, false); assert.equal(members(B).length, bPartyBefore.length);
  const C2 = client('uidC', 'Carol'); await C2.hello(); await settle();
  assert.equal(C2.party().members.length, bPartyBefore.length); assert.equal(B.party().members.find((m) => m.uid === 'uidC').online, true);
  C2.ws.close();
}
for (const c of [A, B, D, E]) c.ws.close();
await app.close();
clearTimeout(guard);
console.log('party e2e passed');
