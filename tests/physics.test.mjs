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
console.log('physics tests passed');
