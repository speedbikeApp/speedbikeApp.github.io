// Pure logic (no three). Fixed-step movement + swept collision.
import { CFG } from './config.js';
import { newSegment } from './state.js';
import { mapOf, groundAt } from './maps.js';
import { hooks, tickAbilities, speedMult, boostDuration, jumpRecharge, canDoubleJump, isProtected } from './abilities.js';

const EPS = 1e-6;

// Vertical overlap: bike occupies [y, y+bikeHeight], segment [y0, y0+h]. Touching edges do not collide.
export function segBlocks(y, s) {
  const y0 = s.y0 || 0;
  return y < y0 + s.h && y + CFG.bikeHeight > y0;
}

// Airborne = in a jump arc or falling off an edge (no turning, no new jump).
export const isAirborne = (b) => b.jumpT >= 0 || !!b.falling;
const Y_TOL = 0.05; // a platform top this much above the bike (or less) is a step, not a wall

// Jump height at t seconds into the arc. H = rise above the start height y0, ts stretches the timing (Rocket Jump).
// The fall ends at yEnd = the ground height at takeoff (a Double Jump restarts the arc from the current height y0).
export function jumpY(t, H = CFG.jump.height, ts = 1, y0 = 0, yEnd = 0) {
  const J = CFG.jump, rise = J.rise * ts, flt = J.float * ts, fall = J.fall * ts, peak = y0 + H;
  if (t <= 0) return y0;
  if (t < rise) { const u = t / rise; return y0 + H * (1 - (1 - u) * (1 - u)); }
  if (t <= rise + flt) return peak;
  const u = (t - rise - flt) / fall;
  return u >= 1 ? yEnd : yEnd + (peak - yEnd) * (1 - u * u);
}
const jumpTotal = (ts = 1) => (CFG.jump.rise + CFG.jump.float + CFG.jump.fall) * ts;

// One-shot burst; only when the meter is full. Returns true if started.
export function startBoost(b) {
  if (!b.alive || b.boosting || b.boostMeter < 1) return false;
  b.boosting = true; b.boostDur = b.boostLeft = boostDuration(b); b.boostsUsed++; b.speed = b.baseSpeed * speedMult(b); b.spdMod = true;
  return true;
}
// Only when grounded with a full meter. Meter empties instantly. Returns true if started.
// opts {height, timeScale} = Rocket Jump. Airborne + Double Jump equipped: one extra jump per airtime (no meter needed).
export function startJump(b, opts) {
  if (!b.alive || b.falling) return false;
  if (b.jumpT >= 0) {
    if (b.djUsed || !canDoubleJump(b)) return false;
    b.djUsed = true; b.jumpY0 = b.y; b.jumpH = CFG.jump.height; b.jumpTS = 1; b.jumpDur = jumpTotal(1); b.jumpT = 0; b.jumpsUsed++;
    return true;
  }
  if (b.jumpMeter < 1) return false;
  b.jumpH = opts && opts.height || CFG.jump.height; b.jumpTS = opts && opts.timeScale || 1; b.jumpY0 = b.jumpG = b.y; b.jumpDur = jumpTotal(b.jumpTS);
  b.jumpT = 0; b.jumpMeter = 0; b.jumpsUsed++; b.djUsed = false;
  return true;
}
hooks.startBoost = startBoost; hooks.startJump = startJump;

// Advance meters, boost timer and jump arc (sets b.y along the arc; terrain is resolved afterwards by settle()).
function updateAbilities(b, dt) {
  tickAbilities(b, dt);
  if (b.spawnProt > 0) b.spawnProt = Math.max(0, b.spawnProt - dt);
  if (b.boosting) {
    b.boostLeft -= dt;
    if (b.boostLeft <= 1e-9) { b.boosting = false; b.boostLeft = 0; b.boostMeter = 0; }
    else b.boostMeter = b.boostLeft / (b.boostDur || CFG.boost.duration);
  } else if (b.boostMeter < 1) b.boostMeter = Math.min(1, b.boostMeter + dt / CFG.boost.recharge);
  if (b.jumpMeter < 1) b.jumpMeter = Math.min(1, b.jumpMeter + dt / jumpRecharge(b));
  // speed = base * max(boost, turbo) * slow. Only touched while a modifier is (or just was) active.
  const m = speedMult(b);
  if (m !== 1 || b.spdMod) { b.speed = b.baseSpeed * m; b.spdMod = m !== 1; }
  if (b.jumpT >= 0) {
    b.jumpT += dt;
    if (b.jumpT >= (b.jumpDur || jumpTotal()) - 1e-9) {
      // Arc finished at the takeoff height: keep falling with the arc's end speed (lands at once if ground is there).
      const ts = b.jumpTS || 1, fall = CFG.jump.fall * ts, g0 = b.jumpG || 0;
      const peak = b.jumpY0 + b.jumpH;
      b.jumpT = -1; b.djUsed = false; b.y = g0; b.jumpY0 = g0; b.falling = true;
      b.vy = -2 * Math.max(0, peak - g0) / fall;
    } else b.y = jumpY(b.jumpT, b.jumpH, b.jumpTS, b.jumpY0, b.jumpG || 0);
  }
}

// Vertical resolution after the horizontal move. yPrev = height before this tick. Returns a fatal cause or undefined.
//   'side' : the ground under the new position is higher than the bike was (ran into the side of a higher platform)
//   'void' : fell below map.killY with nothing to land on
// Otherwise: lands on a platform (jump arc descending through its top, or falling onto it), stays on flat ground, starts
// falling when the ground ends, and follows steps within Y_TOL.
function settle(b, map, yPrev, dt) {
  const g = groundAt(map, b.x, b.z);
  if (g > yPrev + Y_TOL) return 'side';
  if (b.jumpT >= 0) { // scripted arc: lands when it comes down onto ground
    if (g > -Infinity && b.y <= g + 1e-9 && b.y < yPrev) {
      b.y = g; b.jumpT = -1; b.djUsed = false; b.falling = false; b.vy = 0; b.justLanded = true;
    }
    return undefined;
  }
  if (!b.falling) {
    if (g >= b.y - Y_TOL) { if (g !== b.y) { b.y = g; } return undefined; } // flat ground / small step
    b.falling = true; b.vy = 0;
  }
  b.vy -= CFG.gravity * dt; b.y += b.vy * dt;
  if (g > -Infinity && b.y <= g) { b.y = g; b.falling = false; b.vy = 0; b.justLanded = true; return undefined; }
  if (b.y < map.killY) return 'void';
  return undefined;
}

export function turnBike(b, side) { // side: -1 left, +1 right
  if (isAirborne(b) && !b.airTurn) return; // no turning mid-air (Air Turn ability sets airTurn)
  const { dx, dz } = b;
  if (side < 0) { b.dx = dz; b.dz = -dx; } else { b.dx = -dz; b.dz = dx; }
  b.trail.push(newSegment(b));
}

// Turns are allowed once the newest segment is at least minTurnGap long (keeps double-tap lanes safe).
export function canTurn(b) {
  if (isAirborne(b) && !b.airTurn) return false;
  const s = b.trail[b.trail.length - 1];
  return !!s && Math.abs(s.x2 - s.x1) + Math.abs(s.z2 - s.z1) >= CFG.minTurnGap - 1e-9;
}

// Returns undefined (no hit), null (wall) or owner id of the trail hit.
function hit(state, b, x0, z0) {
  const map = mapOf(state), half = map.half;
  if (map.walls && (Math.abs(b.x) >= half || Math.abs(b.z) >= half)) return null;
  // movement box; start point excluded so touching our own previous segment's corner isn't a hit
  let ax = Math.min(x0, b.x), bx = Math.max(x0, b.x), az = Math.min(z0, b.z), bz = Math.max(z0, b.z);
  if (b.dx > 0) ax += EPS; else if (b.dx < 0) bx -= EPS;
  if (b.dz > 0) az += EPS; else if (b.dz < 0) bz -= EPS;
  if (isProtected(b) || b.spawnProt > 0) return undefined; // Protector / spawn protection: trails are harmless (walls still kill)
  for (const o of state.bikes) {
    const last = o.trail[o.trail.length - 1];
    for (const s of o.trail) {
      if (s === last && o === b) continue; // own newest segment
      if (!segBlocks(b.y, s)) continue;    // above / below this segment (jump)
      if (ax <= Math.max(s.x1, s.x2) && bx >= Math.min(s.x1, s.x2) &&
          az <= Math.max(s.z1, s.z2) && bz >= Math.min(s.z1, s.z2)) return s.owner;
    }
  }
  return undefined;
}

// Advance all alive bikes by dt. Returns [{victim, killer}] (killer null = wall / edge / void). Fatal falls and side hits
// carry an extra `cause` ('void' | 'side'); wall and trail events have no `cause` key.
export function step(state, dt) {
  state.time += dt;
  const map = mapOf(state), moved = [];
  for (const b of state.bikes) {
    if (!b.alive) continue;
    const yPrev = b.y;
    updateAbilities(b, dt);
    // Trail follows the arc: start a new segment (at the current head, like a turn) once y drifted a step from the
    // newest segment's base, and after landing so the grounded trail sits on the ground. Done before moving so the
    // finished segment ends at the old head and is never hit by this tick's sweep.
    const cy = b.trail[b.trail.length - 1].y0 || 0;
    if (Math.abs(b.y - cy) >= CFG.jump.trailStep - 1e-9 || (b.justLanded && cy !== b.y)) b.trail.push(newSegment(b));
    b.justLanded = false;
    const x0 = b.x, z0 = b.z, d = b.speed * dt;
    b.x += b.dx * d; b.z += b.dz * d;
    const s = b.trail[b.trail.length - 1];
    s.x2 = b.x; s.z2 = b.z;
    moved.push([b, x0, z0, settle(b, map, yPrev, dt)]);
  }
  const events = [];
  for (const [b, x0, z0, cause] of moved) { // all checked before any removal => head-on kills both
    if (cause) { events.push({ victim: b.id, killer: null, cause }); continue; }
    const k = hit(state, b, x0, z0);
    if (k !== undefined) events.push({ victim: b.id, killer: k });
  }
  for (const e of events) {
    const b = state.bikes.find((v) => v.id === e.victim);
    b.alive = false; b.trail.length = 0;
  }
  return events;
}
