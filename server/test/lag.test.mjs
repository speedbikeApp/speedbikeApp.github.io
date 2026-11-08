// Lag compensation: simulated 60 / 150 / 250 ms RTT (+ jitter) between the real Room and four client sims (virtual time, see lagsim.mjs),
// plus room-level anti-abuse cases. Prints the measured corrections so tuning is visible in the test log.
import assert from 'node:assert/strict';
import { Room } from '../room.js';
import { CFG } from '../../js/config.js';
import { defaultRank } from '../../js/ranks.js';
import { runLag, diffWorlds, mulberry } from './lagsim.mjs';

const f = (v) => v.toFixed(3);
const SPEED = CFG.baseSpeed, TICK_U = SPEED / CFG.tickHz;       // 0.125 units per tick
const CAP_MS = CFG.net.maxRewindMs;

// ---------------------------------------------------------------- latency scenarios
// Deterministic pinwheel (all four bikes turn right at the same times: symmetric, nobody crashes within 4.2 s) with a jump and a boost.
const pinwheel = [];
for (let w = 0; w < 4; w++) for (const [at, side] of [[1000, 1], [2500, 1], [3400, 1]]) pinwheel.push({ at: at + w * 7, who: w, kind: 'turn', side });
pinwheel.push({ at: 400, who: 3, kind: 'boost' }, { at: 1700, who: 2, kind: 'jump' });
const ownOf = (r) => r.clients.flatMap((c) => c.ownEv);
const stat = (arr) => ({ n: arr.length, max: Math.max(0, ...arr), mean: arr.reduce((a, v) => a + v, 0) / (arr.length || 1) });
const rows = [];

for (const [rtt, jit] of [[60, 10], [150, 15], [250, 20]]) {
  // old behaviour (cap 0 = every input applied at the server's current tick) vs lag compensation
  const base = runLag({ rttMs: rtt, jitterMs: jit, seconds: 4.2, presses: pinwheel, seed: 3, maxRewindMs: 0 });
  const r = runLag({ rttMs: rtt, jitterMs: jit, seconds: 4.2, presses: pinwheel, seed: 3 });
  assert.equal(r.clients[0].crashes.length, 0, 'scenario has no crash');
  const own = ownOf(r), b = ownOf(base);
  const corr = stat(own.map((e) => e.corr)), landing = stat(own.map((e) => e.landing ?? 0)), rem = stat(r.clients.flatMap((c) => c.remoteCorr.map((e) => e.corr)));
  const bcorr = stat(b.map((e) => e.corr));
  assert.ok(own.length >= 12, 'own events seen');
  assert.ok(landing.max < 0.01, `rtt ${rtt}: the turn lands where the player turned (max ${landing.max})`);
  assert.ok(corr.max < 0.01, `rtt ${rtt}: no own-bike correction (max ${corr.max})`);
  assert.ok(bcorr.max > corr.max + 0.3, `rtt ${rtt}: without lag compensation the correction is visible (${bcorr.max})`);
  assert.ok(Math.max(0, ...r.clients.flatMap((c) => c.snapErr.filter((s) => s.own).map((s) => s.err))) < 0.01, 'own snaps agree');
  const d = diffWorlds(r); assert.deepEqual(d, [], `rtt ${rtt}: identical worlds incl. trails`);
  const lc = r.room.statsView().lagComp;
  assert.equal(lc.rewound, lc.inputs, 'every input rewound'); assert.equal(lc.clamped, 0);
  rows.push(`  RTT ${String(rtt).padStart(3)} ms (+-${jit} jitter): own correction max ${f(corr.max)} (was ${f(bcorr.max)} without lag comp), turn landing error max ${f(landing.max)}, remote bike error shown max ${f(rem.max)} (smoothed), avg rewind ${lc.avgRewindTicks} ticks, worlds identical`);
}

// Longer random-bot matches (crashes, rounds, jumps, boosts): own-bike corrections stay ~0 over many events
for (const rtt of [60, 150, 250]) {
  const own = [], ownBase = [];
  const seeds = [1, 2, 3, 4, 5, 6];
  for (const seed of seeds) {
    const rnd = mulberry(seed * 31 + rtt), presses = [];
    for (let w = 0; w < 4; w++) for (let at = 300; at < 12000; at += 250 + rnd() * 700) presses.push({ at, who: w, kind: rnd() < 0.85 ? 'turn' : rnd() < 0.5 ? 'jump' : 'boost', side: rnd() < 0.5 ? -1 : 1 });
    const r = runLag({ rttMs: rtt, jitterMs: 20, seconds: 14, presses, seed });
    own.push(...ownOf(r).map((e) => e.corr));
    ownBase.push(...ownOf(runLag({ rttMs: rtt, jitterMs: 20, seconds: 14, presses, seed, maxRewindMs: 0 })).map((e) => e.corr));
  }
  const s = stat(own), sb = stat(ownBase), big = own.filter((v) => v > 0.5).length;
  assert.ok(s.n > 100);
  assert.ok(s.mean < 0.02 && big === 0, `rtt ${rtt}: random match own corrections: mean ${s.mean}, >0.5u: ${big}`);
  assert.ok(sb.mean > s.mean * 10 + 0.2, `lag comp clearly better than before (${sb.mean} -> ${s.mean})`);
  rows.push(`  random bots RTT ${String(rtt).padStart(3)} ms: ${s.n} own events, mean correction ${f(s.mean)} max ${f(s.max)}  (without lag comp: mean ${f(sb.mean)} max ${f(sb.max)})`);
}

{ // beyond the cap (RTT 400 -> one-way 200 > 150 ms): the part past the cap is NOT compensated, so the error is bounded by it
  const jit = 20, rtt = 400;
  const r = runLag({ rttMs: rtt, jitterMs: jit, seconds: 4.2, presses: pinwheel, seed: 3 });
  const own = ownOf(r), lc = r.room.statsView().lagComp;
  const excessMs = rtt / 2 + jit - CAP_MS, bound = (excessMs / 1000 * SPEED + 0.5) * Math.SQRT2;
  const corr = stat(own.map((e) => e.corr));
  assert.ok(lc.clamped > 0, 'inputs were clamped to the cap');
  assert.ok(corr.max <= bound && corr.max > 0, `bounded correction beyond the cap: ${corr.max} <= ${bound}`);
  assert.ok(lc.maxRewindTicks <= Math.ceil(CAP_MS * CFG.tickHz / 1000), 'never rewinds past the cap');
  assert.deepEqual(diffWorlds(r), [], 'worlds still converge beyond the cap');
  rows.push(`  RTT ${rtt} ms (+-${jit}, beyond the ${CAP_MS} ms cap): own correction max ${f(corr.max)} <= bound ${f(bound)} (smoothed), ${lc.clamped}/${lc.inputs} inputs clamped, worlds identical`);
}

{ // client claims a bogus tick on every input (always "now - 1 s"): clamped to the cap, never more than the cap in the past
  const lie = pinwheel.map((p) => ({ ...p, ctickOverride: (t) => t - 120 }));
  const r = runLag({ rttMs: 60, jitterMs: 5, seconds: 4.2, presses: lie, seed: 3 });
  const lc = r.room.statsView().lagComp;
  assert.ok(lc.clamped >= lc.inputs - 2, 'all stale ticks clamped'); assert.ok(lc.maxRewindTicks <= Math.ceil(CAP_MS * CFG.tickHz / 1000));
}

// ---------------------------------------------------------------- room-level cases
function harness(mode = 'standard') {
  const msgs = [[], [], [], []], h = { msgs, t: 0 };
  const players = [0, 1, 2, 3].map((i) => ({ uid: 'u' + i, username: 'P' + i, rank: defaultRank(), colorIdx: i, send: (m) => msgs[i].push(m) }));
  h.room = new Room({ id: 1, mode, players, seed: 7, onEnd: () => {}, onLeave: () => {} });
  h.ticks = (n) => { for (let i = 0; i < n; i++) { h.t = h.room.t0 + (h.room.done + 1) * 1000 / CFG.tickHz + 0.01; h.room.update(h.t); } };
  h.run = () => { for (let t = 0; t <= 3200; t += 100) h.room.update(t); h.t = 3200; assert.equal(h.room.match.phase, 'running'); };
  h.bike = (i) => h.room.state.bikes[i];
  h.evs = (id, kind) => msgs[0].filter((m) => m.t === 'ev' && m.id === id && (!kind || m.kind === kind));
  h.crashes = () => msgs[0].filter((m) => m.t === 'crash');
  // teleport a bike (call between ticks); `back` units of existing trail behind it so it may turn at once
  h.place = (i, x, z, dx, dz, back = 5) => { const b = h.bike(i); b.x = x; b.z = z; b.dx = dx; b.dz = dz; b.trail.length = 0; b.trail.push({ x1: x - dx * back, z1: z - dz * back, x2: x, z2: z, y0: 0, h: CFG.trailHeight, owner: i }); b.sinceTurn = back; };
  return h;
}
const CAP_TICKS = Math.ceil(CAP_MS * CFG.tickHz / 1000);

{ // time-aware replay: the turner is NOT killed by a trail that was laid after the claimed tick ...
  const h = harness(); h.run(); h.ticks(1);
  const P = h.room.tick;
  h.place(0, 0, 0, 1, 0); h.place(1, 1.75, 0.9, -1, 0);        // bike 1 crosses bike 0's NEW lane (x=0.25) at P+12, bike 0 would be there at z=0.9 at P+9
  h.ticks(14);                                                  // processing tick = P+14
  h.room.input(0, { kind: 'turn', side: 1, ctick: P + 2 }); h.ticks(1);
  const ev = h.evs(0, 'turn').at(-1);
  assert.equal(ev.tick, P + 2); assert.ok(ev.dx === 0 && ev.dz === 1); assert.ok(Math.abs(ev.x - 0.25) < 1e-9 && Math.abs(ev.z) < 1e-9, 'turned at the claimed spot');
  assert.ok(h.bike(0).alive && h.bike(1).alive, 'trail laid after the claimed tick does not kill the turner'); assert.equal(h.crashes().length, 0);
  assert.equal(h.bike(0).trail.length, 2, 'trail follows the rewritten path');
  const b0 = h.bike(0), seg = b0.trail.at(-1);
  assert.ok(Math.abs(b0.x - 0.25) < 1e-9 && Math.abs(b0.z - (h.room.tick - (P + 2)) * TICK_U) < 1e-6, 'bike re-simulated along the new lane up to now');
  assert.ok(Math.abs(seg.x2 - b0.x) < 1e-9 && Math.abs(seg.z2 - b0.z) < 1e-9);
}
{ // ... but IS killed (killer = trail owner) when that trail already stood in its way at the replayed time
  const h = harness(); h.run(); h.ticks(1);
  const P = h.room.tick;
  h.place(0, 0, 0, 1, 0); h.place(1, 0.75, 0.9, -1, 0);
  h.ticks(14);
  h.room.input(0, { kind: 'turn', side: 1, ctick: P + 2 }); h.ticks(1);
  assert.equal(h.evs(0, 'turn').at(-1).tick, P + 2, 'event still reports the turn');
  const c = h.crashes(); assert.equal(c.length, 1); assert.equal(c[0].victim, 0); assert.equal(c[0].killer, 1); assert.equal(c[0].cause, 'trail');
  assert.ok(!h.bike(0).alive && h.bike(1).alive);
  // a dead bike is not revived by any later input, even one claiming a tick before the crash
  const n = h.msgs[0].length;
  h.room.input(0, { kind: 'turn', side: -1, ctick: P + 3 }); h.room.input(0, { kind: 'jump', ctick: P }); h.ticks(2);
  assert.ok(!h.bike(0).alive, 'stays dead'); assert.equal(h.evs(0).filter((e) => e.tick >= P + 3).length, 0, 'no event for a dead bike');
  assert.equal(h.msgs[0].slice(n).filter((m) => m.t === 'ev' && m.id === 0).length, 0);
}
{ // clamp to the cap / future ctick / missing ctick / per-bike monotonic ticks
  const h = harness(); h.run(); h.ticks(60);
  const s0 = h.room.stats;
  let T = h.room.tick;
  h.room.input(2, { kind: 'turn', side: 1, ctick: 0 }); h.ticks(1);
  assert.equal(h.evs(2, 'turn').at(-1).tick, T - CAP_TICKS, 'ancient ctick clamped to the cap'); assert.equal(s0.clamped, 1);
  T = h.room.tick;
  h.room.input(3, { kind: 'turn', side: 1, ctick: T + 500 }); h.ticks(1);
  assert.equal(h.evs(3, 'turn').at(-1).tick, T, 'future ctick applied at the current tick'); assert.equal(s0.future, 1);
  T = h.room.tick;
  h.room.input(1, { kind: 'turn', side: -1 }); h.ticks(1);
  assert.equal(h.evs(1, 'turn').at(-1).tick, T, 'no ctick: current tick');
  T = h.room.tick;
  h.room.input(0, { kind: 'boost', ctick: T - 6 }); h.room.input(0, { kind: 'jump', ctick: T - 12 }); h.ticks(1);
  assert.equal(h.evs(0, 'boost').at(-1).tick, T - 6); assert.equal(h.evs(0, 'jump').at(-1).tick, T - 6, 'a later input is never applied before an earlier one');
  assert.ok(h.bike(0).boosting && h.bike(0).jumpT >= 0);
  // event state is the bike at the event tick (not now)
  const e = h.evs(0, 'jump').at(-1), now = h.bike(0);
  assert.ok(Math.abs(now.x - e.x) + Math.abs(now.z - e.z) > 0.5 * TICK_U, 'ev carries the state at its tick'); assert.equal(e.y, 0);
}
{ // a ctick before a recorded crash cannot undo it (guard), and a respawned bike's new life cannot be rewound into the old one
  const h = harness(); h.run(); h.ticks(40);
  h.room.deathTick[1] = h.room.tick - 3;                       // pretend bike 1 crashed 3 ticks ago and is (impossibly) alive again
  const T = h.room.tick, n = h.evs(1).length;
  h.room.input(1, { kind: 'turn', side: 1, ctick: T - 10 }); h.ticks(1);
  assert.equal(h.evs(1).length, n, 'input claiming a tick before the crash is ignored'); assert.equal(h.room.stats.ignored, 1);
}
{ // Death Match: ctick from a previous life has no history (epoch bumped by the crash / respawn) -> applied now, not in the old life
  const h = harness('deathmatch'); h.run(); h.ticks(30);
  const oldTick = h.room.tick;
  h.place(1, 500, 500, 1, 0);                                  // off the platform: falls and crashes
  h.ticks(250); assert.ok(!h.bike(1).alive);
  for (let i = 0; i < 400 && !h.bike(1).alive; i++) h.ticks(1);
  assert.ok(h.bike(1).alive, 'respawned'); const respawnTick = h.evs(1, 'respawn').at(-1).tick;
  h.ticks(20);
  const T = h.room.tick, fb = h.room.stats.fallback;
  h.room.input(1, { kind: 'jump', ctick: oldTick }); h.ticks(1);
  const j = h.evs(1, 'jump').at(-1);
  assert.ok(j && j.tick >= respawnTick, 'applied in the new life only'); assert.ok(j.tick >= T - CAP_TICKS);
  assert.ok(h.room.stats.fallback >= fb);
}
{ // a rewound turn that the bike could not take at that tick (inside the min turn gap) falls back to the normal buffered path
  const h = harness(); h.run(); h.ticks(20);
  h.place(0, 0, 0, 1, 0, 0.2);                                 // newest segment shorter than minTurnGap
  h.ticks(2);
  const T = h.room.tick;
  h.room.input(0, { kind: 'turn', side: 1, ctick: T - 1 }); h.ticks(1);
  assert.equal(h.room.stats.fallback, 1); assert.equal(h.room.stats.rewound, 0);
  h.ticks(12);
  assert.equal(h.evs(0, 'turn').length, 1, 'buffered turn applied once the gap opened'); assert.ok(h.evs(0, 'turn')[0].tick >= T);
}
{ // history survives many ticks (ring wrap) and round restarts; rewinds keep working in round 2
  const h = harness(); h.run(); h.ticks(300);
  let T = h.room.tick;
  h.room.input(0, { kind: 'turn', side: 1, ctick: T - 7 }); h.ticks(1);
  assert.equal(h.evs(0, 'turn').at(-1).tick, T - 7); assert.equal(h.room.stats.rewound, 1);
}

// ---------------------------------------------------------------- scheduler
{ // a 16 ms wake-up runs ~2 ticks per call (catch-up) and stays drift-free; timing stats are reported
  const h = harness(); let calls = 0;
  for (let t = 0; t <= 2000; t += 16, calls++) h.room.update(t);
  assert.ok(Math.abs(h.room.tick - 240) <= 2, 'ticks after 2 s at 16 ms wake-ups: ' + h.room.tick);
  const s = h.room.statsView();
  assert.equal(s.updates, calls); assert.ok(Math.abs(s.ticks / s.updates - 1.92) < 0.1, 'ticks per wake-up ' + s.ticks / s.updates);
  assert.ok(s.avgMs >= 0 && s.avgMs < 50 && s.maxMs >= s.avgMs && s.behindMax >= 1 && s.behindMax <= 3, JSON.stringify(s));
  assert.ok('lagComp' in s && s.skipped === 0);
}

console.log('lag tests ok\n' + rows.join('\n'));
