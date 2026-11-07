import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CFG } from './config.js';
import { protectLeft } from './abilities.js';
import { MAPS } from './maps.js';
import { glowHex, DEFAULT_PARTS } from './parts.js';
import { makeCircuitTexture, makeTrailTexture, makeGridTexture } from './textures.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(CFG.camera.fov, 1, 0.1, 400);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
document.body.prepend(renderer.domElement);

// ---- Post-processing: bloom. strength 0 => composer bypassed (plain renderer.render). ----
let composer = null, bloomPass = null, bloomStrength = CFG.render.bloom.strength;
function buildComposer() {
  const B = CFG.render.bloom, pr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(innerWidth * pr, innerHeight * pr, { type: THREE.HalfFloatType, samples: B.msaa });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), bloomStrength, B.radius, B.threshold);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass()); // tone-map/sRGB conversion for the linear float target
}
// Settings hook. 0 disables bloom completely (composer not used, MSAA canvas renders directly).
export function setBloom(strength) {
  bloomStrength = Math.max(0, +strength || 0);
  if (bloomStrength > 0) {
    if (!composer) buildComposer();
    bloomPass.strength = bloomStrength;
  }
}
export const getBloom = () => bloomStrength;

let maxDpr = CFG.render.maxDpr;
// Settings hook: graphics quality = devicePixelRatio cap.
export function setMaxDpr(v) { maxDpr = Math.max(0.5, +v || 1); resize(); }
function resize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight); }
}
addEventListener('resize', resize); addEventListener('orientationchange', resize); resize();
setBloom(bloomStrength);

// ---- Floor: black with a glowing white grid. One grid cell = one tile = CFG.tile world units = one bike length. The texture
// holds GRID_CELLS x GRID_CELLS tiles (mipmapped/anisotropic, kept near the bloom threshold); each platform's UVs are offset so
// the lines fall on multiples of CFG.tile in WORLD coordinates (every platform shares one grid). The floor fades to black with
// view distance so the horizon never washes out. ----
const GRID_CELLS = 4;
const gridTex = makeGridTexture(GRID_CELLS, 1024, renderer.capabilities.getMaxAnisotropy());
const floorMat = new THREE.MeshBasicMaterial({ map: gridTex, color: 0xffffff });
floorMat.onBeforeCompile = (sh) => {
  const G = CFG.render.grid, NL = '\n';
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + NL + 'varying float vDist;')
    .replace('#include <project_vertex>', '#include <project_vertex>' + NL + 'vDist = length(mvPosition.xyz);');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + NL + 'varying float vDist;')
    .replace('#include <dithering_fragment>', '#include <dithering_fragment>' + NL +
      `gl_FragColor.rgb *= (1.0 - smoothstep(${G.fadeNear.toFixed(1)}, ${G.fadeFar.toFixed(1)}, vDist)) * ${G.gain.toFixed(2)};`);
};

// ---- Map: platforms (dark slabs: gridded top, circuit-board sides, glowing top edges). No walls anywhere. ----
// Rebuilt whenever state.map changes. The default arena is one 102x102 platform at y=0.
const circuit = makeCircuitTexture();
const TILE_W = 12, SLAB_D = 8, EDGE_T = 0.3;
const slabEdgeMat = new THREE.MeshBasicMaterial({ color: glowColor0(0x00e5ff, 1.0) });
function glowColor0(c, k) { return new THREE.Color(c).multiplyScalar(k); }
function wallMat(len, hgt = 1) {
  const t = circuit.clone(); t.needsUpdate = true; t.repeat.set(len / TILE_W, hgt);
  return new THREE.MeshBasicMaterial({ map: t });
}
// Top face UV: u = (x - x0)/P, v = (z1 - z)/P with P = world size of the texture = GRID_CELLS * tile.
function floorMaterial(p) {
  const w = p.x1 - p.x0, d = p.z1 - p.z0, P = GRID_CELLS * CFG.tile;
  const t = gridTex.clone(); t.needsUpdate = true; t.repeat.set(w / P, d / P); t.offset.set(p.x0 / P, -p.z1 / P);
  const m = new THREE.MeshBasicMaterial({ map: t, color: 0xffffff });
  m.onBeforeCompile = floorMat.onBeforeCompile;
  return m;
}
const mapGroup = new THREE.Group();
scene.add(mapGroup);
let curMap = null;
function disposeGroup(g) {
  g.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (m !== slabEdgeMat) { if (m.map) m.map.dispose(); m.dispose(); } }
  });
  g.clear();
}
function buildMap(map) {
  disposeGroup(mapGroup); curMap = map;
  for (const p of map.platforms) {
    const w = p.x1 - p.x0, d = p.z1 - p.z0, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z. Sides are dim circuit boards; the top is the glowing grid.
    const side = (len) => { const m = wallMat(len, SLAB_D / 3); m.color.setScalar(0.85); return m; };
    const mats = [side(d), side(d), floorMaterial(p), new THREE.MeshBasicMaterial({ color: 0x050508 }), side(w), side(w)];
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, SLAB_D, d), mats);
    slab.position.set(cx, p.y - 0.01 - SLAB_D / 2, cz); mapGroup.add(slab);
    // glowing frame around the top edge (there are no walls: the edge itself is the border)
    for (const [ex, ez, sx, sz] of [[cx, p.z0, w, EDGE_T], [cx, p.z1, w, EDGE_T], [p.x0, cz, EDGE_T, d], [p.x1, cz, EDGE_T, d]]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(sx, EDGE_T, sz), slabEdgeMat);
      e.position.set(ex, p.y, ez); mapGroup.add(e);
    }
  }
}
buildMap(MAPS.arena);

// ---- Bike models (primitives): dark hull, glowing colour accents, wheels with glowing rims, rider hint ----
// Parts (js/parts.js ids): body shell, tire, rim, glow colour. Geometries are cached and shared (also with the garage preview
// renderer); materials are per model and disposed with it.
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const glowColor = (c, k = 1.5) => new THREE.Color(c).multiplyScalar(k); // >1 pushes past the bloom threshold
const WHEEL_R = 0.5, TAU = Math.PI * 2;
const geoCache = new Map();
const geo = (key, make) => { let g = geoCache.get(key); if (!g) { g = make(); geoCache.set(key, g); } return g; };
const cyl = (r, w, seg = 18) => geo(`cyl${r}_${w}_${seg}`, () => new THREE.CylinderGeometry(r, r, w, seg).rotateZ(Math.PI / 2)); // axis = x
const torus = (r, t) => geo(`tor${r}_${t}`, () => new THREE.TorusGeometry(r, t, 8, 22).rotateY(Math.PI / 2));
const helmetGeo = new THREE.SphereGeometry(0.23, 12, 10);

function box(mat, sx, sy, sz, x, y, z, rx = 0) {
  const m = new THREE.Mesh(unitBox, mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.rotation.x = rx; return m;
}
const mesh = (g, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(g, mat); m.position.set(x, y, z); return m; };

// Body shells. Local +z is forward; wheels sit at z = +-0.85, the rider is added separately. M = {dark, glow, bright}.
const BODIES = {
  sleek(g, M) {
    g.add(box(M.dark, 0.5, 0.34, 1.7, 0, 0.78, 0));
    g.add(box(M.glow, 0.54, 0.07, 1.5, 0, 0.78, 0));
    g.add(box(M.bright, 0.42, 0.22, 0.7, 0, 0.82, 1.0, -0.35));
    g.add(box(M.glow, 0.34, 0.1, 0.12, 0, 0.75, 1.42));
    g.add(box(M.bright, 0.5, 0.3, 0.3, 0, 0.95, -0.95));
    g.add(box(M.glow, 0.3, 0.1, 0.1, 0, 0.9, -1.12));
  },
  armored(g, M) {
    g.add(box(M.dark, 0.74, 0.5, 1.9, 0, 0.82, 0));
    g.add(box(M.glow, 0.78, 0.07, 1.6, 0, 0.9, 0));
    for (const x of [-0.42, 0.42]) { g.add(box(M.bright, 0.12, 0.42, 1.2, x, 0.8, 0.05)); g.add(box(M.dark, 0.14, 0.2, 0.7, x, 1.05, -0.35)); }
    g.add(box(M.bright, 0.7, 0.4, 0.3, 0, 0.8, 1.05));                  // bumper
    g.add(box(M.glow, 0.5, 0.1, 0.1, 0, 0.82, 1.22));
    g.add(box(M.dark, 0.66, 0.44, 0.34, 0, 1.0, -1.0));
    g.add(box(M.glow, 0.5, 0.1, 0.1, 0, 0.98, -1.2));
  },
  frame(g, M) { // open frame: glowing tubes, no solid hull
    const tube = (sx, sy, sz, x, y, z, rx, mat = M.glow) => g.add(box(mat, sx, sy, sz, x, y, z, rx));
    for (const x of [-0.15, 0.15]) {
      tube(0.07, 0.07, 1.8, x, 0.62, 0);                  // lower rail
      tube(0.07, 0.07, 1.2, x, 1.05, -0.1);               // top rail
      tube(0.07, 0.07, 0.95, x, 0.85, 0.85, 0.75);        // front strut
      tube(0.07, 0.07, 0.75, x, 0.85, -0.85, -0.9);       // rear strut
    }
    tube(0.34, 0.07, 0.07, 0, 1.05, 0.45); tube(0.34, 0.07, 0.07, 0, 0.62, -0.5);
    g.add(box(M.dark, 0.3, 0.3, 0.5, 0, 0.82, 0.1));      // engine block
    g.add(box(M.bright, 0.18, 0.1, 0.3, 0, 1.0, 0.1));
    g.add(box(M.glow, 0.3, 0.1, 0.1, 0, 0.75, 1.2));
    g.add(box(M.glow, 0.3, 0.1, 0.1, 0, 0.9, -1.05));
  },
  wedge(g, M) { // low, angular
    g.add(box(M.dark, 0.46, 0.2, 1.9, 0, 0.72, 0));
    g.add(box(M.bright, 0.4, 0.14, 1.0, 0, 0.8, 0.95, -0.2));
    g.add(box(M.glow, 0.5, 0.05, 1.7, 0, 0.7, 0));
    g.add(box(M.glow, 0.12, 0.1, 0.12, 0, 0.74, 1.5));
    g.add(box(M.bright, 1.0, 0.06, 0.34, 0, 1.0, -1.0));  // rear wing
    for (const x of [-0.45, 0.45]) g.add(box(M.dark, 0.06, 0.28, 0.3, x, 0.9, -1.0));
    g.add(box(M.glow, 0.9, 0.05, 0.06, 0, 1.04, -1.17));
  },
  apex(g, M) { // sleek hull with side pods and tall fin
    g.add(box(M.dark, 0.5, 0.36, 1.8, 0, 0.8, 0));
    g.add(box(M.glow, 0.54, 0.06, 1.6, 0, 0.8, 0));
    g.add(box(M.bright, 0.4, 0.22, 0.8, 0, 0.84, 1.0, -0.4));
    for (const x of [-0.42, 0.42]) { g.add(box(M.bright, 0.16, 0.2, 0.9, x, 0.72, 0.35)); g.add(box(M.glow, 0.18, 0.05, 0.7, x, 0.82, 0.35)); }
    g.add(box(M.bright, 0.08, 0.6, 0.5, 0, 1.2, -1.0, 0.25)); // fin
    g.add(box(M.glow, 0.1, 0.08, 0.1, 0, 1.52, -1.14));
    g.add(box(M.glow, 0.34, 0.1, 0.1, 0, 0.9, -1.1));
    g.add(box(M.glow, 0.3, 0.1, 0.1, 0, 0.75, 1.45));
  },
};

// Tires: returns the half width (rims sit just outside it).
const TIRES = {
  slim(w, M) { w.add(mesh(cyl(0.5, 0.3), M.tire)); return 0.15; },
  wide(w, M) { w.add(mesh(cyl(0.52, 0.56), M.tire)); w.add(mesh(cyl(0.53, 0.04), M.tireGlow)); return 0.28; },
  knobby(w, M) {
    w.add(mesh(cyl(0.46, 0.38), M.tire));
    for (let i = 0; i < 12; i++) { const k = new THREE.Group(); k.rotation.x = i * TAU / 12; k.add(box(M.tire, 0.4, 0.1, 0.16, 0, 0.5, 0)); w.add(k); }
    return 0.19;
  },
  dual(w, M) { for (const x of [-0.17, 0.17]) w.add(mesh(cyl(0.5, 0.16), M.tire, x)); w.add(mesh(cyl(0.42, 0.18), M.tireGlow)); return 0.27; },
};

// Rims: built for both sides (sx = +-1), at x = sx * (hw + 0.02).
const RIMS = {
  spoked(w, M, x, hw, sx) {
    w.add(mesh(torus(0.4, 0.055), M.glow, x));
    if (sx > 0) for (const a of [0, 1.0472, 2.0944]) { const s = box(M.glow, 2 * hw + 0.06, 0.06, 0.8); s.rotation.x = a; w.add(s); }
  },
  disc(w, M, x) {
    w.add(mesh(cyl(0.38, 0.05, 20), M.glow, x));
    w.add(box(M.dark, 0.07, 0.1, 0.34, x + Math.sign(x) * 0.02, 0.2, 0)); // off-centre mark so the spin is visible
  },
  triblade(w, M, x) {
    for (let i = 0; i < 3; i++) { const k = new THREE.Group(); k.rotation.x = i * TAU / 3; k.position.x = x; k.add(box(M.glow, 0.05, 0.26, 0.2, 0, 0.22, 0, 0)); w.add(k); }
    w.add(mesh(cyl(0.09, 0.07, 10), M.bright, x));
    w.add(mesh(torus(0.4, 0.03), M.glow, x));
  },
  ring(w, M, x) {
    w.add(mesh(torus(0.4, 0.07), M.glow, x));
    w.add(mesh(torus(0.22, 0.04), M.bright, x));
    w.add(mesh(geo('bead', () => new THREE.SphereGeometry(0.07, 8, 6)), M.bright, x, 0.31, 0)); // bead
  },
  turbine(w, M, x) {
    for (let i = 0; i < 6; i++) { const k = new THREE.Group(); k.rotation.x = i * TAU / 6; k.position.x = x; const b = box(M.glow, 0.05, 0.3, 0.1, 0, 0.23, 0); b.rotation.y = 0.7; k.add(b); w.add(k); }
    w.add(mesh(torus(0.42, 0.035), M.bright, x));
  },
};

function makeBikeMesh(color, parts = {}) {
  const P = { body: parts.body, tire: parts.tire, rim: parts.rim };
  const g = new THREE.Group(), wheels = [], mats = [];
  const mk = (c) => { const m = new THREE.MeshBasicMaterial({ color: c }); mats.push(m); return m; };
  const M = {
    dark: mk(0x0b0b14), tire: mk(0x15151c),
    glow: mk(glowColor(color, 1.6)), bright: mk(glowColor(color, 1.0)),
    tireGlow: mk(glowColor(color, 0.9)),
    helmet: mk(new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55)),
  };
  const tire = TIRES[P.tire] || TIRES.slim, rim = RIMS[P.rim] || RIMS.spoked, body = BODIES[P.body] || BODIES.sleek;
  for (const z of [-0.85, 0.85]) {
    const w = new THREE.Group(); w.position.set(0, WHEEL_R, z);
    const hw = tire(w, M);
    for (const sx of [-1, 1]) rim(w, M, sx * (hw + 0.02), hw, sx);
    g.add(w); wheels.push(w);
  }
  body(g, M);
  g.add(box(M.dark, 0.42, 0.55, 0.34, 0, 1.28, -0.1, 0.5));                // rider torso (leaning)
  g.add(box(M.bright, 0.44, 0.1, 0.12, 0, 1.4, -0.22, 0.5));               // back stripe
  const h = new THREE.Mesh(helmetGeo, M.helmet); h.position.set(0, 1.72, 0.18); g.add(h);
  g.add(box(M.glow, 0.3, 0.08, 0.1, 0, 1.72, 0.38));                       // visor
  g.scale.setScalar(CFG.bikeScale);
  return { group: g, wheels, mats };
}

// ---- Trails: one InstancedMesh per bike, growing instance count, only new/growing instances are rewritten ----
const trailTex = makeTrailTexture();
const bikeViews = new Map(); // id -> view
const INIT_CAP = 256;

// Protector / spawn-protection shield: one additive ellipsoid shell per bike (cached on the view, never reallocated).
const shieldGeo = new THREE.SphereGeometry(1, 20, 14);
function makeShield(color) {
  const m = new THREE.Mesh(shieldGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35).multiplyScalar(0.55),
    transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  const k = 1 / CFG.bikeScale; // child of the bike group, which is scaled by bikeScale
  m.scale.set(1.0 * k, CFG.bikeHeight * 0.58 * k, CFG.tile * 0.62 * k); m.position.y = CFG.bikeHeight * 0.5 * k; // wraps the bike + rider
  m.visible = false; m.frustumCulled = false;
  return m;
}

function makeTrailMesh(v, cap) {
  const m = new THREE.InstancedMesh(unitBox, v.trailMat, cap);
  m.frustumCulled = false; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(m);
  return m;
}
function viewFor(b) {
  let v = bikeViews.get(b.id);
  if (!v) {
    const { group, wheels, mats } = makeBikeMesh(b.color);
    v = { group, wheels, mats, fin: 0, first: null, dying: -1, fall: 0, px: 0, pz: 0,
      trailMat: new THREE.MeshBasicMaterial({ color: glowColor(b.color, 1.25), map: trailTex }) };
    v.cap = INIT_CAP; v.mesh = makeTrailMesh(v, v.cap);
    v.shield = makeShield(b.color); group.add(v.shield);
    scene.add(group); bikeViews.set(b.id, v);
  }
  return v;
}
// Rebuild a bike's model + trail colour from b.color and parts {body,tire,rim} (call after changing b.color / equipment).
export function setBikeStyle(b, parts) {
  const v = viewFor(b);
  scene.remove(v.group); for (const m of v.mats) m.dispose();
  const mm = makeBikeMesh(b.color, parts);
  v.group = mm.group; v.wheels = mm.wheels; v.mats = mm.mats; scene.add(v.group);
  v.shield.material.color.copy(new THREE.Color(b.color).lerp(new THREE.Color(0xffffff), 0.35).multiplyScalar(0.55)); v.group.add(v.shield);
  v.trailMat.color.copy(glowColor(b.color, 1.25));
}
function growTrail(v, need) {
  let cap = v.cap; while (cap < need) cap *= 2;
  const old = v.mesh, m = makeTrailMesh(v, cap);
  m.instanceMatrix.array.set(old.instanceMatrix.array);
  scene.remove(old); old.dispose();
  v.mesh = m; v.cap = cap; v.fin = 0; // rewrite everything once
}
function setRange(attr, startInst, n) {
  attr.needsUpdate = true;
  if (attr.clearUpdateRanges) { attr.clearUpdateRanges(); attr.addUpdateRange(startInst * 16, n * 16); }
}

function syncTrail(b, v, ex, dt) {
  const n = b.trail.length, mesh = v.mesh;
  if (!b.alive || n === 0) { // crashed: trail drops to the floor, then disappears
    if (mesh.count > 0) {
      if (v.dying < 0) v.dying = 0;
      v.dying += dt;
      const k = v.dying / CFG.trailFade;
      if (k >= 1) { mesh.count = 0; mesh.scale.y = 1; v.dying = -1; v.fin = 0; }
      else mesh.scale.y = Math.max(0.01, 1 - k * k);
    }
    return;
  }
  if (v.dying >= 0) { v.dying = -1; mesh.scale.y = 1; }
  if (n > v.cap) growTrail(v, n);
  const M = v.mesh, arr = M.instanceMatrix.array, t = CFG.trailThickness;
  if (v.first !== b.trail[0]) { v.first = b.trail[0]; v.fin = 0; } // new round: trail array was reset
  if (v.fin > n - 1) v.fin = Math.max(0, n - 1);
  // finished segments never change; rewrite from the first not-yet-finalized one to the newest (head follows interpolation)
  for (let i = v.fin; i < n; i++) {
    const s = b.trail[i], last = i === n - 1;
    const x2 = last ? s.x2 + b.dx * ex : s.x2, z2 = last ? s.z2 + b.dz * ex : s.z2;
    const sy = s.h, o = i * 16;
    arr[o] = Math.abs(x2 - s.x1) + t; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
    arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
    arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = Math.abs(z2 - s.z1) + t; arr[o + 11] = 0;
    arr[o + 12] = (s.x1 + x2) / 2; arr[o + 13] = (s.y0 || 0) + sy / 2; arr[o + 14] = (s.z1 + z2) / 2; arr[o + 15] = 1;
  }
  setRange(M.instanceMatrix, v.fin, n - v.fin);
  M.count = n; v.fin = n - 1;
}

// ---- Crash effects: pooled glowing fragments (one InstancedMesh) + expanding flash spheres ----
const P = CFG.burst.pool, STRIDE = 13; // x y z vx vy vz life max size r g b spin
const FR = new Float32Array(P * STRIDE);
let nf = 0;
const fragMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ color: 0xffffff }), P);
fragMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(P * 3), 3);
fragMesh.frustumCulled = false; fragMesh.count = 0;
fragMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); fragMesh.instanceColor.setUsage(THREE.DynamicDrawUsage); scene.add(fragMesh);

const flashGeo = new THREE.SphereGeometry(1, 16, 12);
const flashes = [];
for (let i = 0; i < 6; i++) {
  const m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.visible = false; scene.add(m); flashes.push({ m, t: 0, on: false });
}
let flashNext = 0;
const tmpC = new THREE.Color();

export function burst(x, z, color, y = 0.8) {
  tmpC.set(color);
  for (let i = 0; i < CFG.burst.count; i++) {
    const idx = nf < P ? nf++ : (Math.random() * P) | 0, o = idx * STRIDE;
    const a = Math.random() * 6.283, s = CFG.burst.speed * (0.25 + 0.75 * Math.random()), life = CFG.burst.life * (0.6 + 0.4 * Math.random());
    FR[o] = x; FR[o + 1] = y; FR[o + 2] = z;
    FR[o + 3] = Math.cos(a) * s; FR[o + 4] = 4 + Math.random() * 11; FR[o + 5] = Math.sin(a) * s;
    FR[o + 6] = life; FR[o + 7] = life; FR[o + 8] = 0.25 + Math.random() * 0.35;
    FR[o + 9] = tmpC.r; FR[o + 10] = tmpC.g; FR[o + 11] = tmpC.b; FR[o + 12] = 0;
  }
  const f = flashes[flashNext++ % flashes.length];
  f.m.position.set(x, y, z); f.m.material.color.set(color); f.t = 0; f.on = true; f.m.visible = true;
}
function updateFx(dt) {
  const arr = fragMesh.instanceMatrix.array, col = fragMesh.instanceColor.array, G = CFG.burst.gravity;
  for (let i = 0; i < nf; i++) {
    let o = i * STRIDE;
    if ((FR[o + 6] -= dt) <= 0) { // swap-remove
      nf--; if (i < nf) FR.copyWithin(o, nf * STRIDE, nf * STRIDE + STRIDE); i--; continue;
    }
    FR[o + 4] -= G * dt;
    FR[o] += FR[o + 3] * dt; FR[o + 2] += FR[o + 5] * dt;
    FR[o + 1] = Math.max(0.1, FR[o + 1] + FR[o + 4] * dt);
    if (FR[o + 1] <= 0.1) { FR[o + 3] *= 0.9; FR[o + 5] *= 0.9; FR[o + 4] = Math.abs(FR[o + 4]) * 0.35; }
  }
  for (let i = 0; i < nf; i++) {
    const o = i * STRIDE, a = FR[o + 6] / FR[o + 7], sc = FR[o + 8] * Math.sqrt(a), m = i * 16, k = (0.3 + 1.7 * a);
    arr[m] = sc; arr[m + 1] = 0; arr[m + 2] = 0; arr[m + 3] = 0;
    arr[m + 4] = 0; arr[m + 5] = sc; arr[m + 6] = 0; arr[m + 7] = 0;
    arr[m + 8] = 0; arr[m + 9] = 0; arr[m + 10] = sc; arr[m + 11] = 0;
    arr[m + 12] = FR[o]; arr[m + 13] = FR[o + 1]; arr[m + 14] = FR[o + 2]; arr[m + 15] = 1;
    col[i * 3] = FR[o + 9] * k; col[i * 3 + 1] = FR[o + 10] * k; col[i * 3 + 2] = FR[o + 11] * k;
  }
  fragMesh.count = nf;
  if (nf > 0 || fragMesh.userData.dirty) {
    fragMesh.instanceMatrix.needsUpdate = true; fragMesh.instanceColor.needsUpdate = true;
    fragMesh.userData.dirty = nf > 0;
  }
  for (const f of flashes) {
    if (!f.on) continue;
    f.t += dt;
    const u = f.t / CFG.burst.flashLife;
    if (u >= 1) { f.on = false; f.m.visible = false; continue; }
    f.m.scale.setScalar(1 + u * 9); f.m.material.opacity = 0.7 * (1 - u) * (1 - u);
  }
}

// ---- Camera ----
// Chase: yaw eased toward the heading (~cameraSwing s, frame-rate independent). Boost widens the FOV, jump height raises
// the camera. After the player dies: damped chase of a surviving bike, or a slow orbit when nobody is left.
let orbitR = 60;
const cam = { yaw: null, fx: 0, fz: 0, y: 0, fall: 0, fov: CFG.camera.fov, specId: null, orbit: 0 };
const look = new THREE.Vector3(), want = new THREE.Vector3();
const damp = (k, dt) => 1 - Math.exp(-k * dt);

function updateChase(b, px, pz, dt, k) {
  const c = CFG.camera;
  if (k === 0 || cam.yaw === null) { cam.fx = px; cam.fz = pz; } else { const a = damp(k, dt); cam.fx += (px - cam.fx) * a; cam.fz += (pz - cam.fz) * a; }
  const target = Math.atan2(b.dx, b.dz);
  if (cam.yaw === null) { cam.yaw = target; cam.y = b.y; }
  let d = target - cam.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  cam.yaw += d * damp(4 / CFG.cameraSwing, dt);                 // ~98% done in cameraSwing
  // Falling off an edge: the camera sinks only slowly (hovers near the platform) and looks down at the falling bike.
  cam.y += ((b.falling && b.y < cam.y - 0.5 ? b.y * 0.25 : b.y) - cam.y) * damp(b.falling ? 6 : 14, dt);
  cam.fall += ((b.falling ? 1 : 0) - cam.fall) * damp(8, dt);
  // Short/wide screens (phones in landscape): the HUD buttons eat the bottom of the view, so look closer to the bike
  // (smaller look-ahead) which lifts it up the screen. Desktop (aspect <= 1.8) is unchanged.
  const wide = Math.min(1, Math.max(0, (camera.aspect - 1.8) / 0.9));
  const la = c.lookAhead * (1 - c.wideLook * wide);
  const fx = Math.sin(cam.yaw), fz = Math.cos(cam.yaw);
  camera.position.set(cam.fx - fx * c.back, c.up + cam.y * 0.6, cam.fz - fz * c.back);
  const ly = c.lookY + cam.y * 0.5;
  look.set(cam.fx + fx * la * (1 - 0.6 * cam.fall), ly + (b.y - ly) * cam.fall, cam.fz + fz * la * (1 - 0.6 * cam.fall));
  camera.lookAt(look);
  const tf = c.fov + (b.speed > b.baseSpeed * 1.01 ? c.fovBoost : 0);
  cam.fov += (tf - cam.fov) * damp(c.fovLerp, dt);
  if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
}
function updateOrbit(dt) {
  const S = CFG.camera.spectate;
  cam.orbit += S.orbitSpeed * dt;
  want.set(Math.cos(cam.orbit) * orbitR, S.orbitHeight * orbitR / S.orbitRadius, Math.sin(cam.orbit) * orbitR);
  camera.position.lerp(want, damp(S.orbitLerp, dt));
  look.set(0, 0, 0); camera.lookAt(look);
  cam.fov += (CFG.camera.fov - cam.fov) * damp(CFG.camera.fovLerp, dt);
  if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
}
// Call at every round start: snap the camera back to the player and clear leftover effects.
export function resetCamera() { cam.yaw = null; cam.specId = null; cam.y = 0; cam.fall = 0; }
export function resetEffects() {
  nf = 0; fragMesh.count = 0;
  for (const f of flashes) { f.on = false; f.m.visible = false; }
  for (const v of bikeViews.values()) { v.mesh.scale.y = 1; v.dying = -1; v.fin = 0; v.first = null; v.mesh.count = 0; }
}

// extra = seconds since the last physics tick (0 when frozen); bikes/newest trail ends are extrapolated by it.
export function render(state, dt, followId, extra = 0) {
  if (state.map && state.map !== curMap) buildMap(state.map);
  orbitR = Math.max(CFG.camera.spectate.orbitRadius, (curMap ? curMap.half : 50) * 1.2);
  let follow = null, alt = null;
  for (const b of state.bikes) {
    const v = viewFor(b);
    const ex = b.alive ? b.speed * extra : 0;
    v.px = b.x + b.dx * ex; v.pz = b.z + b.dz * ex;
    v.group.visible = b.alive;
    v.group.position.set(v.px, b.y, v.pz);
    v.group.rotation.order = 'YXZ';
    v.group.rotation.y = Math.atan2(b.dx, b.dz);
    // falling off an edge: nose dips and the bike rolls as it drops (visual only)
    v.fall = b.alive && b.falling ? v.fall + dt : 0;
    const tum = Math.max(0, v.fall - 0.12);
    v.group.rotation.x = Math.min(1.25, tum * 2.2); v.group.rotation.z = Math.sin(tum * 2.5) * Math.min(1, tum * 3) * 0.6;
    if (b.alive) { const sp = b.speed * dt / WHEEL_R; v.wheels[0].rotation.x += sp; v.wheels[1].rotation.x += sp; }
    const pl = b.alive ? protectLeft(b) : 0; // shield shell: solid, then blinking for the last 0.5 s
    v.shield.visible = pl > 0 && (pl > 0.5 || Math.floor(pl * 10) % 2 === 0);
    syncTrail(b, v, ex, dt);
    if (b.alive) { if (b.id === followId) follow = b; else if (b.id === cam.specId) alt = b; }
  }
  if (follow) { cam.specId = null; const v = bikeViews.get(follow.id); updateChase(follow, v.px, v.pz, dt, 0); }
  else {
    if (!alt) { // pick a survivor to spectate (first alive), or orbit if none
      cam.specId = null;
      for (const b of state.bikes) if (b.alive) { alt = b; cam.specId = b.id; break; }
    }
    if (alt) { const v = bikeViews.get(alt.id); updateChase(alt, v.px, v.pz, dt, CFG.camera.spectate.follow); }
    else updateOrbit(dt);
  }
  updateFx(dt);
  if (composer && bloomStrength > 0) composer.render(dt); else renderer.render(scene, camera);
}

// ---- Garage preview: a small separate renderer (no bloom), only drawn while the garage is open ----
let pv = null;
export function initPreview(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const sc = new THREE.Scene(), cm = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  cm.position.set(3.6, 2.4, 4.6); cm.lookAt(0, 0.85, 0);
  const spin = new THREE.Group(); sc.add(spin);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.03, 6, 48).rotateX(Math.PI / 2), ringMat); sc.add(ring);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 0.02, 40), new THREE.MeshBasicMaterial({ color: 0x06121a })); disc.position.y = -0.02; sc.add(disc);
  pv = { r, sc, cm, spin, ringMat, model: null, ang: 0 };
}
// parts = {body,tire,rim,glow} (glow = colour id). Rebuilds the preview model.
export function setPreviewParts(parts) {
  if (!pv) return;
  if (pv.model) { pv.spin.remove(pv.model.group); for (const m of pv.model.mats) m.dispose(); }
  const color = glowHex(parts.glow || DEFAULT_PARTS.glow);
  pv.model = makeBikeMesh(color, parts); pv.spin.add(pv.model.group);
  pv.ringMat.color.copy(glowColor(color, 1.0));
}
export function drawPreview(dt) {
  if (!pv || !pv.model) return;
  const c = pv.r.domElement, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  const pr = Math.min(window.devicePixelRatio || 1, 2);
  if (c.width !== Math.round(w * pr) || c.height !== Math.round(h * pr)) { pv.r.setPixelRatio(pr); pv.r.setSize(w, h, false); pv.cm.aspect = w / h; pv.cm.updateProjectionMatrix(); }
  pv.ang += dt * 0.7; pv.spin.rotation.y = pv.ang;
  for (const wh of pv.model.wheels) wh.rotation.x += dt * 6;
  pv.r.render(pv.sc, pv.cm);
}
