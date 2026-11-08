// AI opponents. Pure logic (no three) so it can be tested headless.
import { CFG } from './config.js';
import { turnBike, canTurn, segBlocks, startJump, startBoost, jumpY } from './physics.js';
import { isProtected, useAbilityId, canUse } from './abilities.js';
import { mapOf, groundAt, terrainProbe } from './maps.js';

export function makeRng(seed = 1) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const left = (b) => [b.dz, -b.dx];   // matches turnBike(-1)
const right = (b) => [-b.dz, b.dx];  // matches turnBike(+1)
// All look-ahead / reaction distances scale with speed so the AI reacts at the same TIME-to-impact at Hyper speed,
// boost and Turbo (ratio >= 1: never shorter than at the standard base speed).
const ratio = (b) => Math.max(1, (b.speed || 0) / CFG.baseSpeed);
const grounded = (b) => b.jumpT < 0 && !b.falling;
const ROOM = 12; // free run a lower platform needs below the landing point before a bot drives off an edge onto it
const DROP_AREA = 160; // open flood-fill cells the lower level needs (dead-end ledges stay off limits)
const JUMP_UP = 2.6; // highest step a jump can climb with margin (jump peak is 3.5)

// What is straight ahead of bike b along (dx,dz), up to `max` units: {d, kind}. kind: 'wall' (arena wall), 'trail',
// 'void' / 'drop' / 'high' (platform edge into nothing / onto a lower platform / side of a higher platform), 'max'. Ramps are drivable,
// and a drop with room to carry on below counts as open road (bots use the lower levels).
// Single-platform walled arenas skip the terrain march (exact analytic wall distance, as in phases 2-6).
export function probe(state, b, dx, dz, max = CFG.ai.maxLook * ratio(b)) {
  const map = mapOf(state), H = map.half;
  let d = max, kind = 'max';
  if (map.walls) {
    const w = dx > 0 ? H - b.x : dx < 0 ? H + b.x : dz > 0 ? H - b.z : H + b.z;
    if (w < d) { d = w; kind = 'wall'; }
  }
  if (!(map.walls && map.platforms.length === 1) && grounded(b)) {
    let t = terrainProbe(map, b.x, b.z, dx, dz, b.y, d);
    if (t.kind === 'drop' || t.kind === 'void') { // driving off: open road if the fall lands on a lower level with room, no trail, a big area
      const e = t.d + 0.5, L = fallLanding(map, b.x + dx * e, b.z + dz * e, dx, dz, b.y, b.speed), land = L && e + L.u + 1;
      if (L && land < d && terrainProbe(map, b.x + dx * land, b.z + dz * land, dx, dz, L.g, ROOM).d >= ROOM - 1e-9 && !trailBetween(state, b, t.d, land + ROOM, dx, dz)
        && floodArea(buildGrid(state, L.g), b.x + dx * land, b.z + dz * land, dx, dz, DROP_AREA) >= DROP_AREA) t = { kind: 'none' }; // not a dead-end ledge
    }
    if (t.kind !== 'none') { d = t.d; kind = t.kind; }
  }
  if (isProtected(b)) return { d, kind }; // Protector: only walls / edges matter
  const m = 0.6; // lateral margin
  for (const o of state.bikes) {
    if (!o.alive) continue;
    const last = o.trail[o.trail.length - 1];
    for (const s of o.trail) {
      if (o === b && s === last) continue;
      if (!segBlocks(b.y, s)) continue;
      const x0 = Math.min(s.x1, s.x2), x1 = Math.max(s.x1, s.x2), z0 = Math.min(s.z1, s.z2), z1 = Math.max(s.z1, s.z2);
      let t;
      if (dx !== 0) {
        if (b.z < z0 - m || b.z > z1 + m) continue;
        if (dx > 0 ? x1 <= b.x : x0 >= b.x) continue;
        t = dx > 0 ? x0 - b.x : b.x - x1;
      } else {
        if (b.x < x0 - m || b.x > x1 + m) continue;
        if (dz > 0 ? z1 <= b.z : z0 >= b.z) continue;
        t = dz > 0 ? z0 - b.z : b.z - z1;
      }
      if (t < 0) t = 0;
      if (t < d) { d = t; kind = 'trail'; }
    }
  }
  return { d, kind };
}
// Where a bike driving off an edge at (x,z), height y, comes down: {u (units past the edge), g} or null (void below / hits a platform side).
// Same fall as physics settle(): constant horizontal speed, gravity from vy = 0.
function fallLanding(map, x, z, dx, dz, y, speed) {
  let hPrev = y;
  for (let u = 0.5; ; u += 0.5) {
    const h = y - CFG.gravity * (u / speed) ** 2 / 2, g = groundAt(map, x + dx * u, z + dz * u);
    if (g > hPrev + 0.05) return null; // side of a platform: fatal
    if (g >= h) return { u, g };
    if (h < map.killY) return null;
    hPrev = h;
  }
}
// Free distance from the bike's head along (dx,dz) until a wall, platform hazard or trail (own newest segment ignored).
export function freeDist(state, b, dx, dz, max) { return probe(state, b, dx, dz, max).d; }

// Is there a safe platform to jump onto beyond the hazard `f` units ahead? -> {w, g} (units past the edge, landing height) or null.
// Simulates the real arc (jumpY, then the post-arc fall) so wide gaps down onto a lower platform count too. aiAbilities fires the jump
// anywhere from 3 units before the edge to the edge, so both ends of that window must land safely, with room to carry on.
function findLanding(state, b, dx, dz, f) {
  const r = ratio(b), a = arcLanding(state, b, dx, dz, f, Math.max(0, f - 3 * r)), z = a && arcLanding(state, b, dx, dz, f, Math.max(0, f - 0.5));
  return a && z;
}
function arcLanding(state, b, dx, dz, f, t0) {
  const map = mapOf(state), r = ratio(b), J = CFG.jump, T = J.rise + J.float + J.fall, vy = 2 * J.height / J.fall;
  let hPrev = b.y;
  for (let u = 0.5; u < 200; u += 0.5) {
    const t = u / b.speed, h = t < T ? jumpY(t, J.height, 1, b.y, b.y) : b.y - vy * (t - T) - CFG.gravity * (t - T) ** 2 / 2;
    const lx = b.x + dx * (t0 + u), lz = b.z + dz * (t0 + u), g = groundAt(map, lx, lz), past = t0 + u > f + 0.5;
    if (past && g > hPrev + 0.05) return null; // would hit a platform side
    if (past && g >= h && h < hPrev) // descending onto ground beyond the edge
      return g <= b.y + JUMP_UP && terrainProbe(map, lx, lz, dx, dz, g, 8 * r).d >= 7 * r - 1e-9 ? { w: t0 + u - f, g } : null;
    if (h < map.killY) return null;
    hPrev = h;
  }
  return null;
}

// Is any trail across the straight line ahead between `from` and `to` units from the head (ignoring heights)? Used to make sure
// a jump does not come down inside another trail.
function trailBetween(state, b, from, to, dx = b.dx, dz = b.dz) {
  const m = 0.6;
  for (const o of state.bikes) {
    if (!o.alive) continue;
    const last = o.trail[o.trail.length - 1];
    for (const s of o.trail) {
      if (o === b && s === last) continue;
      const x0 = Math.min(s.x1, s.x2), x1 = Math.max(s.x1, s.x2), z0 = Math.min(s.z1, s.z2), z1 = Math.max(s.z1, s.z2);
      let t0, t1;
      if (dx !== 0) {
        if (b.z < z0 - m || b.z > z1 + m) continue;
        t0 = dx > 0 ? x0 - b.x : b.x - x1; t1 = dx > 0 ? x1 - b.x : b.x - x0;
      } else {
        if (b.x < x0 - m || b.x > x1 + m) continue;
        t0 = dz > 0 ? z0 - b.z : b.z - z1; t1 = dz > 0 ? z1 - b.z : b.z - z0;
      }
      if (t1 >= from && t0 <= to) return true;
    }
  }
  return false;
}

// Will a jump from here come down on solid ground and clear of other trails? The arc (CFG.jump rise+fall) brings the bike back to
// takeoff height about T*speed units ahead; it is below trail height for the last ~20% of it. Needs a platform there that is not
// higher than the jump can climb, and no trail in that landing stretch.
function jumpLandsSafely(state, b) {
  const map = mapOf(state);
  const L = (CFG.jump.rise + CFG.jump.float + CFG.jump.fall) * b.speed;
  if (trailBetween(state, b, L * 0.78, L + 1)) return false;
  if (map.walls && map.platforms.length === 1) return true;
  const g = groundAt(map, b.x + b.dx * L * 0.95, b.z + b.dz * L * 0.95);
  return g > -Infinity && g <= b.y + JUMP_UP;
}

// Coarse occupancy grid of all trails (for flood fill). On multi-platform maps only cells whose ground is at the bike's
// level `y` are open (other levels count as blocked; jumps are not modelled by the flood fill).
export function buildGrid(state, y = 0) {
  const map = mapOf(state), H = map.half;
  const C = CFG.ai.cell, n = Math.ceil((2 * H) / C), g = new Uint8Array(n * n), t = CFG.trailThickness;
  const ci = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + H) / C)));
  if (!(map.walls && map.platforms.length === 1)) {
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const gy = groundAt(map, -H + (x + 0.5) * C, -H + (z + 0.5) * C);
      if (Math.abs(gy - y) > 0.6) g[z * n + x] = 1;
    }
  }
  for (const o of state.bikes) {
    if (!o.alive) continue;
    for (const s of o.trail) {
      const xa = ci(Math.min(s.x1, s.x2) - t), xb = ci(Math.max(s.x1, s.x2) + t);
      const za = ci(Math.min(s.z1, s.z2) - t), zb = ci(Math.max(s.z1, s.z2) + t);
      for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) g[z * n + x] = 1;
    }
  }
  return { g, n, C, H };
}

// Open cells reachable from the cell one step ahead of (x,z) in direction (dx,dz); capped at `cap`.
export function floodArea(grid, x, z, dx, dz, cap = 400) {
  const { g, n, C, H } = grid;
  const px = x + dx * C, pz = z + dz * C;
  if (Math.abs(px) >= H || Math.abs(pz) >= H) return 0;
  const cx = Math.floor((px + H) / C), cz = Math.floor((pz + H) / C);
  if (g[cz * n + cx]) return 0;
  const seen = new Uint8Array(n * n), q = new Int16Array(n * n);
  let head = 0, tail = 0, count = 0;
  q[tail++] = cz * n + cx; seen[cz * n + cx] = 1;
  while (head < tail && count < cap) {
    const i = q[head++]; count++;
    const ix = i % n, iz = (i - ix) / n;
    if (ix > 0 && !g[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; q[tail++] = i - 1; }
    if (ix < n - 1 && !g[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; q[tail++] = i + 1; }
    if (iz > 0 && !g[i - n] && !seen[i - n]) { seen[i - n] = 1; q[tail++] = i - n; }
    if (iz < n - 1 && !g[i + n] && !seen[i + n]) { seen[i + n] = 1; q[tail++] = i + n; }
  }
  return count;
}

export function createAI(level = CFG.ai.difficulty, offset = 0) { return { level, offset }; }

// Pick a turn for bike b: -1 left, +1 right, 0 straight. Does not mutate state.
export function aiThink(state, b, ai, rng = Math.random) {
  const L = CFG.ai.levels[ai.level] || CFG.ai.levels[1];
  const gap = CFG.minTurnGap + 1;
  const [ldx, ldz] = left(b), [rdx, rdz] = right(b);
  const pf = probe(state, b, b.dx, b.dz), f = pf.d;
  const lf = freeDist(state, b, ldx, ldz), rf = freeDist(state, b, rdx, rdz);
  const look = L.look * ratio(b); // react earlier when going fast (Hyper / boost / Turbo): same time-to-impact
  const danger = f < look;
  const lOk = lf > gap, rOk = rf > gap;
  const byFree = () => (lOk && rOk ? (lf >= rf ? -1 : 1) : lOk ? -1 : rOk ? 1 : 0);

  if (danger && L.miss && rng() < L.miss) return 0; // sloppy reaction on easy

  // Platform gaps / higher platforms: roll once per approach (or when boxed in) to jump across instead of turning away.
  // The jump itself is fired by aiAbilities when the edge is close enough (ai.crossing keeps us straight until then).
  const hazard = pf.kind === 'void' || pf.kind === 'high';
  if (!danger || !hazard) { ai.crossing = false; ai.noCross = false; }
  else if (L.gap && grounded(b) && b.jumpMeter >= 1) {
    if (ai.crossing) return 0;
    if (!ai.noCross) {
      if (findLanding(state, b, b.dx, b.dz, f) && ((!lOk && !rOk) || rng() < L.gap)) { ai.crossing = true; return 0; }
      ai.noCross = true;
    }
  }

  let grid = null, aS = 0, aL = 0, aR = 0;
  if (L.flood && (danger || f < look * 2.5)) {
    grid = buildGrid(state, b.falling || b.jumpT >= 0 ? b.jumpG : b.y);
    aS = floodArea(grid, b.x, b.z, b.dx, b.dz);
    aL = lOk ? floodArea(grid, b.x, b.z, ldx, ldz) : 0;
    aR = rOk ? floodArea(grid, b.x, b.z, rdx, rdz) : 0;
  }
  // best side: by flood area (if clearly different), else by free distance
  const bestSide = () => {
    if (grid && Math.abs(aL - aR) > 0.15 * Math.max(aL, aR, 1)) return aL > aR ? -1 : 1;
    return byFree();
  };

  if (danger) {
    const side = bestSide();
    if (side === 0) return 0;
    if (grid) { // stay straight if it is clearly a bigger region and still has room
      const bestA = side < 0 ? aL : aR;
      if (f > 3 && aS > bestA * 1.5) return 0;
    }
    return side;
  }
  if (grid) { // not in danger yet but heading for a pocket: turn early if straight is much smaller
    const bestA = Math.max(aL, aR);
    if (aS < bestA * 0.5) return bestSide();
  }
  // hard: cut in front of the player
  if (L.cut && rng() < L.cut) {
    const p = state.bikes.find((v) => v.id === state.playerId);
    if (p && p.alive && p !== b) {
      const rx = b.x - p.x, rz = b.z - p.z;
      const ahead = rx * p.dx + rz * p.dz;      // how far ahead of the player
      const lat = rx * -p.dz + rz * p.dx;       // signed lateral offset from the player's lane
      if (ahead > 5 && ahead < 28 && Math.abs(lat) > 2 && Math.abs(lat) < 14) {
        // want to head toward the player's lane: along -lat * lateralAxis
        const s = -Math.sign(lat), ax = -p.dz * s, az = p.dx * s;
        for (const [side, dx, dz, ok, fr] of [[-1, ldx, ldz, lOk, lf], [1, rdx, rdz, rOk, rf]]) {
          if (ok && dx * ax + dz * az > 0 && fr > Math.abs(lat) + 6) return side;
        }
      }
    }
  }
  // occasional wander so open-field movement isn't a straight line
  if (L.wander && rng() < L.wander) {
    const side = byFree();
    if (side && (side < 0 ? lf : rf) > 15) return side;
  }
  return 0;
}

// Jump / boost decision. Jump: (1) crossing a platform gap / climbing onto a higher platform when aiThink flagged
// ai.crossing and the edge is within ~3 s*speed/15 units; (2) boxed in (no open side) with a trail (not a wall/edge) right ahead.
// Boost: long open straight, small chance per think. Easy never uses either.
export function aiAbilities(state, b, ai, rng = Math.random) {
  const L = CFG.ai.levels[ai.level] || CFG.ai.levels[1];
  const out = { jump: false, boost: false };
  if (!b.alive) return out;
  const r = ratio(b), pf = probe(state, b, b.dx, b.dz), f = pf.d;
  const ready = grounded(b) && b.jumpMeter >= 1;
  if (ai.crossing && ready && (pf.kind === 'void' || pf.kind === 'high') && f <= 3 * r) { ai.crossing = false; out.jump = true; return out; }
  if (L.jump && ready && f < CFG.ai.jumpTrigger * r && pf.kind === 'trail') {
    const [ldx, ldz] = left(b), [rdx, rdz] = right(b), gap = CFG.minTurnGap + 1;
    if (freeDist(state, b, ldx, ldz) <= gap && freeDist(state, b, rdx, rdz) <= gap && jumpLandsSafely(state, b)) out.jump = true;
  }
  if (!out.jump && L.boost && !b.boosting && grounded(b) && b.boostMeter >= 1 && f > CFG.ai.boostLook * r && rng() < L.boost) out.boost = true;
  return out;
}

// Hard AI abilities: Turbo on a long open straight (or when an opponent is right behind us); Protector when boxed in by a
// trail (not the wall) and the jump is unavailable. Uses whatever of the two the bike has equipped.
export function aiUseAbilities(state, b, ai, rng = Math.random) {
  if (!b.abilities || !b.abilities.length || !b.alive) return false;
  const pf = probe(state, b, b.dx, b.dz), f = pf.d, r = ratio(b);
  if (b.abilities.includes('turbo') && canUse(b, 'turbo') && grounded(b)) {
    let chased = false;
    for (const o of state.bikes) {
      if (o === b || !o.alive) continue;
      const rx = o.x - b.x, rz = o.z - b.z, behind = -(rx * b.dx + rz * b.dz), lat = Math.abs(rx * -b.dz + rz * b.dx);
      if (behind > 0 && behind < CFG.ai.chasedDist && lat < 3) chased = true;
    }
    if (f > CFG.ai.turboLook * r && (chased || rng() < CFG.ai.turboChance)) return useAbilityId(b, 'turbo', state);
  }
  if (b.abilities.includes('protector') && canUse(b, 'protector') && f < CFG.ai.jumpTrigger * r && b.jumpMeter < 1 && pf.kind === 'trail') {
    const [ldx, ldz] = left(b), [rdx, rdz] = right(b), gap = CFG.minTurnGap + 1;
    if (freeDist(state, b, ldx, ldz) <= gap && freeDist(state, b, rdx, rdz) <= gap) return useAbilityId(b, 'protector', state);
  }
  return false;
}

// Think for every AI bike on its staggered tick and apply the turn / jump / boost.
export function updateAIs(state, ais, tickNo, rng = Math.random) {
  for (const b of state.bikes) {
    const ai = ais.get(b.id);
    if (!ai || !b.alive) continue;
    // think more often at higher base speeds (Hyper): same distance travelled between thinks
    const every = Math.max(1, Math.round((CFG.ai.levels[ai.level] || CFG.ai.levels[1]).every / Math.max(1, b.baseSpeed / CFG.baseSpeed)));
    if ((tickNo + ai.offset) % every !== 0) continue;
    aiUseAbilities(state, b, ai, rng);
    const a = aiAbilities(state, b, ai, rng);
    if (a.jump) { startJump(b); continue; }
    if (a.boost) startBoost(b);
    const side = aiThink(state, b, ai, rng);
    if (side && canTurn(b)) turnBike(b, side);
  }
}
