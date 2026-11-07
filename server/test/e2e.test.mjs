// End-to-end: a real server on a random port, real `ws` clients in dev-auth mode. The sim runs at TIME_SCALE x so a whole
// match takes a few seconds; game rules are untouched.
// Latency option: E2E_RTT_MS=150 (+ E2E_JITTER_MS) delays every message each way by RTT/2 (+-jitter, order kept) like a real WAN link.
// Delays are real milliseconds, so latency runs use TIME_SCALE 1 (see e2e-lag.test.mjs); the bots then send a realistic `ctick`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { defaultRank } from '../../js/ranks.js';

const RTT = Number(process.env.E2E_RTT_MS) || 0, JITTER = Number(process.env.E2E_JITTER_MS) || 0, SCALE = RTT ? 1 : 40;
const guard = setTimeout(() => { console.error('e2e timed out'); process.exit(1); }, RTT ? 300000 : 120000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
const file = path.join(dir, 'ranks.json');
const store = createJsonStore(file);
const tierPoint = { ...defaultRank(), tier: 'He', div: 3, wins: 1 };
for (const u of ['a', 'b', 'c', 'd']) await store.setRank(u, tierPoint, u);   // whoever wins reaches NEON
await store.setRank('x', { ...defaultRank(), tier: 'Ne', div: 1, wins: 0 }, 'x'); // leaver-to-be: loses -> demoted to He 3 (1 win)

const app = createGameServer({ auth: createDevAuth(), store, timeScale: SCALE, countdownMs: 400, log: () => {} });
const port = await app.listen(0);

const lat = () => Math.max(0, RTT / 2 + (Math.random() * 2 - 1) * JITTER);
function client(uid, username = uid.toUpperCase()) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, uid, msgs: [], waiters: [], you: null, timer: null, lastTick: null };
  const lastAt = { in: 0, out: 0 };
  const delayed = (dir, fn) => { if (!RTT) return fn(); const at = Math.max(lastAt[dir], Date.now() + lat()); lastAt[dir] = at; setTimeout(fn, at - Date.now()); }; // ordered, like TCP
  ws.on('message', (d) => delayed('in', () => {
    const m = JSON.parse(d); c.msgs.push(m);
    if (m.t === 'start') c.you = m.you;
    if (typeof m.tick === 'number') c.lastTick = { tick: m.tick, at: Date.now() };
    c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false));
  }));
  c.send = (m) => delayed('out', () => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); });
  // the client's estimate of the server tick NOW: last tick seen + time since + the one-way latency it has been delayed by
  c.ctick = () => (c.lastTick ? Math.round(c.lastTick.tick + (Date.now() - c.lastTick.at + RTT / 2) * 0.12 * SCALE) : 0);
  c.wait = (t, ms = 60000) => { const old = c.msgs.find((m) => m.t === t); if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error(`${uid} timed out waiting for ${t}`)), ms); c.waiters.push({ test: (m) => m.t === t, resolve: (m) => { clearTimeout(to); resolve(m); } }); }); };
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; c.send({ t: 'hello', dev: true, uid, username }); return c.wait('welcome'); };
  c.play = () => { // random turns + the odd jump / boost, like a drunk bot
    c.timer = setInterval(() => {
      if (ws.readyState !== 1) return;
      const r = Math.random();
      c.send(r < 0.8 ? { t: 'in', kind: 'turn', side: Math.random() < 0.5 ? -1 : 1, ctick: c.ctick() } : { t: 'in', kind: r < 0.9 ? 'jump' : 'boost', ctick: c.ctick() });
    }, 40);
  };
  return c;
}

// ---- health + auth gate ----
const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
assert.equal(health.ok, true); assert.equal(health.auth, 'dev');
assert.equal(health.loop.intervalMs, 16, 'coarse scheduler'); assert.ok(Array.isArray(health.roomStats));
{
  const raw = client('nobody'); await raw.open; raw.send({ t: 'queue', mode: 'standard' });
  const err = await raw.wait('error'); assert.equal(err.code, 'not_authed');
  raw.ws.send('garbage'); raw.ws.send(JSON.stringify({ t: 'hello', dev: true, uid: 'bad uid', username: 'x' }));
  await new Promise((r) => setTimeout(r, 100)); assert.ok(raw.msgs.filter((m) => m.t === 'error').length >= 3);
  raw.ws.close();
}

// ---- match 1: four clients play a standard match to the end ----
const obs = client('obs'); const w = await obs.hello();
assert.equal(w.t, 'welcome'); assert.equal(w.rank.tier, 'He'); assert.ok(['hyper', '3d'].includes(w.featured)); assert.ok(w.nextRotation > w.serverNow);
const cs = ['a', 'b', 'c', 'd'].map((u) => client(u));
for (const c of cs) { const wel = await c.hello(); assert.equal(wel.rank.wins, 1); c.send({ t: 'queue', mode: 'standard' }); }
await Promise.all(cs.map((c) => c.wait('start')));
const start = cs[0].msgs.find((m) => m.t === 'start');
assert.equal(start.players.length, 4); assert.equal(new Set(start.players.map((p) => p.colorIdx)).size, 4);
assert.deepEqual(cs.map((c) => c.you).sort(), [0, 1, 2, 3]);
assert.ok(cs[0].msgs.some((m) => m.t === 'lobby'), 'lobby message before start');
cs.forEach((c) => c.play());
let lastRoom = null;   // last /health room stats seen during the match (the room is gone after the end)
const poll = setInterval(async () => { try { const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); if (h.roomStats[0]) lastRoom = { ...h.roomStats[0], loop: h.loop }; } catch { /* closing */ } }, 250);
const ends = await Promise.all(cs.map((c) => c.wait('end')));
cs.forEach((c) => clearInterval(c.timer)); clearInterval(poll);
assert.ok(lastRoom && lastRoom.updates > 0 && lastRoom.lagComp.inputs > 0, 'health reports room timing + lag compensation stats');
if (RTT) {
  assert.ok(lastRoom.lagComp.rewound > 0, 'inputs were lag compensated');
  console.log(`  [lag e2e RTT ${RTT}+-${JITTER} ms] room: ${JSON.stringify({ avgMs: lastRoom.avgMs, maxMs: lastRoom.maxMs, behindMax: lastRoom.behindMax, ...lastRoom.lagComp })}`);
  assert.ok(lastRoom.maxMs < 50 && lastRoom.behindMax < 10, 'server loop kept up: ' + JSON.stringify(lastRoom));
}

for (const kind of ['ev', 'snap', 'crash', 'round']) assert.ok(cs[0].msgs.some((m) => m.t === kind), `saw ${kind}`);
assert.ok(cs[0].msgs.filter((m) => m.t === 'round').some((m) => m.phase === 'roundEnd'));
const end = ends[0];
assert.deepEqual(ends.map((e) => JSON.stringify(e.ranks)).filter((v, i, a) => a.indexOf(v) === i).length, 1, 'everyone gets the same result');
assert.equal(end.ranks.length, 4);
const winners = end.ranks.filter((r) => r.won);
assert.ok(winners.length <= 1);
for (const r of end.ranks) {
  assert.equal(r.rankBefore.tier + r.rankBefore.div + r.rankBefore.wins, 'He31');
  if (r.won) { assert.equal(r.place, 1); assert.equal(r.change, 'promote'); assert.deepEqual([r.rankAfter.tier, r.rankAfter.div, r.rankAfter.wins], ['Ne', 1, 0]); }
  else { assert.equal(r.rankAfter.wins, 0); assert.equal(r.rankAfter.div, 3); assert.equal(r.change, 'none'); }
  assert.equal(r.rankAfter.matches, 1);
}
// announcements reach everyone, including someone sitting in the menu
if (winners.length) {
  const name = winners[0].username;
  const a = await obs.wait('announce', 5000);
  assert.deepEqual([a.kind, a.text], ['tierUp', `${name} reached NEON!`]);
  await Promise.all(cs.map((c) => c.wait('announce', 5000)));
} else console.log('(match 1 had a shared first place: no promotion)');
await store.flush();
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const r of end.ranks) assert.deepEqual([saved[r.uid].tier, saved[r.uid].div, saved[r.uid].wins], [r.rankAfter.tier, r.rankAfter.div, r.rankAfter.wins], 'persisted');

// ---- match 2: two humans + two bots. A player vanishes mid-match -> loss for them; the other plays on against the bots ----
{
  const x = client('x'), y = client('y');
  await x.hello(); await y.hello();
  x.send({ t: 'queue', mode: 'deathmatch' }); y.send({ t: 'queue', mode: 'deathmatch' });
  const [sx] = await Promise.all([x.wait('start'), y.wait('start')]);
  assert.equal(sx.players.length, 4, 'two humans + two bots after the countdown');
  assert.deepEqual(sx.players.map((p) => !!p.bot), [false, false, true, true]); assert.ok(sx.players.slice(2).every((p) => /^BOT /.test(p.username) && p.uid === null && p.rank === null));
  assert.equal(new Set(sx.players.map((p) => p.colorIdx)).size, 4);
  await y.wait('round'); await new Promise((r) => setTimeout(r, 300));
  x.ws.terminate(); // socket dropped: charged a loss at once
  for (let i = 0; i < 100 && (await store.getRank('x')).div !== 3; i++) await new Promise((r) => setTimeout(r, 50));
  const rxs = await store.getRank('x'); assert.deepEqual([rxs.tier, rxs.div, rxs.wins], ['He', 3, 1], 'leaver demoted Ne 1 -> He 3');
  await new Promise((r) => setTimeout(r, 300));
  const yend = y.msgs.find((m) => m.t === 'end'); // fast sims may already be over: then it was a normal finish, never a forfeit
  assert.ok(!yend || yend.reason === 'normal', 'the last human plays on against the bots (no forfeit while bots are in the room); results with bots: bots-e2e');
  if (!yend) { assert.equal(app.rooms.size, 1); y.send({ t: 'leave' }); await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(app.rooms.size, 0, 'room closes when no human is left');
  await store.flush();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([disk.x.tier, disk.x.div], ['He', 3]); assert.equal(Object.keys(disk).filter((k) => /bot/i.test(k) || k === 'null').length, 0, 'bots have no rank record');
  // the survivor is free to queue again
  y.send({ t: 'queue', mode: 'standard' }); assert.equal((await new Promise((res) => { y.waiters.push({ test: (m) => m.t === 'queued', resolve: res }); })).position, 1);
  y.ws.close();
}

// ---- ping ----
{
  obs.send({ t: 'ping', c: 42 }); const p = await new Promise((res) => obs.waiters.push({ test: (m) => m.t === 'pong', resolve: res }));
  assert.equal(p.c, 42); assert.ok(Math.abs(p.serverNow - Date.now()) < 5000);
}

for (const c of [obs, ...cs]) c.ws.close();
await app.close();
fs.rmSync(dir, { recursive: true, force: true });
clearTimeout(guard);
console.log(`e2e ok (match 1: ${winners.length ? winners[0].username + ' won' : 'no sole winner'}, ${end.ranks.length} players, port ${port})`);
