import assert from 'node:assert/strict';
import { CFG } from '../js/config.js';
import { createBike, createState, resetBike, spawnPoints } from '../js/state.js';
import { step, startBoost, startJump, jumpY, turnBike, canTurn, isAirborne, segBlocks } from '../js/physics.js';
import { aiAbilities, createAI, updateAIs, makeRng } from '../js/ai.js';

const DT = 1 / CFG.tickHz;
const mk = (...bikes) => { const s = createState(); s.bikes.push(...bikes); return s; };
const run = (s, secs, until) => { let ev = []; for (let i = 0, n = Math.round(secs * CFG.tickHz); i < n; i++) { ev = ev.concat(step(s, DT)); if (until && until()) break; } return ev; };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const wallAt = (id, x, z1, z2, y0 = 0) => { // static vertical trail wall along z at x
  const o = createBike(id, 0, x, z2, 0, 1); o.speed = 0; o.baseSpeed = 0;
  Object.assign(o.trail[0], { x1: x, x2: x, z1, z2, y0 }); return o;
};

{ // boost: 1.5x speed for 1.5 s, one-shot, then refills over ~6.5 s
  const b = createBike(0, 0, -40, 0, 1, 0), s = mk(b);
  assert.equal(b.boostMeter, 1);
  assert.ok(startBoost(b)); assert.equal(b.boostsUsed, 1);
  assert.ok(!startBoost(b), 'cannot restart while burning');
  near(b.speed, 22.5);
  run(s, 1.0); near(b.boostMeter, 1 / 3, 0.02); assert.ok(b.boosting);
  run(s, 0.5 + DT);
  assert.ok(!b.boosting); near(b.speed, 15); near(b.boostMeter, 0, 0.02);
  near(b.x, -40 + 22.5 * 1.5 + 15 * DT, 0.2);              // 33.75 units during the burst
  assert.ok(!startBoost(b), 'empty meter cannot boost');
  b.speed = b.baseSpeed = 0; // park the bike: only the meter matters from here
  run(s, 3.25); near(b.boostMeter, 0.5, 0.03);              // linear refill
  assert.ok(!startBoost(b));
  run(s, 3.25 + 0.05); assert.equal(b.boostMeter, 1);       // ~6.5 s total
  assert.ok(startBoost(b)); assert.equal(b.boostsUsed, 2);
}
{ // trail keeps being drawn while boosting
  const b = createBike(0, 0, -40, 0, 1, 0), s = mk(b);
  startBoost(b); run(s, 1);
  near(b.trail[0].x2 - b.trail[0].x1, 22.5, 0.2);
}
{ // jump arc timing & height; meter drains instantly, refills over 5 s
  near(jumpY(0), 0); near(jumpY(0.2), 3.5); near(jumpY(0.6), 3.5); near(jumpY(1.0), 3.5); near(jumpY(1.2), 0);
  assert.ok(jumpY(0.1) > 0 && jumpY(0.1) < 3.5 && jumpY(1.1) > 0 && jumpY(1.1) < 3.5);
  const b = createBike(0, 0, -45, 0, 1, 0), s = mk(b);
  assert.ok(startJump(b)); assert.equal(b.jumpsUsed, 1); assert.equal(b.jumpMeter, 0);
  assert.ok(!startJump(b));
  let peak = 0, airTicks = 0;
  for (let i = 0; i < 1.5 * CFG.tickHz; i++) { step(s, DT); peak = Math.max(peak, b.y); if (isAirborne(b)) airTicks++; }
  near(peak, 3.5, 1e-6); near(airTicks * DT, 1.2, DT * 2); assert.equal(b.y, 0);
  near(b.jumpMeter, 1.5 / 5, 0.01);
  assert.ok(!startJump(b), 'still recharging');
  run(s, 3.5 + 0.05); assert.equal(b.jumpMeter, 1);
  assert.ok(startJump(b));
}
{ // y at checkpoints during real stepping
  const b = createBike(0, 0, -45, 0, 1, 0), s = mk(b);
  startJump(b);
  run(s, 0.2); near(b.y, 3.5, 0.02);
  run(s, 0.4); near(b.y, 3.5, 1e-9);
  run(s, 0.4); near(b.y, 3.5, 0.02);
  run(s, 0.1); assert.ok(b.y < 3.5 && b.y > 0);
  run(s, 0.1 + DT); assert.equal(b.y, 0);
}
{ // no turning mid-air (turn dropped), airTurn flag allows it
  const b = createBike(0, 0, -45, 0, 1, 0), s = mk(b);
  run(s, 0.2); startJump(b); run(s, 0.3);
  assert.ok(!canTurn(b)); const n = b.trail.length; turnBike(b, 1);
  assert.equal(b.dx, 1); assert.equal(b.trail.length, n);
  b.airTurn = true; assert.ok(canTurn(b)); turnBike(b, 1); assert.equal(b.dz, 1);
}
{ // trail follows the arc: segments get y0 along the arc, many but bounded, grounded part back at y0 = 0
  const b = createBike(0, 0, -45, 0, 1, 0), s = mk(b);
  run(s, 0.1); startJump(b); run(s, 1.4);
  const ys = b.trail.map((t) => t.y0);
  assert.equal(ys[0], 0); assert.equal(b.trail[b.trail.length - 1].y0, 0);
  near(Math.max(...ys), 3.5, 0.26);
  assert.ok(b.trail.length > 10 && b.trail.length < 60, `segments ${b.trail.length}`);
  // contiguous
  for (let i = 1; i < b.trail.length; i++) { near(b.trail[i].x1, b.trail[i - 1].x2, 1e-9); }
  assert.ok(b.alive);
}
{ // vertical overlap rule: bike [y, y+1] vs segment [y0, y0+2]
  const seg = (y0) => ({ y0, h: 2 });
  assert.ok(segBlocks(0, seg(0))); assert.ok(segBlocks(1.9, seg(0))); assert.ok(!segBlocks(2, seg(0)));
  assert.ok(segBlocks(0, seg(0.9))); assert.ok(!segBlocks(0, seg(1))); assert.ok(!segBlocks(0, seg(3)));
  assert.ok(segBlocks(3.5, seg(3.5)) && segBlocks(3.5, seg(2.6)) && !segBlocks(3.5, seg(4.5)));
  assert.ok(segBlocks(0, { h: 2 }), 'segments without y0 are grounded');
}
{ // bike passes over a trail while airborne (jump started 10 units before a wall at x=0)
  const w = wallAt(1, 0, -10, 10);
  const b = createBike(0, 0, -10, 0, 1, 0), s = mk(b, w);
  startJump(b);
  const ev = run(s, 1.1);                      // ~16.5 units: over the wall at ~10 units in, still airborne
  assert.equal(ev.length, 0); assert.ok(b.x > 5 && b.alive);
}
{ // lands into a trail => crash credited to owner (wall 17 units after takeoff, landing at ~18)
  const w = wallAt(1, 7, -10, 10);
  const b = createBike(0, 0, -10, 0, 1, 0), s = mk(b, w);
  startJump(b);
  const ev = run(s, 1.5);
  assert.deepEqual(ev, [{ victim: 0, killer: 1 }]);
}
{ // jumping too late: wall 1 unit ahead, bike still low
  const w = wallAt(1, 0, -10, 10);
  const b = createBike(0, 0, -1, 0, 1, 0), s = mk(b, w);
  startJump(b);
  const ev = run(s, 0.5);
  assert.deepEqual(ev, [{ victim: 0, killer: 1 }]);
}
{ // enough clearance: jump 2 units ahead clears (y >= 2 after ~0.07 s = ~1 unit)
  const w = wallAt(1, 0, -10, 10);
  const b = createBike(0, 0, -2.5, 0, 1, 0), s = mk(b, w);
  startJump(b);
  assert.equal(run(s, 0.4).length, 0);
}
{ // elevated trail: a grounded bike passes under a segment whose bottom is above the bike (y0 >= bikeHeight), hits a low one
  const hi = wallAt(1, 0, -10, 10, 3), lo = wallAt(2, 0, -10, 10, 0.5);
  const b = createBike(0, 0, -5, 0, 1, 0);
  assert.equal(run(mk(b, hi), 0.7).length, 0); assert.ok(b.x > 0);
  const c = createBike(0, 0, -5, 0, 1, 0);
  assert.deepEqual(run(mk(c, lo), 0.7), [{ victim: 0, killer: 2 }]);
}
{ // a jumper's own elevated trail from one jump: another grounded bike crossing it mid-plateau passes, but the ramp part kills
  const j = createBike(1, 0, -30, 0, 1, 0);
  startJump(j); 
  const s = mk(j);
  run(s, 1.3);
  const plateau = j.trail.filter((t) => t.y0 >= 3.4);
  assert.ok(plateau.length >= 1);
  const ramp = j.trail.filter((t) => t.y0 < 1 && Math.abs(t.x2 - t.x1) > 0.01);
  assert.ok(ramp.length >= 1);
  // grounded bike driving along z across the plateau
  const px = (plateau[0].x1 + plateau[0].x2) / 2;
  const g = createBike(2, 0, px, -5, 0, 1);
  const o = createBike(3, 0, 0, 0, 1, 0); o.speed = 0; o.baseSpeed = 0; o.trail = j.trail;
  const s3 = mk(g, o); // g is alive; o is static with the jumper's trail
  assert.equal(run(s3, 0.8, () => g.z > 5).length, 0, 'passes under the plateau');
  const rx = (ramp[0].x1 + ramp[0].x2) / 2;
  const g2 = createBike(2, 0, rx, -5, 0, 1);
  assert.deepEqual(run(mk(g2, o), 0.8), [{ victim: 2, killer: 1 }], 'ramp segment (y0 < 1) is solid');
}
{ // arena walls are fatal even when airborne
  const b = createBike(0, 0, 47, 0, 1, 0), s = mk(b);
  startJump(b);
  assert.equal(run(s, 0.5).length, 1);
}
{ // resetBike clears per-round counters, meters and speed; honors base speed
  const b = createBike(0, 0, 0, 0, 1, 0), s = mk(b);
  startBoost(b); startJump(b); run(s, 0.3);
  resetBike(b, spawnPoints(4)[0], 25);
  assert.equal(b.boostsUsed, 0); assert.equal(b.jumpsUsed, 0); assert.equal(b.boostMeter, 1); assert.equal(b.jumpMeter, 1);
  assert.equal(b.y, 0); assert.ok(!isAirborne(b)); assert.equal(b.speed, 25);
  startBoost(b); near(b.speed, 37.5);
}
{ // AI: jumps when boxed in (trail ahead and on both sides), not on easy, not toward an arena wall
  const box = () => {
    const a = createBike(0, 0, 0, 0, 1, 0);
    const ahead = wallAt(1, 4, -10, 10);
    const l = createBike(2, 0, -10, 1.5, 1, 0), r = createBike(3, 0, -10, -1.5, 1, 0);
    for (const o of [l, r]) { o.speed = 0; o.baseSpeed = 0; Object.assign(o.trail[0], { x1: -10, x2: 10, z1: o.z, z2: o.z }); }
    return [a, mk(a, ahead, l, r)];
  };
  let [a, s] = box();
  assert.ok(aiAbilities(s, a, createAI(1), makeRng(1)).jump);
  assert.ok(aiAbilities(s, a, createAI(2), makeRng(1)).jump);
  assert.ok(!aiAbilities(s, a, createAI(0), makeRng(1)).jump, 'easy never jumps');
  [a, s] = box();
  const ais = new Map([[0, createAI(1, 0)]]);
  let ev = [];
  for (let i = 0; i < 2 * CFG.tickHz && !ev.length; i++) { updateAIs(s, ais, s.tick++, makeRng(2)); ev = step(s, DT); }
  assert.equal(a.jumpsUsed, 1);
  assert.equal(ev.length, 0, 'AI escaped over the trail');
  // open side available -> no jump
  const b = createBike(0, 0, 0, 0, 1, 0), s2 = mk(b, wallAt(1, 4, -10, 10));
  assert.ok(!aiAbilities(s2, b, createAI(2), makeRng(1)).jump);
  // wall ahead (arena) -> no jump
  const c = createBike(0, 0, 47, 0, 1, 0), s3 = mk(c);
  assert.ok(!aiAbilities(s3, c, createAI(2), makeRng(1)).jump);
}
{ // AI boosts on a long open straight at normal/hard (eventually), never on easy
  for (const [lvl, expect] of [[0, false], [1, true], [2, true]]) {
    const b = createBike(0, 0, -45, 0, 1, 0), s = mk(b); // 95 units free
    b.x = -48; let used = false; const rng = makeRng(5);
    for (let i = 0; i < 300; i++) if (aiAbilities(s, b, createAI(lvl), rng).boost) used = true;
    assert.equal(used, expect, `level ${lvl}`);
  }
  const b = createBike(0, 0, 30, 0, 1, 0), s = mk(b); // 20 units free: no boost
  for (let i = 0; i < 300; i++) assert.ok(!aiAbilities(s, b, createAI(2), makeRng(i)).boost);
}
{ // a full AI round with boost/jump stays healthy and counters move
  const rng = makeRng(9);
  const pts = spawnPoints(4);
  const s = mk(...pts.map((p, i) => { const b = createBike(i, 0, p.x, p.z, p.dx, p.dz); return b; }));
  const ais = new Map(s.bikes.map((b, i) => [b.id, createAI(2, i * 2)]));
  for (let i = 0; i < 40 * CFG.tickHz; i++) { updateAIs(s, ais, s.tick++, rng); step(s, DT); }
  const used = s.bikes.reduce((n, b) => n + b.boostsUsed + b.jumpsUsed, 0);
  assert.ok(used > 0, 'AIs used abilities');
  console.log(`  40 s hard AI round: ${used} ability uses, ${s.bikes.filter((b) => b.alive).length} alive`);
}
console.log('abilities tests passed');
