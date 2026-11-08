// Custom map definition: validation (shared by the server trust boundary and the editor) + pure editor maths (no three, no DOM).
// Map = { name, walls:false, half, killY, platforms:[{x0,z0,x1,z1,y,rot?}], spawns:[{x,z,dx,dz,y}] }  (see maps.js; `id` is set by the server).
//   rot = yaw in radians about the platform centre (omitted when 0). Spawns face an axis direction (dx,dz) because bikes only drive along axes,
//   so a spawn "yaw" is a multiple of 90 degrees; spawn y is derived from the platform under it (never trusted).
import { groundAt, toLocal } from './maps.js';

export const LIM = { name: 20, platforms: 200, minSpawns: 4, maxSpawns: 8, minHalf: 20, maxHalf: 150, minSize: 3, maxSize: 200, maxY: 20 };
export const NAME_RE = /^[A-Za-z0-9 _-]{1,20}$/;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const TAU = Math.PI * 2;
export const normYaw = (a) => { a = ((a % TAU) + TAU) % TAU; return a > Math.PI ? a - TAU : a; };
export const dirOfYaw = (yaw) => { const k = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4; return [{ dx: 0, dz: 1 }, { dx: 1, dz: 0 }, { dx: 0, dz: -1 }, { dx: -1, dz: 0 }][k]; }; // inverse of yaw = atan2(dx, dz)
export const yawOfDir = (dx, dz) => Math.atan2(dx, dz);
export const platformCorners = (p) => [[p.x0, p.z0], [p.x1, p.z0], [p.x1, p.z1], [p.x0, p.z1]].map(([x, z]) => { const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, c = Math.cos(p.rot || 0), s = Math.sin(p.rot || 0); return [cx + (x - cx) * c + (z - cz) * s, cz - (x - cx) * s + (z - cz) * c]; });

/** -> { ok:true, map } (normalised copy: only known fields, rounded, spawn y derived) | { ok:false, why }. */
export function validateMap(raw) {
  const no = (why) => ({ ok: false, why });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('MAP MISSING');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!NAME_RE.test(name)) return no('NAME: 1-20 LETTERS, NUMBERS, SPACE _ -');
  const half = fin(raw.half) ? r2(raw.half) : NaN, killY = fin(raw.killY) ? r2(raw.killY) : NaN;
  if (!(half >= LIM.minHalf && half <= LIM.maxHalf)) return no(`ARENA SIZE ${LIM.minHalf}-${LIM.maxHalf}`);
  if (!Array.isArray(raw.platforms) || raw.platforms.length < 1 || raw.platforms.length > LIM.platforms) return no(`1-${LIM.platforms} PLATFORMS NEEDED`);
  if (!Array.isArray(raw.spawns) || raw.spawns.length < LIM.minSpawns || raw.spawns.length > LIM.maxSpawns) return no(`${LIM.minSpawns}-${LIM.maxSpawns} SPAWN POINTS NEEDED`);
  const platforms = [];
  for (const [i, q] of raw.platforms.entries()) {
    const n = i + 1;
    if (!q || typeof q !== 'object') return no(`PLATFORM ${n}: INVALID`);
    if (![q.x0, q.z0, q.x1, q.z1, q.y].every(fin)) return no(`PLATFORM ${n}: BAD NUMBER`);
    const p = { x0: r2(q.x0), z0: r2(q.z0), x1: r2(q.x1), z1: r2(q.z1), y: r2(q.y) };
    if (q.rot !== undefined && !(fin(q.rot) && Math.abs(q.rot) <= 100)) return no(`PLATFORM ${n}: BAD ROTATION`);
    if (p.x1 - p.x0 < LIM.minSize || p.z1 - p.z0 < LIM.minSize) return no(`PLATFORM ${n}: TOO SMALL (MIN ${LIM.minSize})`);
    if (p.x1 - p.x0 > LIM.maxSize || p.z1 - p.z0 > LIM.maxSize) return no(`PLATFORM ${n}: TOO BIG (MAX ${LIM.maxSize})`);
    if (Math.abs(p.y) > LIM.maxY) return no(`PLATFORM ${n}: HEIGHT -${LIM.maxY}..${LIM.maxY}`);
    const rot = Math.round(normYaw(q.rot || 0) * 1e4) / 1e4;
    if (rot) p.rot = rot;
    if (platformCorners(p).some(([x, z]) => Math.abs(x) > half + 0.01 || Math.abs(z) > half + 0.01)) return no(`PLATFORM ${n}: OUTSIDE THE ARENA SIZE`);
    platforms.push(p);
  }
  const minY = Math.min(...platforms.map((p) => p.y));
  if (!(killY >= -60 && killY <= minY - 2)) return no('KILL HEIGHT MUST BE BELOW ALL PLATFORMS (-60..)');
  const map = { name, walls: false, half, killY, platforms, spawns: [] };
  for (const [i, q] of raw.spawns.entries()) {
    const n = i + 1;
    if (!q || typeof q !== 'object' || !fin(q.x) || !fin(q.z)) return no(`SPAWN ${n}: BAD NUMBER`);
    const dx = q.dx, dz = q.dz;
    if (!((dx === 0 && (dz === 1 || dz === -1)) || (dz === 0 && (dx === 1 || dx === -1)))) return no(`SPAWN ${n}: BAD DIRECTION`);
    const x = r2(q.x), z = r2(q.z);
    if (Math.abs(x) > half || Math.abs(z) > half) return no(`SPAWN ${n}: OUTSIDE THE ARENA SIZE`);
    const y = groundAt(map, x, z);
    if (y === -Infinity) return no(`SPAWN ${n}: NOT ON A PLATFORM`);
    if (map.spawns.some((o) => Math.hypot(o.x - x, o.z - z) < 3)) return no(`SPAWN ${n}: TOO CLOSE TO ANOTHER SPAWN`);
    map.spawns.push({ x, z, dx, dz, y });
  }
  return { ok: true, map };
}

/** Does the map have real height differences (>= 1.5 between platform tops)? Then it may join the 3D mode pool. */
export const isTiered = (map) => { const ys = map.platforms.map((p) => p.y); return Math.max(...ys) - Math.min(...ys) >= 1.5; };

/** Drag corner -> corner on the ground plane to a platform (snapped to `snap`); null if smaller than the minimum size. */
export function rectPlatform(ax, az, bx, bz, y, snap = 1) {
  const s = (v) => (snap > 0 ? Math.round(v / snap) * snap + 0 : v);
  const p = { x0: s(Math.min(ax, bx)), z0: s(Math.min(az, bz)), x1: s(Math.max(ax, bx)), z1: s(Math.max(az, bz)), y };
  return p.x1 - p.x0 < LIM.minSize || p.z1 - p.z0 < LIM.minSize ? null : p;
}

/** Ray (o, d: [x,y,z]) against a y-parallel yawed box {cx,cy,cz,hx,hy,hz,rot}: distance t >= 0 or null. */
export function rayBox(o, d, b) {
  const [ox, oz] = toLocal({ x0: b.cx, x1: b.cx, z0: b.cz, z1: b.cz, rot: b.rot }, o[0], o[2]);
  const [lx, lz] = toLocal({ x0: 0, x1: 0, z0: 0, z1: 0, rot: b.rot }, d[0], d[2]);
  let t0 = 0, t1 = Infinity;
  for (const [p, v, c, h] of [[ox, lx, b.cx, b.hx], [o[1], d[1], b.cy, b.hy], [oz, lz, b.cz, b.hz]]) {
    if (Math.abs(v) < 1e-12) { if (Math.abs(p - c) > h) return null; continue; }
    let a = (c - h - p) / v, e = (c + h - p) / v; if (a > e) [a, e] = [e, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, e); if (t0 > t1) return null;
  }
  return t0;
}

/** Intersection of a ray with the plane y = h -> [x, z] or null (parallel / behind). */
export function groundHit(o, d, h) { if (Math.abs(d[1]) < 1e-9) return null; const t = (h - o[1]) / d[1]; return t > 0 ? [o[0] + d[0] * t, o[2] + d[2] * t] : null; }

const SLAB = 8; // visual slab depth (render.js) - also the pick volume
export const platformBox = (p) => ({ cx: (p.x0 + p.x1) / 2, cy: p.y - SLAB / 2, cz: (p.z0 + p.z1) / 2, hx: (p.x1 - p.x0) / 2, hy: SLAB / 2, hz: (p.z1 - p.z0) / 2, rot: p.rot || 0 });
export const spawnBox = (s) => ({ cx: s.x, cy: s.y + 1, cz: s.z, hx: 0.8, hy: 1.1, hz: 1.6, rot: yawOfDir(s.dx, s.dz) });

/** Nearest object under the ray: { kind:'platform'|'spawn', index } or null. Spawns win ties (they sit on top of platforms). */
export function pickObject(map, o, d) {
  let best = null;
  const tryIt = (kind, index, box, bias) => { const t = rayBox(o, d, box); if (t !== null && (!best || t - bias < best.t)) best = { kind, index, t: t - bias }; };
  map.platforms.forEach((p, i) => tryIt('platform', i, platformBox(p), 0));
  map.spawns.forEach((s, i) => tryIt('spawn', i, spawnBox(s), 0.5));
  return best && { kind: best.kind, index: best.index };
}
