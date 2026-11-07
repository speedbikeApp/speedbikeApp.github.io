// Map descriptions (pure data + tiny queries; no three, no DOM).
// A map = flat axis-aligned platforms {x0,z0,x1,z1,y} (y = top height; the slab is solid below it), optional arena walls,
// spawn points and a kill height. Physics, AI, render and minimap all read the same description.
//   walls   : true = the square |x|,|z| < half is fenced by fatal walls (any height). false = open edges (fall off = crash).
//   half    : half-size of the square that bounds the whole map (grid/minimap/camera scale), centred on the origin.
//   killY   : a falling bike below this height crashes (no platform to catch it).
//   spawns  : optional fixed spawn list [{x,z,dx,dz,y}] ordered S,W,N,E (null = computed from CFG.arena.half).
import { CFG } from './config.js';

let arenaCache = null;
// Default map: ONE 100x100 platform with walls. Reads CFG.arena.half live (tests/tuning may change it).
const arena = {
  id: 'arena', name: 'ARENA', walls: true, killY: -14, spawns: null,
  get half() { return CFG.arena.half; },
  get platforms() {
    const h = CFG.arena.half;
    if (!arenaCache || arenaCache[0].x1 !== h) arenaCache = [{ x0: -h, z0: -h, x1: h, z1: h, y: 0 }];
    return arenaCache;
  },
};

// TIERS (3D mode). No walls: every open edge is a drop.
//   MAIN  80x80 at y=0 (x,z in -40..40) - all four bikes spawn here, 28 units from the centre.
//   EAST / WEST  40x50 raised pads at y=2.5, a 5-unit gap away from MAIN. Reachable only by jumping (jump peak 3.5):
//        at base speed, take off anywhere in the last ~11 units before MAIN's edge (window ~0.75 s). Falling into the gap = crash.
//   NORTH / SOUTH  60x30 low decks at y=-2 glued to MAIN's z-edges: driving off that edge drops 2 units and survives;
//        getting back up needs a jump (the deck is a dead-end pocket otherwise).
const R = 28;
const tiers = {
  id: 'tiers', name: 'TIERS', walls: false, half: 90, killY: -14,
  platforms: [
    { x0: -40, z0: -40, x1: 40, z1: 40, y: 0 },
    { x0: 45, z0: -25, x1: 85, z1: 25, y: 2.5 },
    { x0: -85, z0: -25, x1: -45, z1: 25, y: 2.5 },
    { x0: -30, z0: -70, x1: 30, z1: -40, y: -2 },
    { x0: -30, z0: 40, x1: 30, z1: 70, y: -2 },
  ],
  spawns: [
    { x: 0, z: R, dx: 0, dz: -1, y: 0 }, { x: -R, z: 0, dx: 1, dz: 0, y: 0 },
    { x: 0, z: -R, dx: 0, dz: 1, y: 0 }, { x: R, z: 0, dx: -1, dz: 0, y: 0 },
  ],
};

export const MAPS = { arena, tiers };
export const mapOf = (state) => (state && state.map) || arena;

const E = 1e-6;
// Highest platform top containing (x,z), or -Infinity over the void. Bounds inclusive (a bike on the very edge is supported).
export function groundAt(map, x, z) {
  const P = map.platforms;
  let g = -Infinity;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (p.y > g && x >= p.x0 - E && x <= p.x1 + E && z >= p.z0 - E && z <= p.z1 + E) g = p.y;
  }
  return g;
}

// March from (x,z) along (dx,dz) at standing height y until the surface stops being "flat ground at y"
// (|ground - y| > tol). Returns {d, kind}: kind 'void' (nothing below), 'drop' (lower platform), 'high' (higher platform
// side), or 'none' when clear for `max` units. Step 0.5 => gaps/edges are located to within half a unit.
export function terrainProbe(map, x, z, dx, dz, y, max, tol = 0.3, step = 0.5) {
  for (let d = step; d <= max + 1e-9; d += step) {
    const g = groundAt(map, x + dx * d, z + dz * d);
    if (g > y + tol) return { d: d - step, kind: 'high', g };
    if (g < y - tol) return { d: d - step, kind: g === -Infinity ? 'void' : 'drop', g };
  }
  return { d: max, kind: 'none', g: y };
}

// Total platform area (for sampling respawn points).
export function platformArea(p) { return (p.x1 - p.x0) * (p.z1 - p.z0); }
