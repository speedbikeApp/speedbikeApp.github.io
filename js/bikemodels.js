import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CFG } from './config.js';
import { getPart } from './parts.js';
import { shapesKey } from './shapedef.js';

// ---- Bike models. Local +z is forward, +y up; wheels sit at z = +-0.85 (radius WHEEL_R), rider top ~1.95, nose ~1.5, tail ~-1.2 ----
// BUILDER TABLES (the hooks for a shape editor): BODIES[id](g, M) -> pose|undefined, TIRES[id](w, M) -> half width, RIMS[id](w, M, x, hw, sx).
// A builder adds primitive meshes to a group using the material ROLES in M:
//   shell, plate, canopy, helmet, dark   baked-shaded dark panels (vertex-colour light gradient, top lighter, bottom darker)
//   glow, bright, tireGlow, hot, visor   unlit accent colours (>1.0 so bloom picks them up); hot = near-white thruster / tail lamps
//   tire                                 plain dark rubber;  lamp = white headlight
// After a part is built, every mesh of it is merged into ONE mesh per material role and the result is cached by key (unit()), so
// all bikes with the same body / tire / rim share geometry and a bike costs ~20 draw calls. Per-bike cost = ~12 small materials.
export const WHEEL_R = 0.5, TAU = Math.PI * 2, PI2 = Math.PI / 2;
const V3 = THREE.Vector3, V2 = THREE.Vector2;
export const glowColor = (c, k = 1.5) => new THREE.Color(c).multiplyScalar(k); // >1 pushes past the bloom threshold

// ---------------- merge / cache ----------------
const SHADED = new Set(['shell', 'plate', 'canopy', 'helmet', 'dark', 'suit']);
const LIGHT = new V3(0.2, 1, 0.45).normalize();
function shade(g) { // fake lighting baked into vertex colours: lit from above/front, dark underneath (materials are unlit, so it is free)
  const n = g.attributes.normal, p = g.attributes.position, c = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const d = n.getX(i) * LIGHT.x + n.getY(i) * LIGHT.y + n.getZ(i) * LIGHT.z;
    const s = Math.min(1, 0.24 + 0.72 * Math.max(0, d) + 0.1 * Math.min(1, Math.max(0, (p.getY(i) - 0.4) / 1.5)) + 0.1 * (1 - Math.abs(n.getY(i))));
    c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = s;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g;
}
export const unitCache = new Map(); // key -> merged geometries per material role
function unit(key, M, build) { // build(tmpGroup, M) once per key; returns {meshes, meta} with this bike's materials
  let u = unitCache.get(key);
  if (!u) {
    const tmp = new THREE.Group(), meta = build(tmp, M), by = {}; tmp.updateMatrixWorld(true);
    tmp.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone(); g.deleteAttribute('uv'); g.clearGroups(); g.applyMatrix4(o.matrixWorld);
      (by[o.material.userData.slot] ||= []).push(g);
    });
    u = { meta, parts: Object.entries(by).map(([slot, gs]) => [slot, mergeGeometries(SHADED.has(slot) ? gs.map(shade) : gs)]) };
    unitCache.set(key, u);
  }
  return { meshes: u.parts.map(([slot, g]) => new THREE.Mesh(g, M[slot])), meta: u.meta };
}
export const bikeTriangles = (group) => { let t = 0; group.traverse((o) => { if (o.isMesh) { const g = o.geometry; t += (g.index ? g.index.count : g.attributes.position.count) / 3; } }); return t; };

// ---------------- builder helpers (all take the group first, then a material from M) ----------------
const unitBox = new THREE.BoxGeometry(1, 1, 1), sph = new THREE.SphereGeometry(1, 10, 7), sphLo = new THREE.SphereGeometry(1, 6, 4), sphTiny = new THREE.SphereGeometry(1, 5, 3), cylU = new THREE.CylinderGeometry(1, 1, 1, 6);
const put = (g, geom, mat, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.set(rx, ry, rz); g.add(m); return m; };
export const box = (g, mat, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) => put(g, unitBox, mat, x, y, z, sx, sy, sz, rx, ry, rz);
const tiny = (g, mat, r, x, y, z) => put(g, sphTiny, mat, x, y, z, r, r, r);
const ball = (g, mat, r, x, y, z, sx = 1, sy = 1, sz = 1, geom = sphLo) => put(g, geom, mat, x, y, z, r * sx, r * sy, r * sz);
const orient = (m, A, B) => { m.position.copy(A).add(B).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new V3(0, 1, 0), B.clone().sub(A).normalize()); return m; };
function strut(g, mat, a, b, r = 0.035) { const A = new V3(...a), B = new V3(...b), m = orient(new THREE.Mesh(cylU, mat), A, B); m.scale.set(r, A.distanceTo(B), r); g.add(m); }
function limb(g, mat, a, b, r, seg = 5) { // capsule between two points
  const A = new V3(...a), B = new V3(...b); g.add(orient(new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, A.distanceTo(B) - 2 * r), 1, seg), mat), A, B));
}
const tube = (g, mat, pts, r, n = 10, rad = 3) => g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new V3(x, y, z))), n, r, rad), mat));
const cyl = (g, mat, r0, r1, len, x, y, z, seg = 10) => put(g, new THREE.CylinderGeometry(r0, r1, len, seg).rotateX(PI2), mat, x, y, z); // axis = z, r0 at +z
const smoothPts = (pts, n) => new THREE.SplineCurve(pts.map(([r, z]) => new V2(r, z))).getSpacedPoints(n).map((p) => [Math.max(0.012, p.x), p.y]);
const rAt = (prof, z) => { for (let i = 1; i < prof.length; i++) if (z <= prof[i][1]) { const [r0, z0] = prof[i - 1], [r1, z1] = prof[i]; return r0 + (r1 - r0) * ((z - z0) / (z1 - z0 || 1)); } return 0.012; };
// hull of revolution around z: pts = [radius, z] tail -> nose (spline-smoothed), squashed to sx / sy. Returns the profile for line().
function hull(g, mat, pts, sx, sy, cy, { seg = 14, rz = 0, n = 12, cz = 0, cx = 0 } = {}) {
  const prof = smoothPts(pts, n);
  put(g, new THREE.LatheGeometry(prof.map(([r, z]) => new V2(r, z)), seg).rotateX(PI2).rotateZ(rz).scale(sx, sy, 1), mat, cx, cy, cz);
  return { prof, sx, sy, cy };
}
// glowing accent tube hugging the hull surface at cross-section angle ang (both sides)
function line(g, mat, H, ang, z0, z1, r = 0.016, off = 1.03, n = 10) {
  for (const s of [-1, 1]) {
    const pts = []; for (let i = 0; i <= n; i++) { const z = z0 + (z1 - z0) * i / n, rr = rAt(H.prof, z) * off; pts.push([s * Math.cos(ang) * rr * H.sx, H.cy + Math.sin(ang) * rr * H.sy, z]); }
    tube(g, mat, pts, r, n, 3);
  }
}
const chaikin = (pts, it) => { for (; it > 0; it--) { const o = []; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); } pts = o; } return pts; };
// bevelled panel: outline [[z, y]...] (side view, corners rounded), thickness d along x, centred on x
function slab(g, mat, pts, d, x = 0, bev = 0.02, it = 1, y = 0, z = 0) {
  const sh = new THREE.Shape(chaikin(pts, it).map(([zz, yy]) => new V2(zz, yy)));
  put(g, new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: bev > 0, bevelSize: bev, bevelThickness: bev, bevelSegments: 1, curveSegments: 1 }).translate(0, 0, -d / 2).rotateY(-PI2), mat, x, y, z);
}
// forks + swingarm tying the hull to both axles, axle caps, headlight with bezel
function chassis(g, M, { top = 0.2, lz = 1.36, ly = 0.92, mat = M.dark, fy = 1.0 } = {}) {
  for (const s of [-1, 1]) {
    strut(g, mat, [s * 0.34, 0.5, 0.85], [s * top, fy, 0.62], 0.034);
    strut(g, mat, [s * 0.34, 0.5, -0.85], [s * top, fy - 0.2, -0.3], 0.034);
    for (const z of [-0.85, 0.85]) tiny(g, M.bright, 0.06, s * 0.34, 0.5, z);
  }
  cyl(g, M.dark, 0.09, 0.12, 0.08, 0, ly, lz - 0.04, 10); ball(g, M.lamp, 1, 0, ly, lz + 0.03, 0.085, 0.055, 0.04);
}
// rear thruster nozzle + hot core, taillight bar
function thruster(g, M, y, z, r = 0.1, x = 0) { cyl(g, M.dark, r * 1.25, r, 0.14, x, y, z + 0.02, 10); ball(g, M.hot, r * 0.8, x, y, z - 0.04, 1, 1, 0.35); }
const tail = (g, M, w, y, z) => { box(g, M.hot, w, 0.035, 0.04, 0, y, z); box(g, M.glow, w * 1.3, 0.025, 0.03, 0, y - 0.05, z + 0.01); };

// ---------------- rider: suit, seat, bars, helmet with visor ----------------
const DEF_POSE = { hy: 1.2, hz: -0.3, by: 1.12, bz: 0.62 };
function rider(g, M, { hy, hz, by, bz }) {
  const hip = [0, hy, hz], sh = [0, hy + 0.34, hz + 0.3], head = [0, hy + 0.56, hz + 0.43];
  slab(g, M.plate, [[hz - 0.42, hy - 0.2], [hz + 0.18, hy - 0.2], [hz + 0.18, hy - 0.08], [hz - 0.38, hy - 0.04]], 0.3, 0, 0.03);        // seat
  limb(g, M.suit, [0, hy, hz - 0.02], sh, 0.2, 6);                                                                                   // torso
  limb(g, M.suit, [-0.17, sh[1] + 0.01, sh[2]], [0.17, sh[1] + 0.01, sh[2]], 0.1, 6);                                                // shoulders
  const n = new V3(0, 0.66, -0.75).multiplyScalar(0.19), S = new V3(...hip).add(new V3(0, 0.06, -0.02)).add(n), E = new V3(...sh).add(n);
  limb(g, M.bright, S.toArray(), E.toArray(), 0.03, 3);                                                                              // glowing back stripe
  box(g, M.bright, 0.44, 0.04, 0.06, 0, hy + 0.32, hz + 0.1, 0.8);                                                                   // shoulder bar
  for (const s of [-1, 1]) {
    limb(g, M.suit, [s * 0.24, hy + 0.34, hz + 0.3], [s * 0.36, hy + 0.12, hz + 0.5], 0.085, 5);                                     // upper arm
    limb(g, M.suit, [s * 0.36, hy + 0.12, hz + 0.5], [s * 0.3, by + 0.02, bz - 0.02], 0.07, 5);                                      // forearm
    box(g, M.bright, 0.03, 0.03, 0.2, s * 0.405, hy + 0.1, hz + 0.45, 0.5);                                                          // sleeve stripe
    tiny(g, M.bright, 0.075, s * 0.31, by, bz);                                                                                        // glove / grip
    limb(g, M.suit, [s * 0.15, hy - 0.02, hz], [s * 0.29, hy - 0.04, hz + 0.45], 0.125, 5);                                          // thigh
    limb(g, M.suit, [s * 0.29, hy - 0.04, hz + 0.45], [s * 0.32, hy - 0.5, hz + 0.18], 0.09, 5);                                     // shin
    box(g, M.bright, 0.03, 0.03, 0.4, s * 0.42, hy - 0.03, hz + 0.24);                                                               // leg stripe
    box(g, M.dark, 0.13, 0.08, 0.28, s * 0.32, hy - 0.54, hz + 0.26);                                                                // boot
  }
  box(g, M.dark, 0.68, 0.035, 0.035, 0, by, bz);                                                                                       // handlebar
  ball(g, M.helmet, 1, ...head, 0.215, 0.225, 0.255, sph);                                                                             // helmet
  put(g, new THREE.SphereGeometry(1, 12, 3, PI2 - 1.45, 2.9, 1.25, 0.55), M.visor, head[0], head[1], head[2] + 0.005, 0.225, 0.235, 0.265); // visor wraps round the face
  box(g, M.bright, 0.035, 0.03, 0.32, 0, head[1] + 0.23, head[2] - 0.01, -0.15);                                                       // crest stripe
}

// ---------------- bodies ----------------
export const BODIES = {
  sleek(g, M) { // smooth teardrop hull, canopy, glowing flank lines
    const H = hull(g, M.shell, [[0.02, -1.12], [0.18, -1.06], [0.34, -0.85], [0.46, -0.5], [0.52, -0.1], [0.5, 0.3], [0.4, 0.7], [0.24, 1.05], [0.1, 1.3], [0.02, 1.44]], 0.58, 0.5, 0.9);
    hull(g, M.plate, [[0.02, -0.95], [0.2, -0.8], [0.27, -0.4], [0.2, 0], [0.02, 0.15]], 0.5, 0.34, 1.1, { seg: 8, n: 7, cz: -0.2 });
    hull(g, M.canopy, [[0.02, 0.15], [0.26, 0.3], [0.3, 0.6], [0.2, 0.95], [0.02, 1.1]], 0.46, 0.4, 1.0, { seg: 10, n: 7, cz: 0.1 });
    for (const s of [-1, 1]) slab(g, M.plate, [[-0.6, 0.82], [0.55, 0.9], [0.7, 0.8], [-0.5, 0.74]], 0.05, s * 0.255, 0.015);
    line(g, M.glow, H, 0.38, -0.95, 1.3); line(g, M.bright, H, -0.45, -0.7, 0.9, 0.012);
    thruster(g, M, 0.98, -1.12); tail(g, M, 0.34, 1.08, -1.0);
    chassis(g, M); return { hy: 1.2, hz: -0.3, by: 1.12, bz: 0.62 };
  },
  armored(g, M) { // bulky: wide hull, bolted side armour, bumper, heavy rear block, twin thrusters
    const H = hull(g, M.shell, [[0.02, -1.1], [0.3, -1.05], [0.46, -0.8], [0.5, -0.3], [0.5, 0.4], [0.44, 0.8], [0.3, 1.1], [0.02, 1.22]], 0.85, 0.62, 0.86, { seg: 14 });
    for (const s of [-1, 1]) {
      slab(g, M.plate, [[-0.85, 0.62], [0.9, 0.62], [1.1, 0.86], [0.75, 1.12], [-0.3, 1.14], [-0.95, 0.96]], 0.1, s * 0.47, 0.03);
      slab(g, M.dark, [[-0.6, 0.76], [0.55, 0.78], [0.6, 0.92], [-0.55, 0.94]], 0.05, s * 0.53, 0.015);                                   // inset panel
      tube(g, M.glow, [[s * 0.56, 0.86, -0.55], [s * 0.57, 0.86, 0.2], [s * 0.56, 0.88, 0.62]], 0.02, 10);
      slab(g, M.plate, [[-0.15, 0], [0.15, 0], [0.12, 0.28], [-0.12, 0.28]], 0.14, s * 0.4, 0.025, 1, 1.12, -0.5);                        // shoulder guard
      for (const z of [-0.5, 0.1, 0.65]) tiny(g, M.bright, 0.03, s * 0.56, 1.02, z);                                                       // rivets
    }
    slab(g, M.plate, [[0.3, 0.88], [1.0, 0.92], [1.3, 1.02], [1.0, 1.2], [0.3, 1.2]], 0.7, 0, 0.03, 1);                                    // bumper
    box(g, M.glow, 0.5, 0.05, 0.05, 0, 1.06, 1.33);
    hull(g, M.canopy, [[0.02, 0], [0.28, 0.2], [0.34, 0.6], [0.2, 0.95], [0.02, 1.05]], 0.7, 0.4, 1.08, { seg: 10, n: 7, cz: 0.05 });
    box(g, M.dark, 0.7, 0.42, 0.34, 0, 1.0, -1.0); box(g, M.glow, 0.5, 0.08, 0.04, 0, 1.0, -1.19); box(g, M.dark, 0.74, 0.07, 0.38, 0, 1.23, -1.0);
    for (const x of [-0.2, 0.2]) thruster(g, M, 0.9, -1.19, 0.095, x);
    for (const x of [-0.18, 0.18]) box(g, M.glow, 0.05, 0.02, 0.5, x, 1.18, -0.1);
    chassis(g, M, { top: 0.3, lz: 1.31, ly: 0.8 }); return { hy: 1.26, hz: -0.28, by: 1.2, bz: 0.55 };
  },
  frame(g, M) { // open skeletal tubes around a glowing engine core
    const G = M.glow;
    for (const s of [-1, 1]) {
      const x = s * 0.14;
      tube(g, G, [[x, 1.0, -0.62], [x, 1.1, -0.1], [x, 1.1, 0.5]], 0.035, 12);          // top rail
      tube(g, G, [[x, 0.62, -0.5], [x, 0.6, 0.0], [x, 0.66, 0.3]], 0.035, 10);           // lower rail
      strut(g, G, [x, 1.1, 0.5], [x, 0.66, 0.3], 0.035);                                   // down tube
      strut(g, G, [x, 1.0, -0.62], [x, 0.62, -0.5], 0.03);                                  // seat stay
      strut(g, G, [x, 1.1, 0.5], [s * 0.15, 1.04, 0.68], 0.035);                            // head tube
      strut(g, M.bright, [s * 0.34, 0.5, 0.85], [s * 0.15, 1.04, 0.68], 0.03);              // fork
      strut(g, M.bright, [s * 0.34, 0.5, -0.85], [x, 0.64, -0.5], 0.03);                    // swingarm
      tube(g, M.dark, [[s * 0.26, 0.74, -0.15], [s * 0.3, 0.72, -0.7], [s * 0.26, 0.82, -1.1]], 0.04, 12, 5); ball(g, M.hot, 0.05, s * 0.26, 0.82, -1.14); // exhaust
    }
    strut(g, G, [-0.14, 1.1, 0.1], [0.14, 1.1, 0.1], 0.03); strut(g, G, [-0.14, 0.62, -0.1], [0.14, 0.62, -0.1], 0.03);
    hull(g, M.shell, [[0.02, -0.4], [0.3, -0.25], [0.4, 0], [0.3, 0.25], [0.02, 0.42]], 0.55, 0.5, 0.84, { seg: 10, n: 8, cz: 0.02 });
    ball(g, M.hot, 0.1, 0, 0.84, 0.02); put(g, new THREE.TorusGeometry(0.2, 0.025, 5, 20).rotateY(PI2), M.bright, 0, 0.84, 0.02);
    hull(g, M.plate, [[0.02, -0.3], [0.2, -0.15], [0.24, 0.1], [0.14, 0.4], [0.02, 0.5]], 0.6, 0.4, 1.22, { seg: 12, n: 8, cz: -0.05 });
    hull(g, M.shell, [[0.02, -0.5], [0.2, -0.35], [0.22, 0], [0.02, 0.1]], 0.7, 0.3, 1.1, { seg: 10, n: 6, cz: -0.4 });
    tail(g, M, 0.28, 1.04, -1.0); strut(g, G, [0, 1.0, -0.62], [0, 1.02, -1.0], 0.03);
    cyl(g, M.dark, 0.09, 0.12, 0.08, 0, 1.0, 0.76, 10); ball(g, M.lamp, 1, 0, 1.0, 0.82, 0.085, 0.055, 0.04);
    return { hy: 1.24, hz: -0.3, by: 1.18, bz: 0.66 };
  },
  wedge(g, M) { // low faceted blade, rear wing, canards
    const H = hull(g, M.shell, [[0.02, -1.15], [0.45, -0.95], [0.56, -0.2], [0.46, 0.5], [0.2, 1.1], [0.02, 1.6]], 0.9, 0.5, 0.8, { seg: 4, rz: PI2 / 2, n: 14 });
    hull(g, M.canopy, [[0.02, 0.0], [0.34, 0.3], [0.3, 0.7], [0.02, 1.05]], 0.55, 0.45, 0.96, { seg: 4, rz: PI2 / 2, n: 8, cz: -0.05 });
    line(g, M.glow, H, PI2 / 2, -1.0, 1.55, 0.018, 1.0, 18); line(g, M.bright, H, -PI2 / 2, -0.7, 0.8, 0.012, 1.0);
    slab(g, M.plate, [[-0.18, 0], [0.18, 0], [0.12, 0.05], [-0.18, 0.05]], 1.0, 0, 0.02, 1, 1.07, -1.0);                                // rear wing
    for (const x of [-0.5, 0.5]) slab(g, M.dark, [[-0.2, 0.82], [0.2, 0.82], [0.2, 1.1], [-0.22, 1.1]], 0.05, x, 0.015);
    box(g, M.hot, 0.9, 0.035, 0.04, 0, 1.1, -1.2);
    for (const s of [-1, 1]) { const k = new THREE.Group(); slab(k, M.bright, [[-0.11, 0], [0.11, 0], [0.11, 0.03], [-0.11, 0.03]], 0.4, 0, 0.01); k.position.set(s * 0.4, 0.84, 0.95); k.rotation.set(0, s * -0.4, s * 0.15); g.add(k); } // canards
    thruster(g, M, 0.78, -1.2, 0.09);
    chassis(g, M, { top: 0.22, lz: 1.5, ly: 0.79 }); return { hy: 1.12, hz: -0.35, by: 1.1, bz: 0.58 };
  },
  apex(g, M) { // premium: razor nose, side pods, canopy bubble, tail fin, double accent lines
    const H = hull(g, M.shell, [[0.02, -1.15], [0.2, -1.1], [0.4, -0.8], [0.5, -0.3], [0.5, 0.2], [0.38, 0.7], [0.2, 1.1], [0.08, 1.45], [0.02, 1.62]], 0.55, 0.42, 0.88, { n: 14 });
    for (const s of [-1, 1]) {
      hull(g, M.plate, [[0.02, -0.5], [0.3, -0.3], [0.4, 0.1], [0.3, 0.5], [0.02, 0.75]], 0.3, 0.26, 0.78, { seg: 8, n: 6, cx: s * 0.5 });
      tube(g, M.glow, [[s * 0.52, 0.84, -0.5], [s * 0.55, 0.86, 0.1], [s * 0.5, 0.84, 0.7]], 0.014, 10, 4);
    }
    hull(g, M.canopy, [[0.02, 0.0], [0.28, 0.2], [0.32, 0.55], [0.2, 0.95], [0.02, 1.15]], 0.46, 0.5, 1.0, { seg: 10, n: 7 });
    hull(g, M.plate, [[0.02, -1.0], [0.18, -0.85], [0.24, -0.4], [0.02, -0.1]], 0.5, 0.3, 1.1, { seg: 8, n: 7, cz: -0.15 });
    slab(g, M.plate, [[-0.35, 0], [0.3, 0], [-0.15, 0.62]], 0.05, 0, 0.01, 1, 1.0, -0.95);                                               // tail fin
    line(g, M.glow, H, 0.55, -1.0, 1.4, 0.014); line(g, M.bright, H, -0.35, -0.7, 1.1, 0.011);
    box(g, M.hot, 0.34, 0.035, 0.04, 0, 1.0, -1.18);
    thruster(g, M, 0.9, -1.16, 0.085);
    chassis(g, M, { top: 0.2, lz: 1.52, ly: 0.88 }); return { hy: 1.2, hz: -0.32, by: 1.12, bz: 0.6 };
  },
};

// ---------------- tires: each returns the half width (rims sit just outside it) ----------------
const lathX = (pts, seg = 18) => new THREE.LatheGeometry(pts.map(([r, a]) => new V2(r, a)), seg).rotateZ(PI2); // axis = x; pts = [radius, x] low x -> high x
const lip = (w, mat, x, r = 0.4, t = 0.032) => put(w, new THREE.TorusGeometry(r, t, 3, 16).rotateY(PI2), mat, x);
const bandX = (w, mat, x, r, len) => put(w, new THREE.CylinderGeometry(r, r, len, 20, 1, true).rotateZ(PI2), mat, x); // open tread band, axis x
const radial = (w, a, x = 0) => { const k = new THREE.Group(); k.rotation.x = PI2 - a; k.position.x = x; w.add(k); return k; }; // child +y points outward at wheel angle a
function lugs(w, mat, n, r, sx, sy, sz, zig = 0) { for (let i = 0; i < n; i++) box(radial(w, i * TAU / n), mat, sx, sy, sz, zig * (i % 2 ? 1 : -1), r, 0); }
const discX = (rTop, rBot, th, sx, seg = 16) => new THREE.CylinderGeometry(rTop, rBot, th, seg).rotateZ(sx > 0 ? -PI2 : PI2); // axis x, small end faces outward (sx)
export const TIRES = {
  slim(w, M) { put(w, lathX([[0.33, -0.15], [0.47, -0.15], [0.5, -0.07], [0.51, 0], [0.5, 0.07], [0.47, 0.15], [0.33, 0.15]]), M.tire); lugs(w, M.tire, 10, 0.508, 0.12, 0.03, 0.1); return 0.15; },
  wide(w, M) {
    put(w, lathX([[0.33, -0.28], [0.49, -0.28], [0.535, -0.15], [0.54, 0], [0.535, 0.15], [0.49, 0.28], [0.33, 0.28]]), M.tire);
    lugs(w, M.tire, 9, 0.54, 0.44, 0.03, 0.11); for (const s of [-1, 1]) bandX(w, M.tireGlow, s * 0.2, 0.529, 0.02); // glowing tread stripes
    return 0.28;
  },
  knobby(w, M) {
    put(w, lathX([[0.33, -0.19], [0.44, -0.19], [0.465, -0.1], [0.47, 0], [0.465, 0.1], [0.44, 0.19], [0.33, 0.19]]), M.tire);
    for (let i = 0; i < 8; i++) for (const q of [-1, 1]) box(radial(w, i * TAU / 8 + q * 0.12), M.tire, 0.11, 0.09, 0.15, q * 0.1, 0.5, 0).rotation.z = q * 0.25;
    return 0.19;
  },
  dual(w, M) {
    for (const x of [-0.17, 0.17]) put(w, lathX([[0.34, x - 0.08], [0.47, x - 0.08], [0.5, x], [0.47, x + 0.08], [0.34, x + 0.08]]), M.tire);
    bandX(w, M.tireGlow, 0, 0.496, 0.025); lugs(w, M.tire, 10, 0.5, 0.12, 0.03, 0.08, 0.17);
    return 0.27;
  },
};

// ---------------- rims: built for both sides (sx = +-1) at x = sx * (hw + 0.02) ----------------
function spokes(w, mat, x, n, r0, r1, wd = 0.035, d = 0.05) { for (let i = 0; i < n; i++) box(radial(w, i * TAU / n), mat, d, r1 - r0, wd, x, (r0 + r1) / 2, 0); }
export const RIMS = {
  spoked(w, M, x, hw, sx) { lip(w, M.glow, x); spokes(w, M.glow, x, 4, 0.06, 0.38); put(w, discX(0.07, 0.11, 0.09, sx, 10), M.bright, x); },
  disc(w, M, x, hw, sx) {
    put(w, discX(0.14, 0.4, 0.07, sx, 20), M.glow, x); lip(w, M.bright, x, 0.4, 0.035);
    for (let i = 0; i < 3; i++) box(radial(w, i * TAU / 3), M.dark, 0.08, 0.2, 0.1, x + sx * 0.02, 0.26, 0); // vents (also show the spin)
  },
  triblade(w, M, x, hw, sx) {
    for (let i = 0; i < 3; i++) { const k = radial(w, i * TAU / 3, x); slab(k, M.glow, [[-0.1, 0.06], [0.05, 0.06], [0.2, 0.34], [-0.2, 0.36]], 0.05, 0, 0.012, 0); }
    put(w, discX(0.08, 0.13, 0.09, sx, 10), M.bright, x); lip(w, M.glow, x, 0.4, 0.03);
  },
  ring(w, M, x, hw, sx) {
    lip(w, M.glow, x, 0.4, 0.065); lip(w, M.bright, x, 0.22, 0.035); spokes(w, M.dark, x, 3, 0.04, 0.21, 0.04, 0.04);
    ball(w, M.bright, 0.07, x, 0.31, 0); put(w, discX(0.05, 0.08, 0.07, sx, 8), M.bright, x);
  },
  turbine(w, M, x, hw, sx) {
    for (let i = 0; i < 6; i++) box(radial(w, i * TAU / 6, x), M.glow, 0.045, 0.3, 0.1, 0, 0.23, 0).rotation.y = 0.7;
    lip(w, M.bright, x, 0.42, 0.03); put(w, discX(0.03, 0.14, 0.1, sx, 10), M.bright, x);
  },
};

// mudguards over both wheels (arc of an open cylinder + glowing edge trim)
function fenders(g, M, hw) {
  const half = hw + 0.03;
  for (const z of [-0.85, 0.85]) {
    const len = 1.3, t0 = z > 0 ? 0.6 : Math.PI - 0.6 - len;
    put(g, new THREE.CylinderGeometry(0.585, 0.585, 2 * half, 16, 1, true, t0, len).rotateZ(PI2), M.plate, 0, WHEEL_R, z);
    for (const s of [-1, 1]) put(g, new THREE.TorusGeometry(0.585, 0.016, 3, 8, len).rotateZ(t0).rotateY(-PI2), M.glow, s * half, WHEEL_R, z);
  }
}

// ---------------- assembly ----------------
export function makeBikeMesh(color, parts = {}) {
  const P = { body: parts.body, tire: parts.tire, rim: parts.rim };
  const g = new THREE.Group(), wheels = [], mats = [];
  const mkSet = (c) => {
    const mk = (slot, col, vc) => { const m = new THREE.MeshBasicMaterial({ color: col, vertexColors: !!vc }); m.userData.slot = slot; mats.push(m); return m; };
    const C = new THREE.Color(c), lum = 0.2126 * C.r + 0.7152 * C.g + 0.0722 * C.b, lk = Math.min(1, Math.max(0.3, 0.28 / lum)); // bright colours get less glow so bloom does not fuse them into a blob
    const gc = (k) => glowColor(c, k * lk);
    return {
      dark: mk('dark', 0x16161f, 1), suit: mk('suit', new THREE.Color(0x181a2c).lerp(C, 0.02), 1), tire: mk('tire', 0x15151c), glow: mk('glow', gc(1.35)), bright: mk('bright', gc(1.0)),
      tireGlow: mk('tireGlow', gc(0.8)), hot: mk('hot', gc(1.6).lerp(new THREE.Color(2.2, 2.2, 2.2), 0.3)), visor: mk('visor', gc(1.9)),
      lamp: mk('lamp', new THREE.Color(2, 2, 2)),
      helmet: mk('helmet', C.clone().multiplyScalar(0.3).lerp(new THREE.Color(0x2a2c40), 0.6), 1),
      shell: mk('shell', new THREE.Color(0x22243a).lerp(C, 0.06), 1), plate: mk('plate', new THREE.Color(0x474c6c).lerp(C, 0.08), 1), canopy: mk('canopy', C.clone().multiplyScalar(0.55), 1),
    };
  };
  const M = mkSet(color);
  // custom catalog items use their base part's model; an optional colour re-tints that part's materials (unknown ids fall back to the default model)
  // P[cat] may be an inline part object (BIKE EDITOR preview); base 'none' + shapes = custom shapes (see the end of this file)
  const pick = (cat, T, def) => { const o = P[cat], p = o && typeof o === 'object' ? o : getPart(cat, o), k = (p && p.base) || (typeof o === 'string' ? o : def), sh = p && p.shapes && p.shapes.length ? p.shapes : null, key = k === 'none' ? 'none' : T[k] ? k : def; return [shapeBuilder(cat, T[key] || NONE[cat], sh), key + (sh ? '+' + shapesKey(sh) : ''), p && p.custom && p.color != null ? mkSet(p.color) : M]; };
  const [tire, tk, MT] = pick('tire', TIRES, 'slim'), [rim, rk, MR] = pick('rim', RIMS, 'spoked'), [body, bk, MB] = pick('body', BODIES, 'sleek');
  const tu = unit('tire:' + tk, MT, (t, m) => tire(t, m)), hw = tu.meta;
  const ru = unit(`rim:${rk}:${hw}`, MR, (t, m) => { for (const sx of [-1, 1]) rim(t, m, sx * (hw + 0.02), hw, sx); });
  for (const z of [-0.85, 0.85]) {
    const w = new THREE.Group(); w.position.set(0, WHEEL_R, z);
    for (const m of [...unit('tire:' + tk, MT).meshes, ...unit(`rim:${rk}:${hw}`, MR).meshes]) w.add(m); // meshes are cheap: geometry + materials are shared
    g.add(w); wheels.push(w);
  }
  const bu = unit('body:' + bk, MB, (t, m) => body(t, m)), pose = bu.meta || DEF_POSE;
  for (const m of bu.meshes) g.add(m);
  for (const m of unit('rider:' + JSON.stringify(pose), M, (t, m) => rider(t, m, pose)).meshes) g.add(m);
  for (const m of unit('fender:' + hw, M, (t, m) => fenders(t, m, hw)).meshes) g.add(m);
  g.scale.setScalar(CFG.bikeScale);
  return { group: g, wheels, mats };
}

// ---------------- custom shapes (BIKE EDITOR, js/admin-bikeedit.js; data format + limits: js/shapedef.js) ----------------
// A custom part = a base builder (or none) + a list of primitive shapes added with the same material roles. Primitives fit a 1 x 1 x 1 box before the shape's own size.
const NONE = { body: () => undefined, tire: () => 0.15, rim: () => {} };
const wedgeShape = () => { const sh = new THREE.Shape([new V2(-0.5, -0.5), new V2(0.5, -0.5), new V2(0.5, 0.5)]); return new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5).rotateY(-PI2); }; // ramp rising towards +z
const SHAPE_GEOM = {
  box: () => new THREE.BoxGeometry(1, 1, 1), sphere: () => new THREE.SphereGeometry(0.5, 12, 8), cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 14), cone: () => new THREE.ConeGeometry(0.5, 1, 14),
  torus: () => new THREE.TorusGeometry(0.38, 0.12, 6, 18), capsule: () => new THREE.CapsuleGeometry(0.25, 0.5, 2, 8), wedge: wedgeShape,
  tube: () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new V3(-0.5, 0, 0), new V3(0, 0.25, 0), new V3(0.5, 0, 0)]), 12, 0.1, 5),
};
const shapeGeoms = new Map();
export const shapeGeom = (type) => { let g = shapeGeoms.get(type); if (!g) shapeGeoms.set(type, g = SHAPE_GEOM[type]()); return g; };
/** Position / rotate / scale a mesh like shape `sh`; mirror = the copy on the -x side. */
export function placeShape(m, sh, mirror = false) {
  const k = mirror ? -1 : 1, D = Math.PI / 180;
  m.position.set(k * sh.p[0], sh.p[1], sh.p[2]); m.rotation.set(sh.r[0] * D, k * sh.r[1] * D, k * sh.r[2] * D); m.scale.set(sh.s[0], sh.s[1], sh.s[2]); return m;
}
/** Build the shape tree under g. mat(sh, i) -> material, or null for an invisible node; 'empty' is a plain group. Returns objs[i] = the copies of node i
 *  (two for a mirrored top-level node and everything inside it). */
export function buildShapes(g, shapes, mat) {
  const objs = [], mirs = [];
  shapes.forEach((sh, i) => {
    const m = sh.type === 'empty' ? null : mat(sh, i), mk = (mir) => placeShape(m ? new THREE.Mesh(shapeGeom(sh.type), m) : new THREE.Group(), sh, mir);
    if (sh.parent === undefined) { mirs[i] = sh.mirror && Math.abs(sh.p[0]) > 0.001 ? [false, true] : [false]; objs[i] = mirs[i].map((mir) => { const o = mk(mir); g.add(o); return o; }); }
    else { mirs[i] = mirs[sh.parent]; objs[i] = objs[sh.parent].map((p, k) => { const o = mk(mirs[i][k]); p.add(o); return o; }); }
  });
  return objs;
}
export const addShapes = (g, M, shapes) => { buildShapes(g, shapes, (sh) => M[sh.role]); };
// builder = base builder + the shapes (rim builders run once per side: add the shapes once)
const shapeBuilder = (cat, base, sh) => (!sh ? base : (...a) => { const r = base(...a); if (cat !== 'rim' || a[4] > 0) addShapes(a[0], a[1], sh); return r; });
export const dropShapeUnits = () => { for (const k of [...unitCache.keys()]) if (k.includes('+')) unitCache.delete(k); }; // editor: forget old drafts
