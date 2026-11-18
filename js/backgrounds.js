// Themed 3D backgrounds (cosmetic, client-only). buildBackground(id, map) -> {group, update(dt, camera), dispose(), tris}.
// Everything is procedural: merged vertex-coloured low-poly meshes (unlit MeshBasicMaterial) + a few gradient ShaderMaterials
// (sky dome, ground, water, aurora). Nothing is ever placed inside radius D0 = (map radius + margin) of the origin, and the
// ground/water sits well below the lowest platform, so scenery can never overlap a platform or block the chase camera.
// Colours are kept near/below the bloom threshold (linear 0.2) except deliberate glows (synthwave sun, city windows, moon).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const BACKGROUNDS = [
  { id: 'void', name: 'VOID' }, { id: 'desert', name: 'DESERT CANYON' }, { id: 'synthwave', name: 'SYNTHWAVE' },
  { id: 'city', name: 'NEON CITY' }, { id: 'ice', name: 'FROZEN PEAKS' }, { id: 'space', name: 'DEEP SPACE' }, { id: 'ocean', name: 'OCEAN DUSK' },
];
// Random pick (never the same twice in a row when avoid is given). The plain void is a rare pick (it is the "original look").
export function randomBackground(rng = Math.random, avoid = null) {
  const ids = BACKGROUNDS.map((b) => b.id).filter((id) => id !== avoid);
  if (rng() < 0.06 && avoid !== 'void') return 'void';
  const pool = ids.filter((id) => id !== 'void');
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

const rngOf = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Radius of the circle (about the origin) that contains every platform, height range, ground level.
function extent(map) {
  let R = 30, minY = 0, maxY = 0;
  for (const p of map.platforms) {
    const hw = (p.x1 - p.x0) / 2, hd = (p.z1 - p.z0) / 2, hd2 = Math.hypot(hw, hd), tilt = p.rx || p.rz ? hd2 * 0.8 : 0;
    R = Math.max(R, Math.hypot((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2) + hd2);
    minY = Math.min(minY, p.y - tilt); maxY = Math.max(maxY, p.y + tilt);
  }
  return { R, minY, maxY, killY: typeof map.killY === 'number' ? map.killY : -14 };
}

// ---- merged low-poly builder: every part gets a bottom->top vertex-colour gradient, flat facet shading and distance haze ----
const LIGHT = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();
function builder(c, hazeCol, hazeMax = 0.75) {
  const list = [], col = new THREE.Color(), c0 = new THREE.Color(), c1 = new THREE.Color(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), p = new THREE.Vector3(), s = new THREE.Vector3(), n = new THREE.Vector3();
  return {
    // o: x,y,z, sx,sy,sz, ry, rz, c0 (bottom), c1 (top), pw (gradient exponent), lit (0..1 facet shading), bands, v (brightness)
    add(geo, o) {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      g.computeBoundingBox(); const y0 = g.boundingBox.min.y, hy = Math.max(1e-6, g.boundingBox.max.y - y0), pos = g.attributes.position;
      const t = new Float32Array(pos.count); for (let i = 0; i < pos.count; i++) t[i] = (pos.getY(i) - y0) / hy;
      e.set(0, o.ry || 0, o.rz || 0); q.setFromEuler(e); p.set(o.x || 0, o.y || 0, o.z || 0); s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
      g.applyMatrix4(m4.compose(p, q, s)); g.computeVertexNormals();
      c0.set(o.c0 ?? 0x888888); c1.set(o.c1 ?? o.c0 ?? 0x888888);
      const lit = o.lit ?? 0.6, v = (o.v ?? 1) * (c.dim ?? 1), nrm = g.attributes.normal, out = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        let tt = Math.pow(t[i], o.pw || 1);
        col.copy(c0).lerp(c1, tt);
        let k = v; if (o.bands) k *= Math.round(t[i] * o.bands) % 2 ? 0.86 : 1;
        n.fromBufferAttribute(nrm, i);
        k *= (1 - lit) + lit * (0.5 + 0.7 * Math.abs(n.dot(LIGHT)));
        col.multiplyScalar(k);
        const d = Math.hypot(pos.getX(i), pos.getZ(i));
        col.lerp(hazeCol, ss(c.D0, 950, d) * hazeMax);
        out[i * 3] = col.r; out[i * 3 + 1] = col.g; out[i * 3 + 2] = col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(out, 3)); g.deleteAttribute('normal'); g.deleteAttribute('uv');
      list.push(g);
    },
    mesh() { if (!list.length) return null; const m = new THREE.Mesh(mergeGeometries(list), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })); for (const g of list) g.dispose(); list.length = 0; return m; },
  };
}

// Jagged ring of hills/cliffs around the origin (inside-facing strip, `rows` rings tall).
function ridgeGeo(r, y0, hMin, hMax, segs, rnd, rows = 1, jag = 0.5) {
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6], pos = [], idx = [], hs = [];
  for (let i = 0; i < segs; i++) {
    const a = i / segs * Math.PI * 2, base = 0.5 + 0.5 * (0.5 * Math.sin(a * 3 + ph[0]) + 0.3 * Math.sin(a * 7 + ph[1]) + 0.2 * Math.sin(a * 15 + ph[2]));
    hs.push(hMin + (hMax - hMin) * Math.min(1, Math.max(0, base * (1 - jag) + rnd() * jag)));
  }
  for (let j = 0; j <= rows; j++) for (let i = 0; i < segs; i++) {
    const a = i / segs * Math.PI * 2, rr = r * (1 + (rnd() - 0.5) * 0.02 * (j > 0 ? 1 : 0));
    pos.push(Math.cos(a) * rr, y0 + hs[i] * j / rows * (j === rows ? 1 : 0.85 + rnd() * 0.15), Math.sin(a) * rr);
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < segs; i++) {
    const a = j * segs + i, b = j * segs + (i + 1) % segs, c2 = a + segs, d = b + segs;
    idx.push(a, c2, b, b, c2, d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); return g;
}

// ---- shaders ----
const GL = `
float h31(vec3 p){ p=fract(p*.3183099+.1); p*=17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vn(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z); }
float stars(vec3 d, float dens, float t){ vec3 q=d*110.; vec3 i=floor(q); vec3 f=fract(q)-.5;
  f-=(vec3(h31(i+1.3),h31(i+2.7),h31(i+4.1))-.5)*.6; float r=h31(i);
  return step(1.-dens,r)*smoothstep(.22,0.,length(f))*(.6+.4*sin(t*(1.+r*3.)+r*40.)); }`;
const uc = (h) => ({ value: new THREE.Color(h) });
function skyMat(cols, extra, uniforms = {}) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: { uTop: uc(cols.top), uMid: uc(cols.mid), uHor: uc(cols.hor), uBot: uc(cols.bot ?? cols.hor), uTime: { value: 0 }, ...uniforms },
    vertexShader: 'varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 uTop,uMid,uHor,uBot; uniform float uTime;${GL}
      void main(){ vec3 d=normalize(vDir); float h=d.y; vec3 c;
        if(h>0.){ c=mix(uHor,uMid,smoothstep(0.,.3,h)); c=mix(c,uTop,smoothstep(.2,.95,h)); } else c=mix(uHor,uBot,smoothstep(0.,-.35,h));
        ${extra || ''}
        gl_FragColor=vec4(c,1.);
        #include <colorspace_fragment>
      }`,
  });
}
// Big flat disc far below: colour near -> haze colour towards the horizon (haze == sky horizon colour, so no seam).
function groundMat(near, haze, d0, noiseAmt = 0.08, anim = false) {
  return new THREE.ShaderMaterial({
    fog: false, uniforms: { uNear: uc(near), uHaze: uc(haze), uD0: { value: d0 }, uN: { value: noiseAmt }, uTime: { value: 0 } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }',
    fragmentShader: `varying vec3 vW; uniform vec3 uNear,uHaze; uniform float uD0,uN,uTime;${GL}
      void main(){ float d=length(vW.xz); vec3 c=uNear*(1.-uN+uN*2.*vn(vec3(vW.xz*.012,0.)));
        c=mix(c,uHaze,smoothstep(uD0,950.,d)); gl_FragColor=vec4(c,1.);
        #include <colorspace_fragment>
      }`,
  });
}
const disc = (r, y, mat) => { const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48).rotateX(-Math.PI / 2), mat); m.position.y = y; return m; };
const skyDome = (mat) => { const m = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 18), mat); m.renderOrder = -10; m.frustumCulled = false; return m; };

// ---- scatter helpers ----
const place = (c, d0, d1) => { const a = c.rnd() * Math.PI * 2, d = d0 + (d1 - d0) * Math.sqrt(c.rnd()); return [Math.cos(a) * d, Math.sin(a) * d, a]; };
const lerpHex = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);

const THEMES = {};
THEMES.void = () => {};

// ---- Desert canyon: orange mesas + spires, cacti, rocks, distant purple cliffs, clouds, blue sky ----
THEMES.desert = (c) => {
  const { rnd, D0, sc, G } = c, HZ = 0x4a76a0;
  c.add(skyDome(skyMat({ top: 0x0e2f6e, mid: 0x1f5896, hor: HZ }, 'c+=vec3(.5,.35,.2)*pow(max(0.,1.-abs(h)*3.),3.)*.18;')));
  c.add(disc(1200, G, groundMat(new THREE.Color(0x8a5630).multiplyScalar(0.8), new THREE.Color(HZ), D0 + 40, 0.12)));
  c.dim = 0.75;
  const far = builder(c, new THREE.Color(HZ), 0.55); // distant purple cliffs
  far.add(ridgeGeo(780, G, 70 * sc, 190 * sc, 90, rnd, 2, 0.6), { c0: 0x5a3f7a, c1: 0x8a6aa8, lit: 0.35 });
  far.add(ridgeGeo(560, G, 40 * sc, 120 * sc, 70, rnd, 2, 0.6), { c0: 0x6a4a78, c1: 0xa57a98, lit: 0.35 });
  c.add(far.mesh());
  const B = builder(c, new THREE.Color(HZ), 0.4), RED = 0x8c3a1e, ORG = 0xe0802c;
  const tier = (x, z, rb, h, y, o = {}) => B.add(new THREE.CylinderGeometry(rb * 0.85, rb, h, 7, 4), { x, y, z, ...o });
  for (let i = 0; i < 24; i++) { // mesas: two stacked tiers, banded
    const [x, z] = place(c, D0 + 30, D0 + 320), rb = (16 + rnd() * 26) * sc, h = (50 + rnd() * 60) * sc, w = 0.8 + rnd() * 0.7, ry = rnd() * 3, v = 0.8 + rnd() * 0.4;
    tier(x, z, rb * 1.3, h * 0.55, G + h * 0.275, { sx: w, sz: 1 / w, ry, c0: RED, c1: 0xc0602c, bands: 4, v });
    tier(x, z, rb * 0.95, h * 0.5, G + h * 0.55 + h * 0.25, { sx: w, sz: 1 / w, ry, c0: 0xa85226, c1: 0xcc7230, bands: 4, v: v * 0.9 });
  }
  for (let i = 0; i < 16; i++) { // spires
    const [x, z] = place(c, D0 + 20, D0 + 280), rb = (5 + rnd() * 7) * sc, h = (60 + rnd() * 70) * sc;
    B.add(new THREE.CylinderGeometry(rb * 0.25, rb, h, 5, 3), { x, y: G + h / 2, z, ry: rnd() * 3, c0: RED, c1: 0xc06a2c, bands: 3, lit: 0.35, v: 0.8 + rnd() * 0.3 });
  }
  const cactus = (x, z, s) => {
    const g = 0x2c7a3c, g2 = 0x4ca85a;
    B.add(new THREE.CylinderGeometry(0.5 * s, 0.6 * s, 5 * s, 6), { x, y: G + 2.5 * s, z, c0: g, c1: g2, lit: 0.5 });
    for (const k of [-1, 1]) {
      B.add(new THREE.CylinderGeometry(0.32 * s, 0.32 * s, 1.6 * s, 5), { x: x + k * 0.9 * s, y: G + 2.4 * s, z, rz: Math.PI / 2, c0: g, c1: g2, lit: 0.5 });
      B.add(new THREE.CylinderGeometry(0.3 * s, 0.32 * s, 1.8 * s, 5), { x: x + k * 1.7 * s, y: G + 3.2 * s, z, c0: g, c1: g2, lit: 0.5 });
    }
  };
  for (let i = 0; i < 34; i++) { const [x, z] = place(c, D0 + 5, D0 + 150); cactus(x, z, (1.6 + rnd() * 1.4) * sc); }
  for (let i = 0; i < 50; i++) { // rocks
    const [x, z] = place(c, D0 + 5, D0 + 260), r = (1.5 + rnd() * 3.5) * sc;
    B.add(new THREE.DodecahedronGeometry(r, 0), { x, y: G + r * 0.4, z, sy: 0.7, ry: rnd() * 3, c0: 0x6a3a28, c1: 0xb06a3c, v: 0.8 + rnd() * 0.4 });
  }
  c.add(B.mesh());
  const cl = builder(c, new THREE.Color(HZ), 0.5); c.dim = 0.4; // clouds: flat puffs
  for (let i = 0; i < 10; i++) {
    const [x, z] = place(c, 380, 780), y = 120 + rnd() * 120, s = (24 + rnd() * 24) * (0.6 + sc * 0.4);
    for (let k = 0; k < 4; k++) cl.add(new THREE.IcosahedronGeometry(s * (0.6 + rnd() * 0.5), 1), { x: x + (k - 1.5) * s * 0.9, y: y + rnd() * s * 0.2, z: z + (rnd() - 0.5) * s * 0.5, sy: 0.38, sz: 0.8, c0: 0xa9b4d4, c1: 0xf0e6e0, lit: 0.3 });
  }
  const cm = cl.mesh(); c.add(cm); c.tick.push((dt) => { cm.rotation.y += dt * 0.004; });
};

// ---- Synthwave: striped sun, magenta/purple sky, wireframe mountains ----
THEMES.synthwave = (c) => {
  const { rnd, D0, sc, G } = c, HZ = 0x7a1a6a;
  const sun = `vec3 s=normalize(vec3(.3,.13,-1.)); float R=.24; float dd=distance(d,s);
    c+=vec3(1.,.25,.55)*exp(-dd*5.)*.06;
    if(dd<R){ float k=(s.y-d.y)/R; float hk=(d.y-s.y)/R; vec3 sc2=mix(vec3(.45,.05,.2),vec3(.5,.26,.04),clamp(hk*.8+.5,0.,1.)); float cut=step(.0,k)*step(fract(k*6.),k*.8); c=mix(c,sc2,(1.-cut)*smoothstep(R,R-.01,dd)); }
    c+=vec3(1.)*stars(d,.02,uTime)*smoothstep(.15,.5,h)*.5;`;
  c.add(skyDome(skyMat({ top: 0x0a0020, mid: 0x3a0a6a, hor: HZ }, sun)));
  c.add(disc(1200, G, groundMat(new THREE.Color(0x14052e), new THREE.Color(HZ), D0 + 40, 0.15)));
  const ring = (r, h0, h1, segs, rows, fill, wire, y = G) => {
    const g = ridgeGeo(r, y, h0, h1, segs, rnd, rows, 0.7), m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: fill, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    const l = new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color: wire }));
    c.add(m); c.add(l);
  };
  ring(D0 + 160, 18 * sc, 60 * sc, 56, 3, 0x0c0220, new THREE.Color(0x00b8d0).multiplyScalar(0.8));
  ring(D0 + 320, 40 * sc, 110 * sc, 64, 3, 0x14042e, new THREE.Color(0xd0248c).multiplyScalar(0.8));
};

// ---- Neon city: box towers with emissive window grids ----
THEMES.city = (c) => {
  const { rnd, D0, sc, G } = c, HZ = 0x2a1048;
  const moon = `vec3 s=normalize(vec3(-.5,.35,-.8)); float dm=distance(d,s); c+=vec3(.8,.85,1.)*(smoothstep(.05,.045,dm)*1.1+exp(-dm*9.)*.2);
    c+=vec3(.9)*stars(d,.02,uTime)*smoothstep(.1,.4,h)*.6;`;
  c.add(skyDome(skyMat({ top: 0x03040e, mid: 0x0d1030, hor: HZ }, moon)));
  c.add(disc(1200, G, groundMat(new THREE.Color(0x0a0a18), new THREE.Color(HZ), D0 + 40, 0.2)));
  const B = builder(c, new THREE.Color(HZ), 0.7);
  for (let i = 0; i < 190; i++) {
    const [x, z] = place(c, D0 + 20, D0 + 330), far = Math.hypot(x, z) - D0, w = (8 + rnd() * 16) * sc, d2 = (8 + rnd() * 16) * sc, h = (30 + rnd() * 110 + far * 0.25 * rnd()) * sc;
    B.add(new THREE.BoxGeometry(1, 1, 1), { x, y: G + h / 2, z, sx: w, sy: h, sz: d2, ry: rnd() < 0.5 ? 0 : 0.5 * rnd(), c0: 0x070a1c, c1: 0x151a3c, lit: 0, v: 0.8 + rnd() * 0.5 });
    if (rnd() < 0.3) B.add(new THREE.BoxGeometry(1, 1, 1), { x, y: G + h + 3 * sc, z, sx: w * 0.5, sy: 6 * sc, sz: d2 * 0.5, c0: 0x0a0d24, c1: 0x1b2148, lit: 0 });
  }
  const m = B.mesh();
  m.material = new THREE.ShaderMaterial({ // vertex colour = wall; windows added from world position (cells 3 x 4 units)
    vertexColors: true, fog: false, uniforms: { uTime: { value: 0 } }, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vC; varying vec3 vW; void main(){ vC=color; vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }',
    fragmentShader: `varying vec3 vC; varying vec3 vW; uniform float uTime;${GL}
      void main(){ vec3 n=normalize(cross(dFdx(vW),dFdy(vW))); float u=abs(n.x)>.5?vW.z:vW.x; vec2 cell=vec2(u/3.,vW.y/4.); vec2 f=fract(cell), id=floor(cell);
        float win=step(.3,f.x)*step(f.x,.7)*step(.3,f.y)*step(f.y,.7)*(1.-step(.5,abs(n.y)));
        float r=h31(vec3(id,floor(vW.x/17.)+floor(vW.z/17.)*7.)); float on=step(.72,r);
        vec3 wc=r>.9?vec3(.15,.75,1.):(r>.8?vec3(1.,.2,.7):vec3(1.,.72,.3));
        vec3 c=vC+win*on*wc*(.75+.25*sin(uTime*.5+r*30.))*.55; gl_FragColor=vec4(c,1.);
        #include <colorspace_fragment>
      }`,
  });
  c.add(m); c.mats.push(m.material);
};

// ---- Frozen peaks: pale blue mountains with snow caps, aurora ribbons, falling snow ----
THEMES.ice = (c) => {
  const { rnd, D0, sc, G, R } = c, HZ = 0x3f6086;
  c.add(skyDome(skyMat({ top: 0x0a1c4a, mid: 0x1f4a82, hor: HZ }, 'c+=vec3(.9)*stars(d,.012,uTime)*smoothstep(.2,.6,h)*.4;')));
  c.add(disc(1200, G, groundMat(new THREE.Color(0x9fb6d0).multiplyScalar(0.3), new THREE.Color(HZ), D0 + 40, 0.07)));
  c.dim = 0.42;
  const far = builder(c, new THREE.Color(HZ), 0.55);
  far.add(ridgeGeo(780, G, 90 * sc, 210 * sc, 90, rnd, 3, 0.7), { c0: 0x3a5a84, c1: 0xa8c0e0, pw: 0.5, lit: 0.45 });
  c.add(far.mesh());
  const B = builder(c, new THREE.Color(HZ), 0.55);
  for (let i = 0; i < 16; i++) { // massifs: 1-3 peaks each
    const [x, z] = place(c, D0 + 30, D0 + 330), n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const r = (24 + rnd() * 40) * sc, h = (70 + rnd() * 110) * sc;
      B.add(new THREE.ConeGeometry(r, h, 6, 4), { x: x + (rnd() - 0.5) * r * 1.2, y: G + h / 2, z: z + (rnd() - 0.5) * r * 1.2, ry: rnd() * 3, c0: 0x34527c, c1: 0xa0b8d8, pw: 0.42, lit: 0.55, v: 0.85 + rnd() * 0.3 });
    }
  }
  for (let i = 0; i < 40; i++) { const [x, z] = place(c, D0 + 5, D0 + 140), r = (2 + rnd() * 5) * sc; B.add(new THREE.IcosahedronGeometry(r, 0), { x, y: G + r * 0.3, z, sy: 0.6, c0: 0x5a7aa0, c1: 0xa0b8d8, lit: 0.6 }); }
  c.add(B.mesh());
  // aurora ribbons (additive, animated)
  const aur = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false, uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; uniform float uTime; void main(){ vUv=uv; vec3 p=position; p.xz+=normalize(p.xz)*sin(uv.x*14.+uTime*.6)*10.*uv.y; p.y+=sin(uv.x*9.-uTime*.4)*8.*uv.y; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); }',
    fragmentShader: `varying vec2 vUv; uniform float uTime;
      void main(){ float a=smoothstep(0.,.12,vUv.y)*(1.-vUv.y)*(1.-vUv.y); a*=.55+.45*sin(vUv.x*40.+uTime);
        vec3 c=mix(vec3(.1,.9,.5),vec3(.5,.2,.9),vUv.y); gl_FragColor=vec4(c*a*.45,1.);
        #include <colorspace_fragment>
      }`,
  });
  c.mats.push(aur);
  for (let k = 0; k < 3; k++) {
    const r = 480 + k * 90, a0 = rnd() * 6, span = 1.3 + rnd() * 0.8, N = 36, pos = [], uv = [], idx = [], y0 = 150 + k * 40 + rnd() * 30, hh = 110 + rnd() * 50;
    for (let i = 0; i <= N; i++) { const a = a0 + span * i / N; for (let j = 0; j < 2; j++) { pos.push(Math.cos(a) * r, y0 + j * hh + Math.sin(i * 0.4) * 15, Math.sin(a) * r); uv.push(i / N, j); } }
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, aur); m.frustumCulled = false; m.renderOrder = -5; c.add(m);
  }
  // snow: Points that fall and sway; kept outside the playfield
  const N = 600, p = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const [x, z] = place(c, R + 15, R + 200); p[i * 3] = x; p[i * 3 + 1] = G + 30 + rnd() * 110; p[i * 3 + 2] = z; }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const sm = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, uniforms: { uTime: { value: 0 }, uBase: { value: G + 30 } },
    vertexShader: 'uniform float uTime,uBase; void main(){ vec3 q=position; q.y=mod(q.y-uTime*5.-uBase,110.)+uBase; q.x+=sin(uTime*.4+q.z)*3.; vec4 mv=modelViewMatrix*vec4(q,1.); gl_Position=projectionMatrix*mv; gl_PointSize=clamp(300./-mv.z,1.5,4.); }',
    fragmentShader: 'void main(){ if(length(gl_PointCoord-.5)>.5) discard; gl_FragColor=vec4(vec3(.5,.55,.65),1.); }',
  });
  c.add(new THREE.Points(sg, sm)); c.mats.push(sm);
};

// ---- Deep space: starfield, ringed planet, nebula, drifting asteroids ----
THEMES.space = (c) => {
  const { rnd, D0, sc } = c;
  const neb = `float n=vn(d*2.1+vec3(0.,0.,uTime*.01))*.6+vn(d*4.3+7.)*.3+vn(d*9.1)*.1; float m=smoothstep(.45,.85,n);
    c=mix(c,vec3(.32,.08,.45),m*.7)+vec3(.0,.14,.2)*smoothstep(.5,.9,vn(d*3.+31.))*.6;`;
  c.add(skyDome(skyMat({ top: 0x02020a, mid: 0x050514, hor: 0x0a0a22 }, neb)));
  const N = 1300, p = new Float32Array(N * 3), col = new Float32Array(N * 3), tc = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    p.set([s * Math.cos(a) * 900, u * 900, s * Math.sin(a) * 900], i * 3);
    tc.setHSL(rnd() < 0.5 ? 0.6 : 0.08, 0.5, 0.45 + rnd() * 0.3).multiplyScalar(0.6 + rnd() * 0.5); col.set([tc.r, tc.g, tc.b], i * 3);
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(p, 3)); sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false })); stars.renderOrder = -9; stars.frustumCulled = false; c.add(stars);
  // planet + ring
  const pl = builder(c, new THREE.Color(0x0a0a22), 0.2), dir = new THREE.Vector3(Math.cos(0.7), 0.3, Math.sin(0.7)).normalize().multiplyScalar(720);
  c.dim = 0.9;
  pl.add(new THREE.SphereGeometry(110, 28, 18), { x: dir.x, y: dir.y, z: dir.z, c0: 0x4a2a78, c1: 0x9a6ac8, bands: 9, lit: 0.9 });
  const planet = pl.mesh(); c.add(planet);
  const rg = new THREE.RingGeometry(150, 250, 64, 4), rp = rg.attributes.position, rc = new Float32Array(rp.count * 3);
  for (let i = 0; i < rp.count; i++) { const r = Math.hypot(rp.getX(i), rp.getY(i)), k = (r - 150) / 100, b = 0.35 + 0.25 * Math.sin(k * 14) ; rc.set([b * 0.9, b * 0.7, b * 1.0], i * 3); }
  rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
  const ringM = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }));
  ringM.position.copy(dir); ringM.rotation.set(Math.PI / 2 - 0.35, 0.2, 0.4); c.add(ringM);
  const B = builder(c, new THREE.Color(0x0a0a22), 0.4);
  for (let i = 0; i < 45; i++) { const [x, z] = place(c, D0 + 30, D0 + 420), r = (3 + rnd() * 12) * sc; B.add(new THREE.DodecahedronGeometry(r, 0), { x, y: (rnd() - 0.5) * 300, z, sy: 0.7 + rnd() * 0.4, ry: rnd() * 3, rz: rnd() * 3, c0: 0x2a2a3c, c1: 0x6a6a86, lit: 0.8 }); }
  const ast = B.mesh(); c.add(ast); c.tick.push((dt) => { ast.rotation.y += dt * 0.006; });
};

// ---- Ocean at dusk: animated water far below, islands with palms, warm sunset sky ----
THEMES.ocean = (c) => {
  const { rnd, D0, sc, G } = c, HZ = 0x9c4a34, WY = G + 6;
  const sun = `vec3 s=normalize(vec3(-.35,.07,-1.)); float dm=distance(d,s); c+=vec3(1.,.5,.2)*(smoothstep(.09,.08,dm)*.75+exp(-dm*4.)*.1);
    c+=vec3(1.)*stars(d,.012,uTime)*smoothstep(.3,.6,h)*.5;`;
  c.add(skyDome(skyMat({ top: 0x1a1250, mid: 0x6a2a82, hor: HZ }, sun)));
  const water = new THREE.ShaderMaterial({
    fog: false, uniforms: { uTime: { value: 0 }, uDeep: uc(0x0c3a5a), uLite: uc(0x1c7a9a), uHaze: uc(HZ) },
    vertexShader: 'varying vec3 vW; uniform float uTime; void main(){ vec3 p=position; p.y+=sin(p.x*.05+uTime)*.6+sin(p.z*.07-uTime*1.3)*.5; vec4 w=modelMatrix*vec4(p,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }',
    fragmentShader: `varying vec3 vW; uniform float uTime; uniform vec3 uDeep,uLite,uHaze;${GL}
      void main(){ float d=length(vW.xz); float w=vn(vec3(vW.xz*.05,uTime*.3))*.6+vn(vec3(vW.xz*.18,uTime*.6))*.4;
        vec3 c=mix(uDeep,uLite,w*.8)*.8; vec3 v=normalize(vW-cameraPosition); float g=pow(max(0.,dot(normalize(vec2(v.x,v.z)),normalize(vec2(-.35,-1.)))),24.);
        c+=vec3(.9,.45,.2)*g*smoothstep(.45,.9,w)*.8; c=mix(c,uHaze,smoothstep(${(D0 + 60).toFixed(0)}.,900.,d)); gl_FragColor=vec4(c,1.);
        #include <colorspace_fragment>
      }`,
  });
  const wm = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400, 40, 40).rotateX(-Math.PI / 2), water); wm.position.y = WY; c.add(wm);
  const far = builder(c, new THREE.Color(HZ), 0.7);
  far.add(ridgeGeo(800, WY - 2, 20 * sc, 70 * sc, 70, rnd, 2, 0.7), { c0: 0x2a1a50, c1: 0x6a3a7a, lit: 0.4 });
  c.add(far.mesh());
  c.dim = 0.6;
  const B = builder(c, new THREE.Color(HZ), 0.6);
  const palm = (x, y, z, h, s) => {
    const lean = (rnd() - 0.5) * 0.3, a0 = rnd() * 6;
    B.add(new THREE.CylinderGeometry(0.35 * s, 0.6 * s, h, 5, 3), { x: x - Math.sin(lean) * h * 0.5, y: y + h * 0.5, z, rz: lean, c0: 0x5a3a22, c1: 0x8a6038, lit: 0.4 });
    const tx = x - Math.sin(lean) * h, ty = y + h;
    for (let k = 0; k < 6; k++) {
      const a = a0 + k * Math.PI / 3, L = 6.5 * s;
      B.add(new THREE.ConeGeometry(0.9 * s, L, 4), { x: tx + Math.cos(a) * L * 0.42, y: ty - 0.3 * s, z: z + Math.sin(a) * L * 0.42, sz: 0.35, ry: -a, rz: -Math.PI / 2 + 0.45, c0: 0x1f7a3a, c1: 0x58c46a, lit: 0.4 });
    }
  };
  const island = (x, z, r, hgt) => {
    B.add(new THREE.SphereGeometry(r, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), { x, y: WY - 2, z, sy: hgt / r, ry: rnd() * 3, c0: 0xd8b878, c1: 0x2e8a52, pw: 0.5, lit: 0.55 });
    const np = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < np; k++) { const a = rnd() * 6, d = rnd() * r * 0.55, top = (1 - (d / r) ** 2) ** 0.5 * hgt; palm(x + Math.cos(a) * d, WY - 2 + top * 0.9, z + Math.sin(a) * d, (9 + rnd() * 5) * sc, (1 + rnd() * 0.5) * sc); }
  };
  for (let i = 0; i < 12; i++) { const [x, z] = place(c, D0 + 40, D0 + 300); island(x, z, (20 + rnd() * 40) * sc, (10 + rnd() * 16) * sc); }
  for (let i = 0; i < 7; i++) { const [x, z] = place(c, D0 + 60, D0 + 380), h = (45 + rnd() * 50) * sc, r = (6 + rnd() * 8) * sc; B.add(new THREE.CylinderGeometry(r * 0.5, r, h, 6, 3), { x, y: WY + h / 2 - 3, z, c0: 0x3a2850, c1: 0x7a5a8a, lit: 0.5 }); }
  c.add(B.mesh());
};

// ---- public ----
export function buildBackground(id, map) {
  const group = new THREE.Group(), E = extent(map), tick = [], mats = [];
  group.name = 'background:' + id;
  const c = { rnd: rngOf((Math.random() * 1e9) | 0), R: E.R, D0: E.R + 50, sc: Math.max(1, E.R / 75), G: Math.min(E.minY - 8, E.killY) - 22, tick, mats, dim: 1, add: (o) => { if (o) group.add(o); } };
  (THEMES[id] || THEMES.void)(c);
  let tris = 0;
  group.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  const unis = [];
  group.traverse((o) => { if (o.material && o.material.uniforms && o.material.uniforms.uTime && !unis.includes(o.material)) unis.push(o.material); });
  let t = 0;
  return {
    id, group, tris,
    update(dt, camera) {
      t += dt; for (const m of unis) m.uniforms.uTime.value = t;
      for (const f of tick) f(dt);
      for (const o of group.children) if (o.geometry && o.geometry.type === 'SphereGeometry' && o.geometry.parameters.radius === 1000) o.position.copy(camera.position); // sky dome follows the camera
    },
    dispose() {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); });
      group.clear();
    },
  };
}
