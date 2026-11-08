// Custom map definition: validation (shared by the server trust boundary and the editor) + pure editor maths (no three, no DOM).
// Map = { name, walls:false, half, killY, platforms:[{x0,z0,x1,z1,y,rot?}], spawns:[{x,z,dx,dz,y}] }  (see maps.js; `id` is set by the server).
//   rx / rz = pitch / roll in radians (omitted when 0; tilted platform = ramp, surface normal at most MAX_TILT=40deg from vertical), pivot = top-face centre.
//   rot = yaw in radians about the platform centre (omitted when 0). Spawns face an axis direction (dx,dz) because bikes only drive along axes,
//   so a spawn "yaw" is a multiple of 90 degrees; spawn y is derived from the platform under it (never trusted).
import { groundAt, axes, tiltOf, MAX_TILT } from './maps.js';

export const LIM = { name: 20, platforms: 200, minSpawns: 4, maxSpawns: 8, minHalf: 20, maxHalf: 150, minSize: 3, maxSize: 200, maxY: 20 };
export const NAME_RE = /^[A-Za-z0-9 _-]{1,20}$/;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const TAU = Math.PI * 2;
export const normYaw = (a) => { a = ((a % TAU) + TAU) % TAU; return a > Math.PI ? a - TAU : a; };
export const dirOfYaw = (yaw) => { const k = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4; return [{ dx: 0, dz: 1 }, { dx: 1, dz: 0 }, { dx: 0, dz: -1 }, { dx: -1, dz: 0 }][k]; }; // inverse of yaw = atan2(dx, dz)
export const yawOfDir = (dx, dz) => Math.atan2(dx, dz);
const cornerPts = (p) => { const [ex, ey, ez] = axes(p), cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, w = (p.x1 - p.x0) / 2, d = (p.z1 - p.z0) / 2;
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([a, c]) => [cx + a * ex[0] + c * ez[0], p.y + a * ex[1] + c * ez[1], cz + a * ex[2] + c * ez[2]]); }; // [x,y,z] world
export const platformCorners = (p) => cornerPts(p).map(([x, , z]) => [x, z]);

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
    for (const k of ['rx', 'rz']) {
      if (q[k] === undefined) continue;
      if (!fin(q[k]) || Math.abs(q[k]) > MAX_TILT + 1e-9) return no(`PLATFORM ${n}: TOO STEEP (MAX ${Math.round(MAX_TILT * 180 / Math.PI)} DEG TILT)`);
      const v = Math.round(q[k] * 1e4) / 1e4; if (v) p[k] = v;
    }
    if (tiltOf(p) && axes(p)[1][1] < Math.cos(MAX_TILT) - 1e-9) return no(`PLATFORM ${n}: TOO STEEP (MAX ${Math.round(MAX_TILT * 180 / Math.PI)} DEG TILT)`);
    if (platformCorners(p).some(([x, z]) => Math.abs(x) > half + 0.01 || Math.abs(z) > half + 0.01)) return no(`PLATFORM ${n}: OUTSIDE THE ARENA SIZE`);
    platforms.push(p);
  }
  const minY = Math.min(...platforms.flatMap((p) => cornerPts(p).map((c) => c[1])));
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

/** Ray (o, d: [x,y,z]) against a box {cx,cy,cz (centre), hx,hy,hz, rot, rx?, rz?} (platform frame, see maps.js axes): distance t >= 0 or null. */
export function rayBox(o, d, b) {
  const A = axes(b), dot = (a, v) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2], od = [o[0] - b.cx, o[1] - b.cy, o[2] - b.cz];
  let t0 = 0, t1 = Infinity;
  for (const [a, h] of [[A[0], b.hx], [A[1], b.hy], [A[2], b.hz]]) {
    const p = dot(a, od), v = dot(a, d);
    if (Math.abs(v) < 1e-12) { if (Math.abs(p) > h) return null; continue; }
    let s = (-h - p) / v, e = (h - p) / v; if (s > e) [s, e] = [e, s];
    t0 = Math.max(t0, s); t1 = Math.min(t1, e); if (t0 > t1) return null;
  }
  return t0;
}

/** Intersection of a ray with the plane y = h -> [x, z] or null (parallel / behind). */
export function groundHit(o, d, h) { if (Math.abs(d[1]) < 1e-9) return null; const t = (h - o[1]) / d[1]; return t > 0 ? [o[0] + d[0] * t, o[2] + d[2] * t] : null; }

const SLAB = 8; // visual slab depth (render.js) - also the pick volume
export const platformBox = (p) => { const n = axes(p)[1]; return { cx: (p.x0 + p.x1) / 2 - n[0] * SLAB / 2, cy: p.y - n[1] * SLAB / 2, cz: (p.z0 + p.z1) / 2 - n[2] * SLAB / 2, hx: (p.x1 - p.x0) / 2, hy: SLAB / 2, hz: (p.z1 - p.z0) / 2, rot: p.rot || 0, rx: p.rx || 0, rz: p.rz || 0 }; };
export const spawnBox = (s) => ({ cx: s.x, cy: s.y + 1, cz: s.z, hx: 0.8, hy: 1.1, hz: 1.6, rot: yawOfDir(s.dx, s.dz) });

/** Nearest object under the ray: { kind:'platform'|'spawn', index } or null. Spawns win ties (they sit on top of platforms). */
export function pickObject(map, o, d) {
  let best = null;
  const tryIt = (kind, index, box, bias) => { const t = rayBox(o, d, box); if (t !== null && (!best || t - bias < best.t)) best = { kind, index, t: t - bias }; };
  map.platforms.forEach((p, i) => tryIt('platform', i, platformBox(p), 0));
  map.spawns.forEach((s, i) => tryIt('spawn', i, spawnBox(s), 0.5));
  return best && { kind: best.kind, index: best.index };
}
