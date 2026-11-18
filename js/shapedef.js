// Custom bike-part shapes (BIKE EDITOR). Pure data + validation (no three, no DOM): the client (parts.js, bikemodels.js, admin-bikeedit.js) and the server
// (server/admin-items.js) run the SAME validator. A custom body / tire / rim item = base built-in model (or 'none') + `shapes`:
//   {type, p:[x,y,z], r:[rx,ry,rz] degrees, s:[sx,sy,sz] size in bike units, role, mirror}   (at most MAX_SHAPES)
// Bodies live in bike space (x +-0.8, y 0..2, z +-1.6, +z forward). Tire / rim shapes are in WHEEL space: origin = the wheel centre, x = axle, y / z within radius ~0.7;
// they are added to each wheel (and spin with it). Out-of-range numbers are CLAMPED; wrong types / unknown type or role / too many shapes are rejected.
export const SHAPE_TYPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'wedge', 'tube'];
export const SHAPE_ROLES = ['shell', 'plate', 'canopy', 'dark', 'glow', 'bright', 'hot', 'lamp', 'tire', 'tireGlow'];
export const MAX_SHAPES = 60;
export const SHAPE_LIM = { // position half range per axis, size [min, max], rotation range (degrees)
  body: { p: [[-1.6, 1.6], [-0.3, 2.6], [-2.6, 2.6]], s: [0.01, 3] },
  wheel: { p: [[-0.7, 0.7], [-0.9, 0.9], [-0.9, 0.9]], s: [0.01, 1.8] },
  r: [-360, 360],
};
const lim = (cat) => (cat === 'body' ? SHAPE_LIM.body : SHAPE_LIM.wheel);
const q = (v, [a, b]) => Math.round(Math.min(b, Math.max(a, v)) * 1000) / 1000;
const vec = (v, ranges) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? v.map((n, i) => q(n, ranges[i])) : null;

/** One shape -> clean shape (numbers clamped, extra fields dropped) or null when malformed. cat = 'body' | 'tire' | 'rim'. */
export function cleanShape(cat, s) {
  if (!s || typeof s !== 'object' || !SHAPE_TYPES.includes(s.type) || !SHAPE_ROLES.includes(s.role)) return null;
  if (s.mirror !== undefined && typeof s.mirror !== 'boolean') return null;
  const L = lim(cat), p = vec(s.p, L.p), r = vec(s.r, [SHAPE_LIM.r, SHAPE_LIM.r, SHAPE_LIM.r]), sz = vec(s.s, [L.s, L.s, L.s]);
  return p && r && sz ? { type: s.type, p, r, s: sz, role: s.role, mirror: s.mirror === true } : null;
}
/** undefined / null = no shapes. -> {ok:true, shapes} (clean copy) | {ok:false, why}. */
export function validateShapes(cat, list) {
  if (list === undefined || list === null) return { ok: true, shapes: [] };
  if (cat !== 'body' && cat !== 'tire' && cat !== 'rim') return { ok: false, why: 'this category has no shapes' };
  if (!Array.isArray(list)) return { ok: false, why: 'shapes must be a list' };
  if (list.length > MAX_SHAPES) return { ok: false, why: `at most ${MAX_SHAPES} shapes` };
  const out = [];
  for (let i = 0; i < list.length; i++) { const s = cleanShape(cat, list[i]); if (!s) return { ok: false, why: `shape ${i + 1} is invalid` }; out.push(s); }
  return { ok: true, shapes: out };
}
/** Short stable cache key of a (clean) shape list. */
export function shapesKey(shapes) {
  let h = 5381; const t = JSON.stringify(shapes);
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36) + '_' + shapes.length;
}
