// Regression: on a ramp the trail starts a new segment every height step, so the turn gap must count distance since the
// last turn, not the newest segment's length (owner's "4 platforms" map: could not turn while climbing the tilted platform).
import assert from 'node:assert/strict';
import { createState, createBike } from '../js/state.js';
import { step, turnBike, canTurn } from '../js/physics.js';
import { groundAt } from '../js/maps.js';
import { CFG } from '../js/config.js';

const map = { name: 'ramp', walls: false, half: 120, killY: -60, spawns: [],
  platforms: [{ x0: 17.5, z0: -30.5, x1: 117.5, z1: 30.5, y: -10, rot: -Math.PI / 2, rz: Math.PI / 6 }] }; // 30 deg, rises toward +z
const st = createState(); st.map = map;
const b = createBike(0, 0xffffff, 70, -30, 0, 1); b.y = groundAt(map, 70, -30); st.bikes.push(b);
const DT = 1 / CFG.tickHz;
for (let i = 0; i < 120; i++) step(st, DT); // climb
assert.ok(b.alive && !b.falling && b.y > groundAt(map, 70, -30) + 2, 'climbing the ramp');
assert.ok(b.trail.length > 5, 'ramp splits the trail into short height steps');
assert.equal(canTurn(b), true, 'can turn while climbing');
turnBike(b, 1); assert.equal(b.dx, -1);
assert.equal(canTurn(b), false, 'min turn gap still applies right after a turn');
let n = 0; while (!canTurn(b) && n < 60) { step(st, DT); n++; }
assert.ok(n * DT * b.speed >= CFG.minTurnGap - 1e-6 && n < 30, 'gap opens after minTurnGap units');
console.log('rampturn ok');
