import assert from 'node:assert/strict';
import { CFG } from '../js/config.js';
import { createState, createBike, spawnPoints } from '../js/state.js';
import { step, turnBike, canTurn } from '../js/physics.js';
import { createMatch, MODES } from '../js/modes.js';
import { createAI, updateAIs, makeRng } from '../js/ai.js';

const DT = 1 / CFG.tickHz;
const setup = (rng = makeRng(3)) => {
  const s = createState();
  for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  return [s, createMatch(s, MODES.standard, rng)];
};
const kill = (s, ...ids) => ids.forEach((id) => { s.bikes[id].alive = false; s.bikes[id].trail.length = 0; });
const ev = (...ids) => ids.map((victim) => ({ victim, killer: null }));

{ // spawns: 4 distinct points, facing center, evenly spaced
  const p = spawnPoints(4);
  assert.equal(new Set(p.map((q) => q.x + ',' + q.z)).size, 4);
  for (const q of p) { assert.ok(q.x * q.dx + q.z * q.dz < 0); assert.equal(Math.hypot(q.x, q.z), CFG.arena.half * CFG.spawnRadius); }
}
{ // minimum turn gap: a second turn is only allowed after >= minTurnGap units (~8 ticks at 15 u/s)
  const b = createBike(0, 0, 0, 0, 1, 0), s = createState(); s.bikes.push(b);
  for (let i = 0; i < 10; i++) step(s, DT);
  assert.ok(canTurn(b)); turnBike(b, 1);
  assert.ok(!canTurn(b));
  let ticks = 0; while (!canTurn(b)) { step(s, DT); ticks++; }
  assert.ok(ticks * DT * 15 >= CFG.minTurnGap - 1e-6 && ticks < 12);
}
{ // countdown holds, then running; timer counts down
  const [s, m] = setup(); m.startMatch();
  assert.equal(m.phase, 'countdown');
  for (let i = 0; i < 2.5 * 120; i++) m.advance(DT);
  assert.equal(m.phase, 'countdown'); assert.ok(m.cd > 0 && m.cd < 1);
  for (let i = 0; i < 0.6 * 120; i++) m.advance(DT);
  assert.equal(m.phase, 'running');
  m.onTick([], 1); assert.ok(Math.abs(m.timeLeft - 99) < 1e-9);
}
{ // crash -> point to a survivor; last alive -> round ends; next round resets trails and positions
  const [s, m] = setup(); m.startMatch(); m.phase = 'running';
  kill(s, 1); m.onTick(ev(1), DT);
  assert.equal(Object.values(m.scores).reduce((a, b) => a + b, 0), 1); assert.equal(m.phase, 'running');
  kill(s, 2, 3); m.onTick(ev(2, 3), DT);
  assert.equal(m.phase, 'roundEnd'); assert.equal(m.lastResult.reason, 'last');
  s.bikes[0].trail.push({ x1: 0, z1: 0, x2: 5, z2: 0, h: 2, owner: 0 });
  for (let i = 0; i < 3.1 * 120; i++) m.advance(DT);
  assert.equal(m.phase, 'countdown'); assert.equal(m.round, 2);
  assert.ok(s.bikes.every((b) => b.alive && b.trail.length === 1));
}
{ // head-on of the last two: nobody scores that round
  const [s, m] = setup(); m.startMatch(); m.phase = 'running';
  kill(s, 1, 2); m.onTick(ev(1, 2), DT); // 2 survivors remain: crash points are awarded
  const before = { ...m.scores };
  kill(s, 0, 3); m.onTick(ev(0, 3), DT);
  assert.deepEqual(m.scores, before); assert.equal(m.phase, 'roundEnd'); assert.equal(m.lastResult.reason, 'draw');
}
{ // timeout: all alive get 1
  const [s, m] = setup(); m.startMatch(); m.phase = 'running';
  kill(s, 1);
  m.timeLeft = DT * 0.5; m.onTick([], DT);
  assert.deepEqual(m.scores, { 0: 1, 1: 0, 2: 1, 3: 1 }); assert.equal(m.phase, 'roundEnd');
}
{ // reaching 5 points ends the match with placements; startMatch restarts from zero
  const [s, m] = setup(); m.startMatch(); m.scores[2] = 4; m.phase = 'running';
  kill(s, 0, 1, 3); m.onTick(ev(0, 1, 3), DT);
  for (let i = 0; i < 3.1 * 120; i++) m.advance(DT);
  assert.equal(m.phase, 'matchEnd'); assert.equal(m.winner, 2); assert.equal(m.placements[0], 2);
  m.startMatch(); assert.equal(m.phase, 'countdown'); assert.deepEqual(m.scores, { 0: 0, 1: 0, 2: 0, 3: 0 });
}
{ // full headless match of 4 AIs ends with a winner at >= 5 points
  const rng = makeRng(11);
  const [s, m] = setup(rng);
  const ais = new Map(s.bikes.map((b, i) => [b.id, createAI(1, i * 2)]));
  m.startMatch();
  let ticks = 0;
  while (m.phase !== 'matchEnd' && ticks < 120 * 60 * 60) {
    ticks++;
    if (m.phase !== 'running') { m.advance(DT); continue; }
    updateAIs(s, ais, s.tick++, rng);
    m.onTick(step(s, DT), DT);
  }
  assert.equal(m.phase, 'matchEnd');
  assert.ok(m.scores[m.winner] >= 5);
  console.log(`  headless match: ${m.round} rounds, scores ${JSON.stringify(m.scores)}`);
}
{ // the player crashing ends a round-based round at once: a random alive BOT gets the point, short delay, then next round
  for (const mode of [MODES.standard, MODES.hyper, MODES['3d']]) {
    const s = createState(); for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
    const m = createMatch(s, mode, makeRng(5)); m.startMatch(); m.phase = 'running';
    kill(s, 0); m.onTick(ev(0), DT);
    assert.equal(m.phase, 'roundEnd', mode.id); assert.equal(m.lastResult.reason, 'out');
    assert.equal(m.lastResult.awards.length, 1); assert.ok([1, 2, 3].includes(m.lastResult.awards[0])); assert.equal(m.scores[0], 0);
    assert.equal(Object.values(m.scores).reduce((a, b) => a + b, 0), 1);
    assert.equal(m.delay, CFG.match.playerOutDelay); assert.ok(m.delay < 2);
    for (let i = 0; i < 1.4 * 120; i++) m.advance(DT);
    assert.equal(m.phase, 'roundEnd');
    for (let i = 0; i < 0.2 * 120; i++) m.advance(DT);
    assert.equal(m.phase, 'countdown'); assert.equal(m.round, 2);
  }
  // the awarded bot is one still alive after the tick (not one that crashed the same tick); all bots down too => nobody
  let [s, m] = setup(makeRng(8)); m.startMatch(); m.phase = 'running';
  kill(s, 0, 1); m.onTick(ev(0, 1), DT);
  assert.ok([2, 3].includes(m.lastResult.awards[0]) && m.lastResult.awards.length === 1);
  [s, m] = setup(); m.startMatch(); m.phase = 'running'; kill(s, 1, 2); m.onTick(ev(1, 2), DT); const sc = { ...m.scores };
  kill(s, 0, 3); m.onTick(ev(0, 3), DT); assert.deepEqual(m.scores, sc); assert.equal(m.lastResult.reason, 'draw');
  // distribution: over many rounds all bots get picked
  const hit = { 1: 0, 2: 0, 3: 0 };
  for (let k = 0; k < 90; k++) { [s, m] = setup(makeRng(k + 1)); m.startMatch(); m.phase = 'running'; kill(s, 0); m.onTick(ev(0), DT); hit[m.lastResult.awards[0]]++; }
  assert.ok(hit[1] > 10 && hit[2] > 10 && hit[3] > 10, JSON.stringify(hit));
  // bot-vs-bot crash while the player lives: old rules (round continues, random survivor point)
  [s, m] = setup(); m.startMatch(); m.phase = 'running'; kill(s, 1); m.onTick(ev(1), DT);
  assert.equal(m.phase, 'running'); assert.equal(Object.values(m.scores).reduce((a, b) => a + b, 0), 1);
  // reaching 5 via a player-out point ends the match after the short delay
  [s, m] = setup(); m.startMatch(); m.scores[1] = 4; m.scores[2] = 0; m.scores[3] = 0; m.phase = 'running'; kill(s, 0, 2, 3); m.onTick(ev(0, 2, 3), DT);
  for (let i = 0; i < 1.6 * 120; i++) m.advance(DT);
  assert.equal(m.phase, 'matchEnd'); assert.equal(m.winner, 1);
}
console.log('match tests passed');
