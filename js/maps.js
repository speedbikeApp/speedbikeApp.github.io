// Map descriptions (pure data + tiny queries; no three, no DOM).
// A map = flat axis-aligned platforms {x0,z0,x1,z1,y} (y = top height; the slab is solid below it), optional arena walls,
// spawn points and a kill height. Physics, AI, render and minimap all read the same description.
//   walls   : legacy flag (physics still supports fatal walls) - every shipped map is false: open edges, fall off = crash.
//   half    : half-size of the square that bounds the whole map (grid/minimap/camera scale), centred on the origin.
//   killY   : a falling bike below this height crashes (no platform to catch it).
//   platform.rot : optional yaw in radians about the platform centre (absent = 0; Three's rotation.y sense). Support / fall / side-crash all go
//                  through groundAt(), which maps the point into the platform's local frame.
//   platform.rx / rz : optional pitch / roll in radians (Euler order YXZ with rot; pivot = top-face centre). Tilted = ramp: groundAt returns the
//                  plane height; |tilt| <= MAX_TILT (mapdef.js validates). Absent = 0.
//   spawns  : optional fixed spawn list [{x,z,dx,dz,y}] ordered S,W,N,E (null = computed from CFG.arena.half).
import { CFG } from './config.js';

let arenaCache = null;
// Default map: ONE 102x102 platform, NO walls (driving off the edge = fall and crash). Reads CFG.arena.half live (tests/tuning may change it).
const arena = {
  id: 'arena', name: 'ARENA', walls: false, killY: -14, spawns: null,
  get half() { return CFG.arena.half; },
  get platforms() {
    const h = CFG.arena.half;
    if (!arenaCache || arenaCache[0].x1 !== h) arenaCache = [{ x0: -h, z0: -h, x1: h, z1: h, y: 0 }];
    return arenaCache;
  },
};

// TIERS (3D mode). No walls: every open edge is a drop. All sizes are multiples of CFG.tile (3).
//   MAIN  78x78 at y=0 (x,z in -39..39) - all four bikes spawn here, 28 units from the centre.
//   EAST / WEST  48x48 raised pads at y=2 (= trail height), a 3-unit (one tile) gap away from MAIN. Reachable only by jumping:
//        at base speed take off anywhere in the last ~7.6 units before MAIN's edge (window ~0.5 s). Falling into the gap = crash.
//   NORTH / SOUTH  60x30 low decks at y=-2 glued to MAIN's z-edges: driving off that edge drops 2 units and survives;
//        getting back up needs a jump (the deck is a dead-end pocket otherwise).
const R = 28;
const tiers = {
  id: 'tiers', name: 'TIERS', walls: false, half: 90, killY: -14,
  platforms: [
    { x0: -39, z0: -39, x1: 39, z1: 39, y: 0 },
    { x0: 42, z0: -24, x1: 90, z1: 24, y: 2 },
    { x0: -90, z0: -24, x1: -42, z1: 24, y: 2 },
    { x0: -30, z0: -69, x1: 30, z1: -39, y: -2 },
    { x0: -30, z0: 39, x1: 30, z1: 69, y: -2 },
  ],
  spawns: [
    { x: 0, z: R, dx: 0, dz: -1, y: 0 }, { x: -R, z: 0, dx: 1, dz: 0, y: 0 },
    { x: 0, z: -R, dx: 0, dz: 1, y: 0 }, { x: R, z: 0, dx: -1, dz: 0, y: 0 },
  ],
};

// STAIRS: a square ring of four 24-wide strips around a void, each 0.75 lower than the last (clockwise travel N -> E -> S -> W).
// Driving off a strip's end drops onto the next strip's corner. The last (W, y=0) ends against the side of the first (N, y=2.25):
// jump to climb back up (take off 2.6..10 units before the step at base speed, ~0.5 s window, like TIERS). Falling inward/outward = crash.
const stairs = {
  id: 'stairs', name: 'STAIRS', walls: false, half: 60, killY: -14,
  platforms: [
    { x0: -60, z0: -60, x1: 36, z1: -36, y: 2.25 }, // N, travel +x
    { x0: 36, z0: -60, x1: 60, z1: 36, y: 1.5 },    // E, travel +z
    { x0: -36, z0: 36, x1: 60, z1: 60, y: 0.75 },   // S, travel -x
    { x0: -60, z0: -36, x1: -36, z1: 60, y: 0 },    // W, travel -z (into N's side)
  ],
  spawns: [
    { x: 12, z: 48, dx: -1, dz: 0, y: 0.75 }, { x: -48, z: 12, dx: 0, dz: -1, y: 0 },
    { x: -12, z: -48, dx: 1, dz: 0, y: 2.25 }, { x: 48, z: -12, dx: 0, dz: 1, y: 1.5 },
  ],
};

// BIG HOLE: one flat 126x126 square with a 78x78 hole in the middle (a 24-wide ring). Spawns on the ring, driving along it.
const crater = {
  id: 'crater', name: 'BIG HOLE', walls: false, half: 63, killY: -14,
  platforms: [
    { x0: -63, z0: -63, x1: 63, z1: -39, y: 0 },
    { x0: -63, z0: 39, x1: 63, z1: 63, y: 0 },
    { x0: -63, z0: -39, x1: -39, z1: 39, y: 0 },
    { x0: 39, z0: -39, x1: 63, z1: 39, y: 0 },
  ],
  spawns: [
    { x: 12, z: 51, dx: -1, dz: 0, y: 0 }, { x: -51, z: 12, dx: 0, dz: -1, y: 0 },
    { x: -12, z: -51, dx: 1, dz: 0, y: 0 }, { x: 51, z: -12, dx: 0, dz: 1, y: 0 },
  ],
};

export const MAPS = { arena, tiers, stairs, crater };
export const mapOf = (state) => (state && state.map) || arena;

const E = 1e-6;
// Platform-local <-> world for a yawed platform (rotation about its centre; same sense as Three's rotation.y).
export function toLocal(p, x, z) {
  if (!p.rot) return [x, z];
  const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, dx = x - cx, dz = z - cz, c = Math.cos(p.rot), s = Math.sin(p.rot);
  return [cx + dx * c - dz * s, cz + dx * s + dz * c];
}
export function toWorld(p, x, z) {
  if (!p.rot) return [x, z];
  const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, dx = x - cx, dz = z - cz, c = Math.cos(p.rot), s = Math.sin(p.rot);
  return [cx + dx * c + dz * s, cz - dx * s + dz * c];
}
export const MAX_TILT = 40 * Math.PI / 180; // steepest ramp (angle of the surface normal from vertical); validateMap enforces it
export const tiltOf = (p) => !!(p.rx || p.rz);
// Platform frame (Three Euler 'YXZ' = Ry(rot) Rx(rx) Rz(rz)): world directions of local x, y (normal), z. Pivot = top-face centre (cx, y, cz).
export function axes(p) {
  const ca = Math.cos(p.rot || 0), sa = Math.sin(p.rot || 0), cb = Math.cos(p.rx || 0), sb = Math.sin(p.rx || 0), cc = Math.cos(p.rz || 0), sc = Math.sin(p.rz || 0);
  return [[ca * cc + sa * sb * sc, cb * sc, -sa * cc + ca * sb * sc], [-ca * sc + sa * sb * cc, cb * cc, sa * sc + ca * sb * cc], [sa * cb, -sb, ca * cb]];
}
// Height of platform p's top surface at (x,z), or -Infinity outside its footprint. Tilted platforms are planes through the pivot.
function topAt(p, x, z) {
  if (!tiltOf(p)) {
    const [lx, lz] = p.rot ? toLocal(p, x, z) : [x, z];
    return lx >= p.x0 - E && lx <= p.x1 + E && lz >= p.z0 - E && lz <= p.z1 + E ? p.y : -Infinity;
  }
  const [ex, ey, ez] = axes(p), dx = x - (p.x0 + p.x1) / 2, dz = z - (p.z0 + p.z1) / 2, dy = -(ey[0] * dx + ey[2] * dz) / ey[1];
  const lx = ex[0] * dx + ex[1] * dy + ex[2] * dz, lz = ez[0] * dx + ez[1] * dy + ez[2] * dz;
  return Math.abs(lx) <= (p.x1 - p.x0) / 2 + E && Math.abs(lz) <= (p.z1 - p.z0) / 2 + E ? p.y + dy : -Infinity;
}
// Highest platform top at (x,z), or -Infinity over the void. Bounds inclusive (a bike on the very edge is supported).
export function groundAt(map, x, z) {
  const P = map.platforms;
  let g = -Infinity;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (p.y <= g && !p.rx && !p.rz) continue;
    const h = topAt(p, x, z);
    if (h > g) g = h;
  }
  return g;
}

// March from (x,z) along (dx,dz) at standing height y. Returns {d, kind, g}: kind 'void' (nothing below), 'drop' (lower platform,
// g = its height), 'high' (side of a higher platform), or 'none' when clear for `max` units. Ramps are followed: the ground may change
// by one sample of the steepest tilt between samples. Step 0.5 => edges are located to within half a unit.
export function terrainProbe(map, x, z, dx, dz, y, max, tol = 0.3, step = 0.5) {
  const ramp = Math.max(tol, step * Math.tan(MAX_TILT) + 0.05);
  for (let d = step; d <= max + 1e-9; d += step) {
    const g = groundAt(map, x + dx * d, z + dz * d);
    if (g > y + ramp) return { d: d - step, kind: 'high', g };
    if (g < y - ramp) return { d: d - step, kind: g === -Infinity ? 'void' : 'drop', g };
    y = g;
  }
  return { d: max, kind: 'none', g: y };
}

// Total platform area (for sampling respawn points).
export function platformArea(p) { return (p.x1 - p.x0) * (p.z1 - p.z0); }
