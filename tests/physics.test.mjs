import assert from 'node:assert/strict';
import { step, turnBike } from '../js/physics.js';
import { createBike, createState } from '../js/state.js';

const dt = 1 / 120;
const mk = (...bikes) => { const s = createState(); s.bikes.push(...bikes); return s; };

{ // no walls: driving off the platform edge = fall (killer null, cause void), only after dropping below the map
  const b = createBike(0, 0, 0, 0, 1, 0), s = mk(b);
  let ev = [], fallTicks = 0;
  for (let i = 0; i < 120 * 5 && !ev.length; i++) { ev = step(s, dt); if (b.falling) fallTicks++; }
  assert.equal(ev.length, 1); assert.equal(ev[0].killer, null); assert.equal(ev[0].cause, 'void'); assert.ok(!b.alive);
  assert.ok(b.x > 51 && b.x < 51 + 15 * 1.2, 'dropped off the edge, kept moving forward'); assert.ok(fallTicks * dt > 0.5 && fallTicks * dt < 1.2);
}
{ // trail crash credits owner
  const a = createBike(0, 0, 0, 0, 1, 0), o = createBike(1, 0, 10, 10, 0, 1);
  o.trail[0].z1 = -10; o.speed = 0; // vertical wall at x=10, z -10..10
  const s = mk(a, o);
  let ev = [];
  for (let i = 0; i < 120 * 3 && !ev.length; i++) ev = step(s, dt);
  assert.deepEqual(ev, [{ victim: 0, killer: 1 }]);
  assert.equal(a.trail.length, 0);
}
{ // own newest segment ignored, incl. right after a turn
  const b = createBike(0, 0, 0, 0, 1, 0), s = mk(b);
  for (let i = 0; i < 100; i++) assert.equal(step(s, dt).length, 0);
  turnBike(b, 1);
  for (let i = 0; i < 100; i++) assert.equal(step(s, dt).length, 0);
  assert.ok(b.alive); assert.equal(b.trail.length, 2);
}
{ // own older segment kills (square loop)
  const b = createBike(0, 0, 0, 0, 1, 0), s = mk(b);
  let ev = [];
  for (let side = 0; side < 4 && !ev.length; side++) {
    for (let i = 0; i < 120 && !ev.length; i++) ev = step(s, dt); // 15 units
    if (!ev.length) turnBike(b, 1);
  }
  for (let i = 0; i < 120 && !ev.length; i++) ev = step(s, dt);
  assert.equal(ev.length, 1); assert.equal(ev[0].killer, 0);
}
{ // no tunneling at huge speed
  const a = createBike(0, 0, 0, 0, 1, 0), o = createBike(1, 0, 5, 10, 0, 1);
  o.trail[0].z1 = -10; o.speed = 0;
  a.speed = 1000; // 8.3 units per tick, wall at x=5
  const ev = step(mk(a, o), dt);
  assert.equal(ev.length, 1); assert.equal(ev[0].killer, 1);
}
{ // head-on: both die
  const a = createBike(0, 0, -1, 0, 1, 0), b = createBike(1, 0, 1, 0, -1, 0), s = mk(a, b);
  let ev = [];
  for (let i = 0; i < 60 && !ev.length; i++) ev = step(s, dt);
  assert.equal(ev.length, 2);
}
{ // landing inside a wall kills, also off its zero-thickness centre line; riding beside it and jumping over it still works
  const W = { ...(await import('../js/physics.js')), ...(await import('../js/state.js')) };
  const ride = (off, { axis = 'x', dir = 1, jump = true, protect = 0, wall } = {}) => {
    const S = W.createState(), flip = (x, z) => (axis === 'x' ? [x * dir, z] : [z, x * dir]);
    const [x, z] = flip(-12, off), [dx, dz] = flip(1, 0);
    const b = W.createBike(0, 0, x, z, dx, dz), o = W.createBike(1, 0, -45, -45, 1, 0);
    const [a0, a1] = [flip(...(wall ? wall[0] : [-3, 0])), flip(...(wall ? wall[1] : [40, 0]))];
    o.alive = false; o.trail = [{ x1: a0[0], z1: a0[1], x2: a1[0], z2: a1[1], y0: 0, h: 2, owner: 1 }];
    S.bikes = [b, o]; b.spawnProt = protect;
    if (jump) W.startJump(b);
    for (let i = 0; i < 240 && b.alive; i++) W.step(S, 1 / 120);
    return b.alive;
  };
  for (const axis of ['x', 'z']) for (const dir of [1, -1]) {
    for (const off of [0.001, 0.14, 0.45, -0.45]) assert.equal(ride(off, { axis, dir }), false, `landed inside at ${off} (${axis} ${dir})`);
    for (const off of [0.6, -0.6, 1]) assert.equal(ride(off, { axis, dir }), true, `landed beside at ${off} (${axis} ${dir})`);
    assert.equal(ride(0.3, { axis, dir, jump: false }), true, 'riding up close beside a wall is unchanged');
    assert.equal(ride(0, { axis, dir, wall: [[-6, -8], [-6, 8]] }), true, 'a jump over a crossing wall still works');
    assert.equal(ride(0.3, { axis, dir, jump: false, protect: 1 }), false, 'protection ran out inside a wall');
  }
}
console.log('physics tests passed');
