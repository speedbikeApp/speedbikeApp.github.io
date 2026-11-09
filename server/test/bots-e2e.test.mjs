// End-to-end over real WebSockets (dev auth, random port): abilities activate online and replicate to the other client, the lobby is
// filled with bots after the countdown, bots stay unranked. Sim runs at TIME_SCALE x like e2e.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { defaultRank } from '../../js/ranks.js';

const guard = setTimeout(() => { console.error('bots e2e timed out'); process.exit(1); }, 120000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bots-'));
const file = path.join(dir, 'ranks.json');
const store = createJsonStore(file);
const start1 = { ...defaultRank(), tier: 'He', div: 3, wins: 1 };    // a win = NEON 1
for (const u of ['h1', 'h2', 'h3']) await store.setRank(u, start1, u);
const app = createGameServer({ auth: createDevAuth(), store, timeScale: 40, countdownMs: 500, healthToken: 'tok', log: () => {} });
const port = await app.listen(0);

function client(uid) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, uid, msgs: [], waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.next = (test, ms = 30000) => { const f = typeof test === 'function' ? test : (m) => m.t === test; const old = c.msgs.find(f); if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error(`${uid} timed out waiting for ${test}`)), ms); c.waiters.push({ test: f, resolve: (m) => { clearTimeout(to); resolve(m); } }); }); };
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; c.send({ t: 'hello', dev: true, uid, username: uid.toUpperCase() }); return c.next('welcome'); };
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await fetch(`http://127.0.0.1:${port}/health?detail=tok`)).json();

// ---- two humans queue: after the (short) countdown the lobby is filled with two bots; loadouts travel with the queue ----
const [a, b] = [client('h1'), client('h2')];
await a.hello(); await b.hello();
a.send({ t: 'queue', mode: 'standard', loadout: ['turbo', 'protector', 'bogus', 'turbo'] });
b.send({ t: 'queue', mode: 'standard' });
const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
assert.equal(sa.players.length, 4, 'filled to 4');
assert.deepEqual(sa.players.map((p) => !!p.bot), [false, false, true, true]);
assert.deepEqual(sa.players.slice(0, 2).map((p) => p.uid).sort(), ['h1', 'h2']);
for (const p of sa.players.filter((q) => q.bot)) { assert.match(p.username, /^BOT \w+/); assert.equal(p.uid, null); assert.equal(p.rank, null); assert.equal(p.loadout.length, 0, 'medium bots carry no abilities'); }
assert.equal(new Set(sa.players.map((p) => p.colorIdx)).size, 4);
const ia = sa.players.find((p) => p.uid === 'h1'), ib = sa.players.find((p) => p.uid === 'h2');
assert.deepEqual(ia.loadout, ['turbo', 'protector'], 'queue loadout sanitized (unknown + duplicate dropped)'); assert.deepEqual(ib.loadout, []);
assert.equal(sa.you, ia.id); assert.equal(sb.you, ib.id);
assert.equal((await health()).rooms, 1);

// final loadout during the countdown (spent passives etc.), relayed to the other client
b.send({ t: 'loadout', abilities: ['stealth', 'nonsense'] });
const lb = await a.next((m) => m.t === 'loadout' && m.id === ib.id);
assert.deepEqual(lb.abilities, ['stealth']);

// activate Turbo as soon as the round runs: the server confirms with an ev that BOTH clients get; a second press is refused (cooldown)
await a.next((m) => m.t === 'round' && m.phase === 'running');
const press = () => a.send({ t: 'in', kind: 'ability', ability: 'turbo', ctick: a.msgs.filter((m) => typeof m.tick === 'number').at(-1).tick });
const isAb = (m) => m.t === 'ev' && m.kind === 'ability';
for (let k = 0; k < 200 && !a.msgs.some(isAb); k++) { press(); await sleep(10); } // random spawns: h1 may start falling off a step (no turbo in the air)
const eva = await a.next(isAb); const evb = await b.next(isAb);
assert.equal(eva.id, ia.id); assert.equal(eva.ability, 'turbo'); assert.deepEqual([evb.id, evb.ability, evb.tick], [eva.id, 'turbo', eva.tick]);
press(); a.send({ t: 'in', kind: 'ability', ability: 'stealth' }); // stealth is not in h1's loadout
await sleep(300);
const rEnd = a.msgs.find((m) => m.t === 'round' && m.phase === 'roundEnd' && m.tick >= eva.tick)?.tick ?? Infinity; // timeScale 40: the next round (fresh cooldowns) can start within the wait
assert.equal(a.msgs.filter((m) => isAb(m) && m.tick >= eva.tick && m.tick < rEnd).length, 1, 'cooldown + not-equipped activations refused');
const snap = a.msgs.find((m) => m.t === 'snap' && m.tick > eva.tick && m.bikes[ia.id].ab?.cd?.turbo > 0); // after the press (the event carries the input tick; a later round reset clears it)
assert.ok(snap && snap.bikes[ia.id].ab.cd.turbo > 0, 'snapshots carry the cooldown');
// bots drive (events from bot bikes reach the humans)
await a.next((m) => m.t === 'ev' && m.id >= 2 && m.kind === 'turn');
// a human cannot act for a bot
b.send({ t: 'in', kind: 'turn', side: 1, ctick: 0 });
const h = await health(); assert.equal(h.roomStats[0].bots, 2); assert.ok(h.loop.cpuPct >= 0);

// play on until the match ends: nobody pressing anything dies on the edge, the bots decide the result
const [ea, eb] = await Promise.all([a.next('end', 90000), b.next('end', 90000)]);
assert.equal(ea.ranks.length, 4);
const bots = ea.ranks.filter((r) => r.bot), humans = ea.ranks.filter((r) => !r.bot);
assert.equal(bots.length, 2); assert.ok(bots.every((r) => r.uid === null && r.rankBefore === null && r.rankAfter === null && r.change === 'none' && !r.left));
assert.deepEqual(humans.map((r) => r.uid).sort(), ['h1', 'h2']);
for (const r of humans) {
  assert.equal(r.rankBefore.v, 2);
  if (r.won) { assert.equal(r.place, 1); assert.deepEqual([r.rankAfter.tier, r.rankAfter.div, r.change], ['Ne', 1, 'promote']); }
  else { assert.deepEqual([r.rankAfter.tier, r.rankAfter.div, r.rankAfter.wins, r.change], ['He', 3, 0, 'none'], 'a loss to bots is a normal loss'); }
}
assert.deepEqual(eb.ranks.map((r) => r.place), ea.ranks.map((r) => r.place));
await store.flush();
const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.deepEqual(Object.keys(disk).sort(), ['h1', 'h2', 'h3'], 'no rank record for any bot');
assert.equal(disk.h3.div, 3, 'uninvolved players untouched');
await sleep(100); assert.equal(app.rooms.size, 0);

// ---- three humans + one bot; queued with loadouts via the standalone `loadout` message (what a party member does) ----
{
  const [x, y, z] = ['h1', 'h2', 'h3'].map((u) => client(u + 'b'));
  for (const c of [x, y, z]) await c.hello();
  z.send({ t: 'loadout', abilities: ['allBoost'] });
  for (const c of [x, y, z]) c.send({ t: 'queue', mode: 'deathmatch' });
  const s = await z.next('start');
  assert.equal(s.players.length, 4); assert.equal(s.players.filter((p) => p.bot).length, 1);
  assert.deepEqual(s.players.find((p) => p.uid === 'h3b').loadout, ['allBoost']);
  for (const c of [x, y, z]) c.send({ t: 'leave' });
  await sleep(300);
  for (const c of [x, y, z]) c.ws.close();
}

// ---- a full lobby of 4 humans starts at once with no bots ----
{
  const cs = ['p1', 'p2', 'p3', 'p4'].map((u) => client(u));
  for (const c of cs) await c.hello();
  for (const c of cs) c.send({ t: 'queue', mode: 'standard' });
  const s = await cs[0].next('start');
  assert.equal(s.players.filter((p) => p.bot).length, 0);
  for (const c of cs) c.send({ t: 'leave' });
  await sleep(300);
  for (const c of cs) c.ws.close();
}
for (const c of [a, b]) c.ws.close();
await app.close();
fs.rmSync(dir, { recursive: true, force: true });
clearTimeout(guard);
console.log('bots e2e ok');
