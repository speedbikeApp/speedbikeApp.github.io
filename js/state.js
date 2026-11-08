import { CFG } from './config.js';
import { resetAbilityState } from './abilities.js';
import { MAPS } from './maps.js';

// Segment: {x1,z1,x2,z2,y0,h,owner}; occupies heights [y0, y0+h]. Axis-aligned; last one of bike.trail is the growing one.
export function newSegment(b) {
  return { x1: b.x, z1: b.z, x2: b.x, z2: b.z, y0: b.y, h: CFG.trailHeight, owner: b.id };
}

// Ability state: meters are 0..1 (1 = ready). jumpT < 0 = grounded, else seconds into the jump arc.
function resetAbilities(b) {
  b.boostMeter = 1; b.boosting = false; b.boostLeft = 0;
  b.jumpMeter = 1; b.jumpT = -1;
  b.falling = false; b.vy = 0; b.justLanded = false; b.jumpG = b.y || 0; b.spawnProt = 0; // height / fall state (phase 7)
  b.sinceTurn = 0; // units driven since the last turn (canTurn); not the trail segment length, which ramps / jumps split by height
  b.boostsUsed = 0; b.jumpsUsed = 0; // per-round counters
  resetAbilityState(b); // cooldowns / active timers / once-per-round flags; equipped abilities persist
}

// dir (dx,dz) is a unit axis vector. y = height above floor. baseSpeed = un-boosted speed (speed may be boosted).
export function createBike(id, color, x, z, dx, dz) {
  const b = { id, color, x, z, y: 0, dx, dz, speed: CFG.baseSpeed, baseSpeed: CFG.baseSpeed, alive: true, airTurn: false, trail: [] };
  resetAbilities(b);
  b.trail.push(newSegment(b));
  return b;
}

// Re-place a bike at a spawn point with a fresh trail (round reset).
export function resetBike(b, p, speed = CFG.baseSpeed) {
  b.x = p.x; b.z = p.z; b.y = p.y || 0; b.dx = p.dx; b.dz = p.dz; b.speed = speed; b.baseSpeed = speed; b.alive = true;
  resetAbilities(b);
  b.trail.length = 0; b.trail.push(newSegment(b));
}

// Fixed evenly spaced spawns facing the center. Order S, W, N, E; n=2 -> S,N; n=3 -> S,W,E. Default map: on the axes at
// spawnRadius * half; other maps list their own (map.spawns).
export function spawnPoints(n, map = MAPS.arena) {
  const R = CFG.arena.half * CFG.spawnRadius;
  const all = map.spawns || [
    { x: 0, z: R, dx: 0, dz: -1 }, { x: -R, z: 0, dx: 1, dz: 0 },
    { x: 0, z: -R, dx: 0, dz: 1 }, { x: R, z: 0, dx: -1, dz: 0 },
  ];
  const pick = { 1: [0], 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] }[n];
  return pick.map((i) => all[i]);
}

export function createState() {
  return { bikes: [], time: 0, tick: 0, playerId: 0, map: MAPS.arena };
}
