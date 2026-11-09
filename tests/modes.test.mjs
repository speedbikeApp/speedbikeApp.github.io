// Phase 7: Hyper, Death Match, platforms/height physics, 3D (TIERS) map, AI on those.
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { CFG } = await import('../js/config.js');
const { createBike, createState, resetBike, spawnPoints } = await import('../js/state.js');
const { step, startJump, isAirborne, turnBike } = await import('../js/physics.js');
const { MAPS, groundAt } = await import('../js/maps.js');
const { createMatch, MODES, pickRespawn } = await import('../js/modes.js');
const { createAI, updateAIs, makeRng, probe } = await import('../js/ai.js');
const S = await import('../js/save.js');

const DT = 1 / CFG.tickHz;
const mk = (map, ...bikes) => { const s = createState(); s.map = map; s.bikes.push(...bikes); return s; };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const at = (id, x, z, dx, dz, y = 0) => { const b = createBike(id, 0, x, z, dx, dz); resetBike(b, { x, z, dx, dz, y }, CFG.baseSpeed); return b; };
const run = (s, secs, until) => { let ev = []; for (let i = 0, n = Math.round(secs * CFG.tickHz); i < n; i++) { ev = ev.concat(step(s, DT)); if (until && until()) break; } return ev; };
const T = MAPS.tiers;

// ---------------------------------------------------------------- online: the last human out ends the round (like single player)
{
  const mkM = (humans) => { const s = createState(); s.playerId = -1; for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
    const m = createMatch(s, MODES.standard, makeRng(3), { humans: () => humans }); m.startMatch(); m.phase = 'running'; return [s, m]; };
  let [s, m] = mkM([0, 1]);
  s.bikes[0].alive = false; m.onTick([{ victim: 0, killer: null }], DT);
  assert.equal(m.phase, 'running', 'another human is still in: play on');
  s.bikes[1].alive = false; m.onTick([{ victim: 1, killer: null }], DT);
  assert.equal(m.phase, 'roundEnd', 'last human out: round ends at once');
  assert.equal(m.lastResult.awards.length, 1); assert.ok([2, 3].includes(m.lastResult.awards[0]), 'a random alive bot scores');
  [s, m] = mkM([0]);
  s.bikes[2].alive = false; m.onTick([{ victim: 2, killer: null }], DT);
  assert.equal(m.phase, 'running', 'a bot crashing does not end it');
}

// ---------------------------------------------------------------- random spawns per round
{
  const s = createState(); for (let i = 0; i < 2; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  const m = createMatch(s, MODES.hyper, makeRng(7)); m.startMatch(); // arena: symmetric spawns
  const seen = new Set();
  for (let r = 0; r < 20; r++) {
    m.startRound(); const [a, b] = s.bikes;
    near(a.x, -b.x); near(a.z, -b.z); // 2 players: still opposite each other
    seen.add(`${a.x},${a.z}`);
  }
  assert.ok(seen.size >= 3, 'spawns change between rounds');
  assert.deepEqual(spawnPoints(2), spawnPoints(2), 'no rng: fixed layout');
}

// ---------------------------------------------------------------- multimap: a different map every round
{
  const s = createState(); for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  const m = createMatch(s, MODES.multimap, makeRng(5)); m.startMatch();
  const used = new Set([s.map.id]);
  for (let r = 0; r < 12; r++) { const prev = s.map.id; m.startRound(); assert.notEqual(s.map.id, prev, 'never the same map twice in a row'); used.add(s.map.id);
    assert.ok(s.bikes.every((b) => b.alive && b.trail.length === 1)); }
  assert.ok(used.size >= 3, 'cycles through the maps');
  assert.equal(MODES.multimap.speed, CFG.baseSpeed);
}

// ---------------------------------------------------------------- Hyper
{
  assert.equal(MODES.hyper.speed, 25); assert.equal(MODES.hyper.speed, CFG.hyper.speed);
  assert.equal(MODES.standard.speed, 15); assert.equal(MODES.hyper.roundTime, 100); assert.equal(MODES.hyper.winPoints, 5);
  const s = createState(); for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  const m = createMatch(s, MODES.standard, makeRng(1)); m.setMode(MODES.hyper); m.startMatch();
  assert.ok(s.bikes.every((b) => b.speed === 25 && b.baseSpeed === 25));
  const b = s.bikes[0], x0 = b.x, z0 = b.z; m.phase = 'running'; run(s, 1); near(Math.hypot(b.x - x0, b.z - z0), 25, 0.2);
}

// ---------------------------------------------------------------- platforms / height
{ // default map = one 102x102 platform, NO walls (follows CFG.arena.half)
  const A = MAPS.arena;
  assert.equal(A.platforms.length, 1); assert.deepEqual(A.platforms[0], { x0: -51, z0: -51, x1: 51, z1: 51, y: 0 }); assert.ok(!A.walls); assert.ok(!T.walls);
  assert.equal(groundAt(A, 0, 0), 0); assert.equal(groundAt(A, 60, 0), -Infinity);
  assert.equal(createState().map, A);
}
{ // jump geometry assumptions behind the TIERS layout: peak 3.5 > pad height 2; one-tile (3 unit) gap; every size is a whole number of tiles
  const J = CFG.jump; near((J.rise + J.float + J.fall) * CFG.baseSpeed, 12.75);
  assert.ok(J.height > T.platforms[1].y && T.platforms[1].x0 - T.platforms[0].x1 === CFG.tile && T.platforms[1].y === 2);
  for (const mp of [MAPS.arena, T]) for (const p of mp.platforms) {
    for (const v of [p.x1 - p.x0, p.z1 - p.z0]) near(v / CFG.tile, Math.round(v / CFG.tile), 1e-9);
  }
}
{ // driving off an edge onto a LOWER glued platform: falls 2 units, lands, survives
  const b = at(0, 0, 30, 0, 1), s = mk(T, b); // main -> south deck (z 40..70, y -2)
  let landed = false;
  run(s, 1, () => { if (b.justLanded && b.y === -2) landed = true; return b.z > 55; });
  assert.ok(b.alive && landed, 'survived the drop'); assert.equal(b.y, -2); assert.ok(!b.falling && !isAirborne(b));
  assert.equal(b.trail[b.trail.length - 1].y0, -2, 'trail now rises from the deck');
}
{ // falling off the map: crash, killer null, cause 'void'
  const b = at(0, 30, 35, 1, 0), s = mk(T, b); // east of main at z=35: nothing there
  const ev = run(s, 3);
  assert.deepEqual(ev, [{ victim: 0, killer: null, cause: 'void' }]); assert.ok(!b.alive); assert.equal(b.trail.length, 0);
  assert.ok(b.y < T.killY + 1);
}
{ // driving into a gap of the map (between main and a raised pad) is also fatal, never a silent survival
  const b = at(0, 30, 0, 1, 0), s = mk(T, b);
  const ev = run(s, 3); assert.equal(ev.length, 1); assert.equal(ev[0].killer, null); assert.ok(['void', 'side'].includes(ev[0].cause));
}
{ // side of a HIGHER platform = crash (from the low deck into main's edge; and from main into a pad's side)
  const b = at(0, 0, 55, 0, -1, -2), s = mk(T, b); // on the north... south deck heading -z into main (y 0)
  const ev = run(s, 2); assert.deepEqual(ev, [{ victim: 0, killer: null, cause: 'side' }]);
  assert.ok(Math.abs(b.z - 39) < 0.2);
  // a bike dropped into the gap hits the pad side
  const c = at(1, 42, 0, 1, 0, -5); c.falling = true; c.jumpT = -1;
  const ev2 = run(mk(T, c), 1); assert.equal(ev2[0].cause, 'side');
}
{ // jump carries a bike across the 3-unit gap at base speed; lands on the raised pad (y 2), trail rises from there
  for (const d of [0.5, 2.5, 6]) { // take-off distance before the edge (see the sweep below for the full window)
    const b = at(0, 39 - d, 0, 1, 0), s = mk(T, b);
    assert.ok(startJump(b));
    const ev = run(s, 2.2);
    assert.equal(ev.length, 0, `jump from ${d} before the edge`); assert.ok(b.alive);
    assert.equal(b.y, 2); assert.ok(b.x > 45); assert.ok(!isAirborne(b));
    assert.equal(b.trail[b.trail.length - 1].y0, 2);
  }
  // human-friendly window: sweep the take-off distance in 0.25 steps; the contiguous successful range must be 0.45..0.65 s
  let okN = 0, lo = null, hi = null;
  for (let d = 0; d <= 16; d += 0.25) {
    const c = at(0, 39 - d, 0, 1, 0), cs = mk(T, c); startJump(c);
    const ev2 = run(cs, 2.2);
    if (ev2.length === 0 && c.alive && c.y === 2) { okN++; if (lo === null) lo = d; hi = d; }
  }
  const windowSec = (hi - lo + 0.25) / CFG.baseSpeed;
  assert.equal(okN * 0.25, hi - lo + 0.25, 'window is contiguous');
  assert.ok(windowSec >= 0.45 && windowSec <= 0.65, `tiers jump window ${windowSec.toFixed(2)} s`);
  console.log(`  tiers gap-jump take-off window: ${lo}..${hi} units before the edge = ${windowSec.toFixed(2)} s`);
  // ...and back from the pad to main (descending: any take-off point near the edge works)
  const b = at(0, 45, 0, -1, 0, 2), s = mk(T, b); assert.ok(startJump(b));
  const ev = run(s, 1.6); assert.equal(ev.length, 0); assert.equal(b.y, 0); assert.ok(b.x < 39 && b.x > 20);
  // too early / no jump: crash
  const e = at(1, 25, 0, 1, 0); assert.ok(startJump(e)); assert.equal(run(mk(T, e), 3).length, 1, 'jumped far too early');
}
{ // falling bikes cannot jump or turn; trails of a falling bike drop with it (segments follow y)
  const b = at(0, 39, 35, 1, 0), s = mk(T, b);
  run(s, 0.35); assert.ok(b.falling); assert.ok(!startJump(b));
  assert.ok(b.trail.length > 2 && b.trail[b.trail.length - 1].y0 < 0);
}
{ // arena has NO walls: driving off the edge makes the bike fall (keeps moving forward, y drops) and crash below killY
  const b = at(0, 0, 0, 1, 0), s = mk(MAPS.arena, b);
  let fell = 0, maxX = 0, ev = [];
  for (let i = 0; i < 5 * CFG.tickHz && !ev.length; i++) { ev = step(s, DT); if (b.falling) { fell++; maxX = b.x; } }
  assert.deepEqual(ev, [{ victim: 0, killer: null, cause: 'void' }]);
  assert.ok(fell > 0.5 * CFG.tickHz, 'visibly falls for a while before the crash'); assert.ok(maxX > CFG.arena.half + 5, 'keeps moving forward while falling');
  assert.ok(b.y < MAPS.arena.killY + 1);
  // all four edges, and a corner, are equally deadly
  for (const [x, z, dx, dz] of [[0, 0, -1, 0], [0, 0, 0, 1], [0, 0, 0, -1], [45, 45, 1, 0]]) {
    const c = at(1, x, z, dx, dz); const e = run(mk(MAPS.arena, c), 6); assert.equal(e.length, 1); assert.equal(e[0].cause, 'void'); assert.equal(e[0].killer, null);
  }
}
{ // nothing snaps positions to the grid: spawn, free coordinates and turns keep their exact fractional values
  assert.equal(CFG.tile, 3);
  const b = at(0, 1.234, -7.891, 1, 0), s = mk(MAPS.arena, b);
  run(s, 0.5); assert.ok(Math.abs(b.z - (-7.891)) < 1e-12, 'z untouched'); assert.ok(b.x % CFG.tile !== 0);
  near(b.x, 1.234 + 7.5, 1e-6);
  turnBike(b, 1); run(s, 0.3); near(b.x, 1.234 + 7.5, 1e-6); near(b.z, -7.891 + 4.5, 1e-6);
  const lane = at(1, 3, 6, 0, 1), s2 = mk(MAPS.arena, lane); run(s2, 0.1); near(lane.x, 3, 1e-12); // riding exactly on a grid line is fine too
  const off = at(2, 4.5, 6, 0, 1), s3 = mk(MAPS.arena, off); run(s3, 0.1); near(off.x, 4.5, 1e-12); // ...and so is the middle of a tile
}

// ---------------------------------------------------------------- Death Match
const dmSetup = (rng = makeRng(5), hooks = {}) => {
  const s = createState(); for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  const m = createMatch(s, MODES.deathmatch, rng, hooks); m.startMatch(); m.phase = 'running';
  return [s, m];
};
const crash = (s, id) => { const b = s.bikes[id]; b.alive = false; b.trail.length = 0; };
{ // lives, count-up timer, respawn after 1.5 s with full meters and spawn protection
  assert.equal(CFG.deathMatch.lives, 3); assert.equal(CFG.deathMatch.respawnDelay, 1.5);
  const respawned = []; const [s, m] = dmSetup(makeRng(5), { onRespawn: (b) => respawned.push(b.id) });
  assert.deepEqual(m.lives, { 0: 3, 1: 3, 2: 3, 3: 3 });
  m.onTick([], 0.5); near(m.clock(), 0.5); m.onTick([], 0.25); near(m.clock(), 0.75); assert.ok(m.mode.countUp);
  const b = s.bikes[1]; b.boostMeter = 0.2; b.jumpMeter = 0;
  crash(s, 1); m.onTick([{ victim: 1, killer: 2 }], DT);
  assert.equal(m.lives[1], 2); assert.equal(m.kills[2], 1); assert.equal(m.phase, 'running'); near(m.respawnIn[1], 1.5, 1.5 * DT);
  let t = 0; while (!b.alive && t < 3) { m.onTick([], DT); t += DT; }
  assert.ok(b.alive); assert.ok(Math.abs(t - 1.5) <= 2 * DT, `respawned after ${t.toFixed(3)} s`);
  assert.deepEqual(respawned, [1]);
  assert.equal(b.boostMeter, 1); assert.equal(b.jumpMeter, 1); assert.equal(b.trail.length, 1); assert.equal(b.speed, 15);
  near(b.spawnProt, CFG.deathMatch.spawnProtect); assert.ok(m.clock() > 2.2);
  assert.equal(m.rankingsCheck, undefined);
}
{ // spawn protection: trails cannot kill a fresh respawn for spawnProtect seconds (falling still does)
  const wall = at(1, 10, 20, 0, 1); wall.speed = 0; wall.baseSpeed = 0; Object.assign(wall.trail[0], { x1: 10, x2: 10, z1: -20, z2: 20 });
  const b = at(0, 0, 0, 1, 0), s = mk(MAPS.arena, b, wall); b.spawnProt = 1;
  assert.equal(run(s, 0.8).length, 0, 'drove through the trail'); assert.ok(b.alive && b.x > 10);
  const c = at(2, 0, 0, 1, 0), s2 = mk(MAPS.arena, c, wall); c.spawnProt = 0;
  assert.equal(run(s2, 1).length, 1);
  const d = at(3, 0, 0, 1, 0); d.spawnProt = 100; assert.equal(run(mk(MAPS.arena, d), 5)[0].killer, null, 'falling still kills');
}
{ // respawn spot: max over candidates of the min distance to other bikes and trails
  const rng = makeRng(9);
  const s = createState(); s.bikes.push(at(0, 0, 0, 1, 0));
  const others = [at(1, -35, -35, 1, 0), at(2, 35, -35, 0, 1), at(3, -35, 35, 1, 0)];
  s.bikes.push(...others);
  others[0].trail[0].x2 = -10; others[1].trail[0].z2 = 0; others[2].trail[0].x2 = -10; // some trail so segments matter
  s.bikes[0].alive = false; s.bikes[0].trail.length = 0;
  const p = pickRespawn(s, s.bikes[0], rng);
  assert.ok(p.x > 15 && p.z > 15, `expected the open SE quadrant, got ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
  // brute force over a grid inside the same margin
  const dist = (x, z) => { let d = 1e9; for (const o of others) { d = Math.min(d, Math.hypot(o.x - x, o.z - z)); for (const g of o.trail) { const x0 = Math.min(g.x1, g.x2), x1 = Math.max(g.x1, g.x2), z0 = Math.min(g.z1, g.z2), z1 = Math.max(g.z1, g.z2); d = Math.min(d, Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1))); } } return d; };
  let best = 0; for (let x = -42; x <= 42; x += 1) for (let z = -42; z <= 42; z += 1) best = Math.max(best, dist(x, z));
  assert.ok(Math.abs(dist(p.x, p.z) - p.d) < 1e-9); assert.ok(p.d >= best * 0.9, `chosen ${p.d.toFixed(1)} vs best ${best.toFixed(1)}`);
  assert.ok(Math.abs(p.x) <= CFG.arena.half - CFG.deathMatch.margin + 1e-9 && Math.abs(p.z) <= CFG.arena.half - CFG.deathMatch.margin + 1e-9, 'kept off the edges');
  // faces open space: the chosen heading has room, never straight at a wall
  const tmp = at(9, p.x, p.z, p.dx, p.dz); assert.ok(probe(s, tmp, p.dx, p.dz, 60).d > 15);
  assert.equal(Math.abs(p.dx) + Math.abs(p.dz), 1);
  // on the TIERS map the spot is always on a platform
  const s3 = createState(); s3.map = T; s3.bikes.push(at(0, 0, 0, 1, 0), at(1, 0, 20, 0, 1)); s3.bikes[0].alive = false;
  for (let i = 0; i < 20; i++) { const q = pickRespawn(s3, s3.bikes[0], makeRng(i)); assert.equal(groundAt(T, q.x, q.z), q.y); }
}
{ // out of lives -> stays dead, no respawn; last bike with lives wins; ranks by elimination order; coins + kill bonus
  const [s, m] = dmSetup(makeRng(3));
  const out = (id, killer) => { for (let k = 0; k < 3; k++) { crash(s, id); m.onTick([{ victim: id, killer }], DT); if (k < 2) { for (let i = 0; i < 1.6 * CFG.tickHz; i++) m.onTick([], DT); assert.ok(s.bikes[id].alive); } } };
  out(1, 0); assert.equal(m.lives[1], 0); assert.ok(!s.bikes[1].alive); assert.equal(m.respawnIn[1], undefined);
  for (let i = 0; i < 3 * CFG.tickHz; i++) m.onTick([], DT); assert.ok(!s.bikes[1].alive, 'no lives: stays out'); assert.equal(m.phase, 'running');
  out(2, 0); out(3, 2);                       // 3 hits 2's... (2 already out) - credited anyway as data
  assert.equal(m.phase, 'matchEnd'); assert.equal(m.winner, 0);
  assert.deepEqual(m.placements, [0, 3, 2, 1]); assert.deepEqual(m.ranks, { 0: 1, 3: 2, 2: 3, 1: 4 });
  assert.equal(m.kills[0], 6, 'kills credited to the trail owner'); // 3 + 3
  // rewards: placement coins + per kill
  S.resetSave(); const before = S.getSave().coins;
  const bonus = m.bonusCoins(0); assert.equal(bonus, 6 * CFG.deathMatch.coinsPerKill);
  const r = S.recordMatch(m.ranks[0], bonus);
  assert.equal(r.earned, CFG.rewards.coins[0] + 6 * CFG.deathMatch.coinsPerKill); assert.equal(S.getSave().coins, before + r.earned); assert.ok(r.won);
  const r2 = S.recordMatch(m.ranks[3], m.bonusCoins(3)); assert.equal(r2.earned, CFG.rewards.coins[1] + 0);
}
{ // the winner may be waiting for a respawn when the others run out; self-hits / walls / falls give no kill credit
  const [s, m] = dmSetup(makeRng(4));
  m.lives = { 0: 3, 1: 1, 2: 1, 3: 1 };
  crash(s, 0); m.onTick([{ victim: 0, killer: 0 }], DT); assert.equal(m.kills[0], 0, 'own trail: no kill'); assert.equal(m.lives[0], 2);
  crash(s, 1); m.onTick([{ victim: 1, killer: null, cause: 'void' }], DT); assert.deepEqual(Object.values(m.kills), [0, 0, 0, 0]);
  crash(s, 2); crash(s, 3); m.onTick([{ victim: 2, killer: 3 }, { victim: 3, killer: 2 }], DT); // head-on of the other two
  assert.equal(m.phase, 'matchEnd'); assert.equal(m.winner, 0); assert.equal(m.ranks[0], 1);
  assert.equal(m.ranks[2], m.ranks[3], 'same tick = shared rank'); assert.equal(m.ranks[1], 4);
}
{ // everyone left wiped in the same tick: they tie for 1st, most kills named winner
  const [s, m] = dmSetup(makeRng(4));
  m.lives = { 0: 1, 1: 1, 2: 0, 3: 0 }; m.outAt = { 2: -2, 3: -1 }; m.kills = m.scores; m.kills[1] = 2;
  crash(s, 0); crash(s, 1); m.onTick([{ victim: 0, killer: 1 }, { victim: 1, killer: 0 }], DT);
  assert.equal(m.phase, 'matchEnd'); assert.equal(m.ranks[0], 1); assert.equal(m.ranks[1], 1); assert.equal(m.winner, 1);
}
{ // full headless Death Match with 4 AIs (physics + respawns): finishes with a winner who still has lives
  const rng = makeRng(21), s = createState(); for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  const m = createMatch(s, MODES.deathmatch, rng); m.startMatch();
  const ais = new Map(s.bikes.map((b, i) => [b.id, createAI(1, i * 2)]));
  let ticks = 0, respawns = 0;
  while (m.phase !== 'matchEnd' && ticks < 120 * 60 * 15) {
    ticks++;
    if (m.phase !== 'running') { m.advance(DT); continue; }
    const dead = s.bikes.filter((b) => !b.alive).length;
    updateAIs(s, ais, s.tick++, rng);
    m.onTick(step(s, DT), DT);
    respawns += Math.max(0, dead - s.bikes.filter((b) => !b.alive).length);
  }
  assert.equal(m.phase, 'matchEnd'); assert.ok(m.lives[m.winner] > 0); assert.equal(m.ranks[m.winner], 1);
  assert.ok(respawns > 0, "bikes respawned");
  console.log(`  headless Death Match: ${m.elapsed.toFixed(0)} s, ${respawns} respawns, lives ${JSON.stringify(m.lives)}, kills ${JSON.stringify(m.kills)}`);
}

// ---------------------------------------------------------------- AI: Hyper and TIERS survival
function loneRun(mapId, speed, level, secs, seed) {
  const s = createState(); s.map = MAPS[mapId]; s.bikes.push(createBike(0, 0, 0, 0, 0, -1));
  resetBike(s.bikes[0], spawnPoints(1, s.map)[0], speed);
  const rng = makeRng(seed * 7 + level), ais = new Map([[0, createAI(level, 0)]]);
  for (let i = 0; i < secs * CFG.tickHz; i++) { updateAIs(s, ais, s.tick++, rng); const ev = step(s, DT); if (ev.length) return ev[0].cause || (ev[0].killer === null ? 'wall' : 'trail'); }
  return null;
}
function packRun(mapId, speed, level, secs, seed) {
  const s = createState(); s.map = MAPS[mapId]; for (let i = 0; i < 4; i++) s.bikes.push(createBike(i, 0, 0, 0, 0, -1));
  const pts = spawnPoints(4, s.map); s.bikes.forEach((b, i) => resetBike(b, pts[i], speed));
  const rng = makeRng(seed), ais = new Map(s.bikes.map((b, i) => [b.id, createAI(level, i * 2)])), causes = [];
  for (let i = 0; i < secs * CFG.tickHz; i++) { updateAIs(s, ais, s.tick++, rng); for (const e of step(s, DT)) causes.push(e.cause || (e.killer === null ? 'wall' : 'trail')); }
  return { alive: s.bikes.filter((b) => b.alive).length, causes };
}
const SEEDS = 10;
{ // Hyper (25 u/s): look-ahead scales with speed. 18 s at 25 u/s covers the distance of 30 s at 15 u/s.
  const lines = [];
  for (const level of [0, 1, 2]) {
    let std = 0, hyp = 0, alive = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      if (!loneRun('arena', 15, level, 30, seed)) std++;
      if (!loneRun('arena', 25, level, 18, seed)) hyp++;
      alive += packRun('arena', 25, level, 20, seed).alive;
    }
    lines.push(`level ${level}: lone survive std15/30s ${std}/${SEEDS}, hyper25/18s ${hyp}/${SEEDS}; 4-bike hyper alive@20s ${alive}/${4 * SEEDS}`);
    assert.ok(hyp >= std - 2, `Hyper AI level ${level} much worse than Standard (${hyp} vs ${std})`);
    if (level >= 1) assert.ok(hyp >= 8, `Hyper AI level ${level} survived only ${hyp}/${SEEDS}`);
  }
  console.log('  AI at Hyper speed:\n    ' + lines.join('\n    '));
}
{ // scaling sanity: AI turns for a wall earlier (in units) at Hyper than at base speed
  const turnDist = (speed) => {
    const b = at(0, 0, 0, 1, 0), s = mk(MAPS.arena, b); b.speed = b.baseSpeed = speed;
    const ai = createAI(2, 0), rng = makeRng(1);
    for (let i = 0; i < 20 * CFG.tickHz; i++) { const before = b.dx; updateAIs(s, new Map([[0, ai]]), s.tick++, rng); if (b.dx !== before || b.dz !== 0) return CFG.arena.half - b.x; step(s, DT); }
    return null;
  };
  const d15 = turnDist(15), d25 = turnDist(25);
  assert.ok(d25 > d15 * 1.4, `turn distance from the wall: ${d15} at 15 u/s vs ${d25} at 25 u/s`);
}
{ // 3D (TIERS): AIs treat open edges as walls, jump gaps sometimes, survive
  const lines = []; let falls = 0, bikeRuns = 0, jumps = 0;
  for (const level of [1, 2]) {
    let lone = 0, alive = 0; const causes = {};
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = loneRun('tiers', 15, level, 30, seed); if (!r) lone++; else causes[r] = (causes[r] || 0) + 1;
      if (r === 'void' || r === 'side') falls++;
      const p = packRun('tiers', 15, level, 30, seed); alive += p.alive; bikeRuns += 4;
      for (const c of p.causes) { causes[c] = (causes[c] || 0) + 1; if (c === 'void' || c === 'side') falls++; }
    }
    lines.push(`level ${level}: lone survive 30s ${lone}/${SEEDS}; 4-bike alive@30s ${alive}/${4 * SEEDS}; deaths ${JSON.stringify(causes)}`);
    assert.ok(lone >= 8, `TIERS lone AI level ${level}: ${lone}/${SEEDS}`);
    assert.ok(alive >= 4 * SEEDS * 0.5, `TIERS 4-bike alive ${alive}`);
  }
  assert.ok(falls <= 4, `AI fell off / hit platform sides ${falls} times`);
  console.log('  AI on TIERS (3D map):\n    ' + lines.join('\n    '));
  // the gap logic really jumps: hard AI heading at the east gap (always rolls when boxed; forced here via crossing flag)
  const b = at(0, 31, 0, 1, 0), s = mk(T, b), ai = createAI(2, 0), ais = new Map([[0, ai]]), rng = makeRng(2);
  ai.crossing = true; let crossed = false;
  for (let i = 0; i < 6 * CFG.tickHz && b.alive; i++) { updateAIs(s, ais, s.tick++, rng); step(s, DT); if (b.y === 2 && b.x > 44) { crossed = true; break; } }
  assert.ok(crossed && b.alive, 'AI with crossing flag jumped the gap onto the pad');
}
console.log('modes tests passed');

// ---------------------------------------------------------------- STAIRS + BIG HOLE maps
{
  const ST = MAPS.stairs;
  // N strip (y 2.25) heading +x: driving off its end drops onto E (y 1.5) and survives
  const b = at(0, 30, -48, 1, 0, 2.25); const ev = run(mk(ST, b), 1.2);
  assert.equal(ev.length, 0); assert.ok(b.alive); assert.equal(b.y, 1.5);
  // W strip (y 0) heading -z into N's side: no jump = crash, a timed jump climbs onto N
  const c = at(0, -48, -20, 0, -1, 0); assert.equal(run(mk(ST, c), 2)[0].cause, 'side');
  let lo = null, hi = null;
  for (let d = 0; d <= 16; d += 0.25) {
    const k = at(0, -48, -36 + d, 0, -1, 0), ks = mk(ST, k); startJump(k);
    if (run(ks, 1.2).length === 0 && k.alive && k.y === 2.25) { if (lo === null) lo = d; hi = d; }
  }
  const win = (hi - lo + 0.25) / CFG.baseSpeed;
  assert.ok(win >= 0.4 && win <= 0.65, `stairs climb window ${win.toFixed(2)} s`);
  console.log(`  stairs climb-jump take-off window: ${lo}..${hi} units before the step = ${win.toFixed(2)} s`);
  // every spawn stands on its own strip; BIG HOLE: centre is void, spawns on the ring, driving inward falls
  for (const m of [ST, MAPS.crater]) for (const p of m.spawns) assert.equal(groundAt(m, p.x, p.z), p.y);
  assert.equal(groundAt(MAPS.crater, 0, 0), -Infinity);
  const h = at(0, 0, 51, 0, -1, 0); assert.equal(run(mk(MAPS.crater, h), 3)[0].cause, 'void');
  // map pools: one map per match from the mode's list
  const seen = new Set();
  for (let i = 0; i < 40; i++) { const s = createState(); s.bikes.push(createBike(0, 0, 0, 0, 0, -1)); const m = createMatch(s, MODES.standard, makeRng(i)); m.startMatch(); seen.add(s.map.id); }
  assert.deepEqual([...seen].sort(), ['arena', 'crater', 'stairs']);
}
console.log('new maps ok');
