import assert from 'node:assert/strict';
import { Room } from '../room.js';
import { defaultRank } from '../../js/ranks.js';

function harness(mode = 'standard', opts = {}) {
  const msgs = [[], [], [], []], h = { msgs, ended: null, left: [], t: 0 };
  const players = [0, 1, 2, 3].map((i) => ({ uid: 'u' + i, username: 'P' + i, rank: defaultRank(), colorIdx: i, send: (m) => msgs[i].push(m) }));
  h.room = new Room({ id: 1, mode, players, seed: 7, onEnd: (r, info) => { h.ended = info; }, onLeave: (p) => h.left.push(p.id), ...opts });
  h.advance = (sec) => { for (let s = 0; s < sec; s += 0.25) { h.t += Math.min(0.25, sec - s) * 1000; h.room.update(h.t); } };
  h.of = (i, t) => msgs[i].filter((m) => m.t === t);
  h.bike = (i) => h.room.state.bikes[i];
  h.run = () => { h.advance(0.001); h.advance(3.2); assert.equal(h.room.match.phase, 'running'); }; // through the countdown
  h.drop = (...ids) => ids.forEach((i) => { const b = h.bike(i), seg = b.trail.at(-1); b.x = seg.x1 = seg.x2 = seg.z1 = seg.z2 = 500; b.z = 500; }); // teleport (with its trail head) off the platform: falls, crashes with cause 'void' ~0.8 s later
  return h;
}

{ // start + countdown + running transition
  const h = harness(); h.advance(0.001);
  const [start, round] = h.msgs[2];
  assert.equal(start.t, 'start'); assert.equal(start.you, 2); assert.equal(start.mapId, 'arena'); assert.equal(start.players.length, 4);
  assert.deepEqual(start.players.map((p) => p.colorIdx), [0, 1, 2, 3]); assert.equal(start.tick0, 0);
  assert.equal(round.t, 'round'); assert.equal(round.phase, 'countdown'); assert.equal(round.bikes.length, 4);
  assert.equal(new Set(round.bikes.map((b) => b.x + ',' + b.z)).size, 4);
  h.advance(3.2);
  assert.equal(h.of(0, 'round').at(-1).phase, 'running'); assert.ok(h.room.tick >= 3.2 * 120 - 2);
}
{ // clock: 120 ticks per second regardless of update granularity; long stalls are skipped, not replayed
  const h = harness(); h.room.update(0); h.room.update(1000); assert.equal(h.room.tick, 120);
  const g = harness(); for (let t = 0; t <= 1000; t += 7) g.room.update(t); g.room.update(1000); assert.equal(g.room.tick, 120, 'drift-free');
  h.room.update(11000); assert.ok(h.room.tick <= 120 + 240, 'stall capped');
  const f = harness('standard', { timeScale: 10 }); f.room.update(0); f.room.update(500); assert.equal(f.room.tick, 600, 'timeScale');
}
{ // inputs: turn / jump / boost become authoritative `ev` messages; abilities ignored; bad bikes ignored
  const h = harness(); h.run();
  h.room.input(0, { kind: 'turn', side: 1 }); h.advance(0.05);
  const ev = h.of(1, 'ev').find((e) => e.id === 0 && e.kind === 'turn');
  assert.ok(ev); assert.equal(ev.side, 1); assert.deepEqual([ev.dx, ev.dz], [1, 0]); assert.equal(ev.tick > 0, true);
  assert.deepEqual([h.bike(0).dx, h.bike(0).dz], [1, 0]);
  h.room.input(0, { kind: 'turn', side: -1 }); h.advance(0.0001); // inside the min turn gap -> buffered, not lost
  const turns = () => h.of(0, 'ev').filter((e) => e.id === 0 && e.kind === 'turn').length;
  assert.equal(turns(), 1);
  h.advance(0.15);
  assert.equal(turns(), 2, 'buffered turn applied once the min gap is open');
  h.room.input(1, { kind: 'jump' }); h.room.input(1, { kind: 'jump' }); h.advance(0.02);
  assert.equal(h.of(0, 'ev').filter((e) => e.id === 1 && e.kind === 'jump').length, 1, 'second jump refused (meter empty)');
  assert.ok(h.bike(1).jumpT >= 0);
  h.room.input(2, { kind: 'boost' }); h.advance(0.02);
  assert.equal(h.of(0, 'ev').filter((e) => e.id === 2 && e.kind === 'boost').length, 1); assert.ok(h.bike(2).boosting);
  const before = h.of(0, 'ev').length;
  h.room.input(3, { kind: 'ability' }); h.room.input(3, { kind: 'swap' }); h.room.input(9, { kind: 'jump' }); h.advance(0.05);
  assert.equal(h.of(0, 'ev').length, before, 'abilities disabled online, unknown bike ignored');
}
{ // snapshots at 10 Hz while running
  const h = harness(); h.run(); const n0 = h.of(0, 'snap').length; h.advance(1);
  const n = h.of(0, 'snap').length - n0; assert.ok(n >= 9 && n <= 11, 'snaps/s = ' + n);
  const s = h.of(0, 'snap').at(-1); assert.equal(s.bikes.length, 4); assert.ok('boostMeter' in s.bikes[0] && 'alive' in s.bikes[0]);
}
{ // crash -> resolveTick scoring (3 crashes + last alive = 4 points), then the next round, then match end at 5+
  const h = harness(); h.run(); h.drop(1, 2, 3); h.advance(1.2);
  const crashes = h.of(0, 'crash'); assert.equal(crashes.length, 3);
  assert.ok(crashes.every((c) => c.cause === 'void' && c.killer === null));
  const re = h.of(0, 'round').at(-1);
  assert.equal(re.phase, 'roundEnd'); assert.equal(re.scores[0], 4); assert.equal(re.lastResult.reason, 'last');
  h.advance(3.2); // roundEndDelay
  const r2 = h.of(0, 'round').at(-1); assert.equal(r2.phase, 'countdown'); assert.equal(r2.round, 2); assert.equal(r2.scores[0], 4);
  assert.ok(h.bike(1).alive, 'fresh round');
  h.advance(3.2); h.drop(1, 2, 3); h.advance(1.2);
  assert.equal(h.ended, null, 'round end pause first'); h.advance(3.2);
  assert.equal(h.ended.reason, 'normal');
  const by = Object.fromEntries(h.ended.results.map((r) => [r.id, r]));
  assert.equal(by[0].place, 1); assert.equal(by[0].won, true);
  assert.deepEqual([by[1].place, by[2].place, by[3].place], [2, 2, 2]); assert.ok(!by[1].won && !by[1].left);
  const n = h.msgs[0].length; h.advance(1); assert.equal(h.msgs[0].length, n, 'room is silent after the end');
}
{ // round modes never use "player out" (no human is special): bike 0 crashing alone does not end the round
  const h = harness(); h.run(); h.drop(0); h.advance(1.2);
  assert.equal(h.room.match.phase, 'running'); assert.equal(h.room.match.lastResult.reason, 'crash'); assert.equal(h.room.match.scores[0], 0);
  assert.equal(Object.values(h.room.match.scores).reduce((a, b) => a + b, 0), 1, 'one random survivor got the point');
}
{ // leaving: bike crashes immediately (cause leave), loss callback, forfeit end when < 2 remain
  const h = harness(); h.run();
  h.room.leave(2); h.advance(0.05);
  assert.deepEqual(h.left, [2]);
  const c = h.of(0, 'crash').find((e) => e.victim === 2); assert.ok(c); assert.equal(c.cause, 'leave');
  assert.ok(!h.bike(2).alive); const n2 = h.msgs[2].length; h.advance(0.5); assert.equal(h.msgs[2].length, n2, 'leaver gets nothing more');
  h.room.leave(2); assert.deepEqual(h.left, [2], 'double leave ignored');
  h.room.input(2, { kind: 'jump' });
  h.room.leave(3); assert.equal(h.ended, null, 'two humans still playing');
  h.room.leave(1);
  assert.equal(h.ended.reason, 'forfeit');
  const by = Object.fromEntries(h.ended.results.map((r) => [r.id, r]));
  assert.equal(by[0].won, true); assert.equal(by[0].place, 1); assert.ok(by[1].left && by[2].left && !by[1].won);
  assert.ok([by[1], by[2], by[3]].every((r) => r.place > 1));
}
{ // leaving during the countdown: the bike is crashed when the round starts running; a leaver never counts as a winner even in the lead
  const h = harness(); h.advance(0.5); h.room.leave(1); h.advance(3.5);
  assert.ok(h.of(0, 'crash').some((e) => e.victim === 1 && e.cause === 'leave'));
  h.drop(2, 3); h.advance(1.2);
  assert.ok(h.room.match.scores[0] > 0);
}
{ // Death Match: crash takes a life (reported), respawn ev later, leaving costs all lives
  const h = harness('deathmatch'); h.run();
  assert.equal(h.of(0, 'round').at(-1).lives[0], 3);
  h.drop(1); h.advance(1.1);
  const c = h.of(0, 'crash').find((e) => e.victim === 1); assert.equal(c.lives, 2); assert.equal(h.room.match.lives[1], 2);
  h.advance(2.5);
  assert.ok(h.of(0, 'ev').some((e) => e.id === 1 && e.kind === 'respawn'), 'respawn event'); assert.ok(h.bike(1).alive);
  assert.equal(h.of(0, 'snap').at(-1).bikes[1].lives, 2);
  h.room.leave(1); h.advance(0.1);
  assert.equal(h.room.match.lives[1], 0); assert.ok(!h.bike(1).alive);
  h.advance(3); assert.ok(!h.bike(1).alive, 'never respawns');
  h.room.leave(2); h.room.leave(3); assert.equal(h.ended.reason, 'forfeit');
}
{ // Death Match ends normally when one bike has lives left
  const h = harness('deathmatch'); h.run();
  for (let life = 0; life < 3; life++) { h.drop(1, 2, 3); h.advance(1.2); if (life < 2) h.advance(2.2); }
  assert.equal(h.ended?.reason, 'normal'); assert.equal(h.ended.results[0].place, 1);
}
{ // hyper / 3d use their own speed and map
  const hy = harness('hyper'); assert.equal(hy.bike(0).baseSpeed, 25);
  const t3 = harness('3d'); assert.equal(t3.msgs[0][0].mapId, 'tiers');
}
{ // rewind cap follows the server-measured rtt: a claimed 150 ms old input from a 0-ping player is cut to ~rtt/2 + 30 ms; unknown rtt keeps the full cap
  const rew = (rtt) => {
    const h = harness(); h.room.players[0].session = { rtt }; h.run(); h.advance(0.5);
    h.room.input(0, { kind: 'turn', side: 1, ctick: h.room.tick - 18 }); h.advance(0.05);
    return h.room.stats.rewindTicks / Math.max(1, h.room.stats.rewound);
  };
  const lo = rew(0), hi = rew(300), unk = rew(null);
  assert.ok(lo > 0 && lo <= 6, `rtt 0 -> rewind <= ~30 ms (got ${lo} ticks)`);
  assert.ok(hi >= 17 && unk >= 17, `${hi} ${unk}: ` + 'high ping / unknown rtt keep the full 150 ms cap');
}
{ // rank-farming guard: a win only ranks when >= 2 humans were still in at the end of round 1
  const early = harness(); early.run(); early.room.leave(0); early.room.leave(1); early.room.leave(2); // bots-less room: last human wins by forfeit before round 1 ended
  assert.equal(early.ended.reason, 'forfeit'); const w = early.ended.results[3]; assert.ok(w.won && w.unranked, 'lone survivor of early leavers: win but unranked');
  const full = harness(); full.run(); full.advance(60);
  if (full.ended) { const winner = full.ended.results.find((r) => r.won); assert.ok(!winner || !winner.unranked, '4 humans stayed through round 1: the win ranks'); }
}
console.log('room tests ok');
