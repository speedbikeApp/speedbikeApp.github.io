import assert from 'node:assert/strict';
import { CFG } from '../js/config.js';
import { aiThink, createAI, updateAIs, makeRng, freeDist, buildGrid, floodArea } from '../js/ai.js';
import { step, turnBike } from '../js/physics.js';
import { createBike, createState } from '../js/state.js';

const DT = 1 / CFG.tickHz;
const mk = (...bikes) => { const s = createState(); s.bikes.push(...bikes); return s; };

{ // freeDist: wall and trail
  const b = createBike(0, 0, 0, 0, 1, 0), o = createBike(1, 0, 20, 10, 0, 1);
  o.trail[0].z1 = -10; o.speed = 0;
  const s = mk(b, o);
  assert.ok(Math.abs(freeDist(s, b, 1, 0) - 20) < 1e-9);
  assert.ok(Math.abs(freeDist(s, b, -1, 0) - 50) < 1e-9);
  assert.ok(Math.abs(freeDist(s, b, 0, 1) - 50) < 1e-9);
}
{ // facing a wall: every difficulty turns (not straight), and never into the wall
  for (let level = 0; level < CFG.ai.levels.length; level++) {
    for (const [x, z, dx, dz] of [[47, 0, 1, 0], [-47, 10, -1, 0], [5, 47.5, 0, 1], [5, -47.5, 0, -1]]) {
      const b = createBike(1, 0, x, z, dx, dz), s = mk(createBike(0, 0, 0, 0, 0, 1), b); s.bikes[0].speed = 0; s.bikes[0].alive = false;
      const rng = makeRng(7); let side = 0;
      for (let k = 0; k < 40 && !side; k++) side = aiThink(s, b, createAI(level), rng); // easy may ignore a few thinks
      assert.notEqual(side, 0, `level ${level} should turn at ${x},${z}`);
      if (level > 0) assert.notEqual(aiThink(s, b, createAI(level), makeRng(1)), 0);
    }
  }
}
{ // in a corner it picks the open side: heading +x near east wall at z=-45 (north wall close on left) => turn right (toward +z)
  const b = createBike(1, 0, 47, -45, 1, 0), s = mk(b);
  assert.equal(aiThink(s, b, createAI(1), makeRng(1)), 1);
}
{ // flood fill sees a pocket: wall of trail splits the arena, AI should prefer the big side
  const wall = createBike(2, 0, 0, 0, 0, 1); wall.trail[0].z1 = -50; wall.trail[0].z2 = 50; wall.trail[0].x1 = wall.trail[0].x2 = 0; wall.speed = 0;
  const b = createBike(1, 0, 20, 0, 0, 1); // heading +z in right half
  const s = mk(b, wall);
  const g = buildGrid(s);
  assert.equal(floodArea(g, 3, 0, -1, 0), 0);                 // cell across the trail is blocked
  const a = floodArea(g, 20, 0, 1, 0);
  assert.ok(a > 100 && a <= 300, `east half only, got ${a}`);   // flood is confined to the east half (~12x25 cells)
}
{ // lone AI in an open arena survives N seconds (all difficulties, several seeds)
  const N = 25;
  for (let level = 0; level < CFG.ai.levels.length; level++) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = makeRng(seed * 101 + level);
      const b = createBike(1, 0, 0, 40, 0, -1), s = mk(b);
      const ais = new Map([[1, createAI(level, 0)]]);
      let ev = [];
      for (let i = 0; i < N * CFG.tickHz && !ev.length; i++) { updateAIs(s, ais, s.tick++, rng); ev = step(s, DT); }
      assert.equal(ev.length, 0, `level ${level} seed ${seed} crashed at t=${s.time.toFixed(1)}`);
    }
  }
}
{ // 4 AIs in a full round: AI think cost stays small (perf sanity) and round makes progress
  const rng = makeRng(42);
  const pts = [[0, 40, 0, -1], [-40, 0, 1, 0], [0, -40, 0, 1], [40, 0, -1, 0]];
  const s = mk(...pts.map((p, i) => createBike(i, 0, ...p)));
  const ais = new Map(s.bikes.map((b, i) => [b.id, createAI(2, i * 2)]));
  const t0 = performance.now();
  let crashed = 0;
  for (let i = 0; i < 20 * CFG.tickHz; i++) { updateAIs(s, ais, s.tick++, rng); crashed += step(s, DT).length; }
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `20 s of 4 hard AIs took ${ms.toFixed(0)} ms`);
  console.log(`  4 hard AIs 20 s: ${ms.toFixed(0)} ms, ${crashed} crashes`);
}
console.log('ai tests passed');
