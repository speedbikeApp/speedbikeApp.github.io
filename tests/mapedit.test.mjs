// Rotated platforms (physics) + custom map validation + pure editor maths.
import assert from 'node:assert/strict';
import { groundAt, toLocal, toWorld, MAPS } from '../js/maps.js';
import { step } from '../js/physics.js';
import { createBike, createState } from '../js/state.js';
import { validateMap, rectPlatform, rayBox, groundHit, pickObject, dirOfYaw, yawOfDir, isTiered, platformCorners } from '../js/mapdef.js';
import { pickRespawn } from '../js/modes.js';

const dt = 1 / 120;
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

{ // local <-> world round trip, 90 degree yaw
  const p = { x0: 0, z0: 0, x1: 20, z1: 10, y: 0, rot: Math.PI / 2 };
  const [wx, wz] = toWorld(p, 20, 5); near(wx, 10); near(wz, -5); // local +x end of the long axis points to world -z (Three rotation.y)
  const [lx, lz] = toLocal(p, wx, wz); near(lx, 20); near(lz, 5);
}
{ // groundAt honours rot: a 20x10 slab yawed 90deg covers x 5..15, z -5..15 around its centre (10,5), not x 0..20
  const map = { platforms: [{ x0: 0, z0: 0, x1: 20, z1: 10, y: 1, rot: Math.PI / 2 }] };
  assert.equal(groundAt(map, 10, 14), 1); assert.equal(groundAt(map, 10, -3), 1); assert.equal(groundAt(map, 10, -6), -Infinity);
  assert.equal(groundAt(map, 18, 5), -Infinity, 'old unrotated end is now void'); assert.equal(groundAt(map, 4, 5), -Infinity); assert.equal(groundAt(map, 6, 5), 1);
  const d = { platforms: [{ x0: -5, z0: -5, x1: 5, z1: 5, y: 0, rot: Math.PI / 4 }] }; // diamond: corner at 7.07
  assert.equal(groundAt(d, 6, 0), 0); assert.equal(groundAt(d, 5.5, 5.5), -Infinity);
}
{ // a bike drives off a yawed platform's slanted edge (void fall) and lands on a yawed platform
  const map = { half: 60, killY: -14, walls: false, platforms: [{ x0: -10, z0: -10, x1: 10, z1: 10, y: 0, rot: Math.PI / 4 }] };
  const s = createState(); s.map = map; const b = createBike(0, 0, 0, 0, 1, 0); s.bikes.push(b);
  let ev = [], x = 0;
  for (let i = 0; i < 120 * 6 && !ev.length; i++) { ev = step(s, dt); if (!b.falling) x = b.x; }
  assert.equal(ev[0].cause, 'void'); assert.ok(x > 13.8 && x < 14.5, `fell at the diamond corner (14.14), not the square edge (10): ${x}`);
}
{ // side crash into a yawed higher platform
  const map = { half: 60, killY: -14, walls: false, platforms: [{ x0: -50, z0: -50, x1: 50, z1: 50, y: 0 }, { x0: 10, z0: -10, x1: 30, z1: 10, y: 3, rot: 0.3 }] };
  const s = createState(); s.map = map; const b = createBike(0, 0, 0, 0, 1, 0); s.bikes.push(b);
  let ev = []; for (let i = 0; i < 120 * 5 && !ev.length; i++) ev = step(s, dt);
  assert.equal(ev[0].cause, 'side'); assert.ok(b.x > 8 && b.x < 14);
}
{ // Death Match respawn samples inside a yawed platform
  const map = { half: 60, platforms: [{ x0: -10, z0: -10, x1: 10, z1: 10, y: 0, rot: 0.7 }], killY: -14, walls: false };
  const s = createState(); s.map = map; s.bikes.push(createBike(0, 0, 0, 0, 1, 0));
  for (let i = 0; i < 20; i++) { const r = pickRespawn(s, { id: 9 }, Math.random); assert.notEqual(groundAt(map, r.x, r.z), -Infinity); }
}

// ---- validation
const good = () => ({ name: 'My Map_1', half: 36, killY: -14, platforms: [{ x0: -30, z0: -30, x1: 30, z1: 30, y: 0 }],
  spawns: [{ x: 0, z: 18, dx: 0, dz: -1 }, { x: -18, z: 0, dx: 1, dz: 0 }, { x: 0, z: -18, dx: 0, dz: 1 }, { x: 18, z: 0, dx: -1, dz: 0 }] });
{
  const v = validateMap(good()); assert.ok(v.ok); assert.equal(v.map.spawns[0].y, 0); assert.equal(v.map.walls, false);
  const g = good(); g.platforms[0].y = 2; g.killY = -14; g.junk = 1; g.platforms[0].evil = 1;
  const w = validateMap(g); assert.ok(w.ok); assert.equal(w.map.spawns[1].y, 2, 'spawn y derived from the platform'); assert.equal(w.map.junk, undefined); assert.equal(w.map.platforms[0].evil, undefined);
  const r = good(); r.half = 60; r.platforms[0].rot = 7; assert.ok(Math.abs(validateMap(r).map.platforms[0].rot - (7 - 2 * Math.PI)) < 1e-3, 'rot normalised');
  const bad = (f, re) => { const m = good(); f(m); const x = validateMap(m); assert.equal(x.ok, false, re); assert.match(x.why, re); };
  bad((m) => { m.name = ''; }, /NAME/); bad((m) => { m.name = 'x'.repeat(21); }, /NAME/); bad((m) => { m.name = '<b>'; }, /NAME/);
  bad((m) => { m.platforms = []; }, /PLATFORMS/); bad((m) => { m.platforms = Array(201).fill(good().platforms[0]); }, /PLATFORMS/);
  bad((m) => { m.spawns.pop(); }, /SPAWN/); bad((m) => { m.spawns = [...m.spawns, ...m.spawns, { x: 1, z: 1, dx: 0, dz: 1 }]; }, /SPAWN/);
  bad((m) => { m.platforms[0].x0 = NaN; }, /BAD NUMBER/); bad((m) => { m.platforms[0].x1 = '30'; }, /BAD NUMBER/); bad((m) => { m.platforms[0].y = Infinity; }, /BAD NUMBER/);
  bad((m) => { m.platforms[0].y = 99; }, /HEIGHT/); bad((m) => { m.platforms[0].x1 = -29; }, /SMALL/); bad((m) => { m.platforms[0].x0 = -300; m.half = 150; }, /BIG|OUTSIDE/);
  bad((m) => { m.platforms[0].rot = 'a'; }, /ROTATION/); bad((m) => { m.half = 10; }, /ARENA/); bad((m) => { m.half = 30; m.platforms[0].rot = 0.7; }, /OUTSIDE/);
  bad((m) => { m.killY = 0; }, /KILL/); bad((m) => { m.spawns[0].x = 45; }, /OUTSIDE|NOT ON/); bad((m) => { m.spawns[0].x = 33; }, /NOT ON A PLATFORM/);
  bad((m) => { m.spawns[0].dx = 1; m.spawns[0].dz = 1; }, /DIRECTION/); bad((m) => { m.spawns[1].x = 0.5; m.spawns[1].z = 18; }, /CLOSE/); bad((m) => { m.spawns[2] = null; }, /BAD NUMBER/);
  assert.equal(validateMap(null).ok, false); assert.equal(validateMap([]).ok, false); assert.equal(validateMap('x').ok, false);
  const t = good(); t.platforms.push({ x0: 0, z0: 0, x1: 6, z1: 6, y: 2 }); assert.ok(isTiered(validateMap(t).map)); assert.ok(!isTiered(validateMap(good()).map));
}

// ---- editor maths
{
  assert.deepEqual(rectPlatform(5.2, 9.7, -4.8, -0.2, 1, 1), { x0: -5, z0: 0, x1: 5, z1: 10, y: 1 }, 'corners in any order, snapped');
  assert.equal(rectPlatform(0, 0, 1, 20, 0), null, 'too small');
  assert.deepEqual(groundHit([0, 10, 0], [1, -1, 0], 0).map(Math.round), [10, 0]); assert.equal(groundHit([0, 10, 0], [1, 1, 0], 0), null);
  const box = { cx: 0, cy: 0, cz: 0, hx: 10, hy: 1, hz: 2, rot: 0 };
  near(rayBox([0, 5, 0], [0, -1, 0], box), 4); assert.equal(rayBox([0, 5, 5], [0, -1, 0], box), null);
  assert.ok(rayBox([0, 5, 5], [0, -1, 0], { ...box, rot: Math.PI / 2 }) !== null, 'yawed box is long along z');
  const map = { platforms: [{ x0: -10, z0: -10, x1: 10, z1: 10, y: 0 }, { x0: 20, z0: -10, x1: 30, z1: 10, y: 0, rot: 0.5 }], spawns: [{ x: 0, z: 0, dx: 0, dz: 1, y: 0 }] };
  assert.deepEqual(pickObject(map, [5, 10, 5], [0, -1, 0]), { kind: 'platform', index: 0 });
  assert.deepEqual(pickObject(map, [0, 10, 0], [0, -1, 0]), { kind: 'spawn', index: 0 }, 'spawn wins over the platform under it');
  assert.deepEqual(pickObject(map, [25, 10, 0], [0, -1, 0]), { kind: 'platform', index: 1 }); assert.equal(pickObject(map, [50, 10, 0], [0, -1, 0]), null);
  for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) assert.deepEqual(dirOfYaw(yawOfDir(dx, dz)), { dx, dz });
  assert.deepEqual(dirOfYaw(1.3), { dx: 1, dz: 0 });
  assert.equal(platformCorners({ x0: -1, z0: -1, x1: 1, z1: 1 }).length, 4);
}
{ // built-in maps still validate-free: no rot anywhere
  for (const m of Object.values(MAPS)) for (const p of m.platforms) assert.equal(p.rot, undefined);
}
console.log('mapedit tests passed');
