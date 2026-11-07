// Procedural canvas textures (generated once at startup, no image assets).
import * as THREE from 'three';

function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Green circuit board: traces with 45-degree jogs, pads, vias, chips. Tiles horizontally (every lane returns to its base y
// at both edges). Aspect 4:1 so one tile covers 12 x 3 world units on an arena wall.
export function makeCircuitTexture(w = 1024, h = 256) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), rnd = mulberry(1337);
  g.fillStyle = '#021a0c'; g.fillRect(0, 0, w, h);
  const glow = (col, blur) => { g.strokeStyle = col; g.fillStyle = col; g.shadowColor = col; g.shadowBlur = blur; };
  // faint substrate grid
  g.strokeStyle = 'rgba(0,120,60,.18)'; g.lineWidth = 1; g.shadowBlur = 0;
  for (let x = 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y <= h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  // horizontal bus lanes
  const lanes = [24, 52, 80, 108, 136, 164, 192, 220];
  glow('#22ff88', 8); g.lineWidth = 4; g.lineJoin = 'round';
  const pads = [];
  for (const y0 of lanes) {
    g.beginPath(); g.moveTo(0, y0);
    let x = 0;
    while (x < w - 120) {
      const x1 = x + 40 + rnd() * 110, len = 60 + rnd() * 160, d = (rnd() < 0.5 ? -1 : 1) * 14;
      const x2 = Math.min(x1 + len, w - 40);
      if (x1 + Math.abs(d) >= x2 - Math.abs(d) || rnd() < 0.3) { x = x1; continue; }
      g.lineTo(x1, y0); g.lineTo(x1 + d * Math.sign(d), y0 + d); g.lineTo(x2, y0 + d); g.lineTo(x2 + d * Math.sign(d), y0);
      x = x2 + 14;
    }
    g.lineTo(w, y0); g.stroke();
    if (rnd() < 0.7) pads.push([40 + rnd() * (w - 80), y0]);
  }
  // vertical stubs ending in pads
  for (let i = 0; i < 26; i++) {
    const x = 20 + rnd() * (w - 40), y = lanes[(rnd() * lanes.length) | 0], len = (rnd() < 0.5 ? -1 : 1) * (14 + rnd() * 26);
    g.lineWidth = 3; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + len); g.stroke();
    pads.push([x, y + len]);
  }
  // pads + vias
  for (const [x, y] of pads) {
    g.shadowBlur = 8; g.fillStyle = '#33ff99'; g.beginPath(); g.arc(x, y, 6, 0, 6.283); g.fill();
    g.shadowBlur = 0; g.fillStyle = '#021a0c'; g.beginPath(); g.arc(x, y, 2.4, 0, 6.283); g.fill();
  }
  // chips: dark rectangles with pins
  for (let i = 0; i < 7; i++) {
    const cw = 50 + rnd() * 50, ch = 28 + rnd() * 24, x = 30 + rnd() * (w - cw - 60), y = 20 + rnd() * (h - ch - 40);
    g.shadowBlur = 0; g.fillStyle = '#010d06'; g.fillRect(x, y, cw, ch);
    glow('#44ffaa', 6); g.lineWidth = 2; g.strokeRect(x, y, cw, ch);
    g.lineWidth = 2;
    for (let p = 8; p < cw - 4; p += 10) { g.beginPath(); g.moveTo(x + p, y); g.lineTo(x + p, y - 5); g.moveTo(x + p, y + ch); g.lineTo(x + p, y + ch + 5); g.stroke(); }
  }
  // bright rails along top and bottom edges
  glow('#66ffaa', 10); g.lineWidth = 6;
  g.beginPath(); g.moveTo(0, 3); g.lineTo(w, 3); g.moveTo(0, h - 3); g.lineTo(w, h - 3); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

// Trail wall look: vertical profile (v = 0 floor ... 1 top) with bright edges and a dimmer glowing body. Multiplied by the
// bike colour in the material, so the edges show the full colour and the core a softer tint.
export function makeTrailTexture() {
  const w = 4, h = 64, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, h, 0, 0); // bottom -> top
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.06, '#cfcfcf'); grad.addColorStop(0.2, '#8a8a8a');
  grad.addColorStop(0.5, '#6a6a6a'); grad.addColorStop(0.8, '#8a8a8a'); grad.addColorStop(0.94, '#d8d8d8'); grad.addColorStop(1, '#ffffff');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// Floor grid texture covering `cells` x `cells` game tiles (wraps seamlessly), one line per tile border (kept under the bloom
// threshold, only a faint glow). Mipmapped + anisotropic so lines survive at grazing angles.
export function makeGridTexture(cells = 4, px = 1024, maxAniso = 8) {
  const c = document.createElement('canvas'); c.width = c.height = px;
  const g = c.getContext('2d'), cell = px / cells;
  g.fillStyle = '#000'; g.fillRect(0, 0, px, px);
  const lines = (w, col) => {
    g.fillStyle = col;
    for (let i = 0; i < cells; i++) { // line centred on each cell border; border 0 split across the wrap
      const x = i * cell - w / 2;
      g.fillRect(x, 0, w, px); g.fillRect(0, x, px, w);
      if (i === 0) { g.fillRect(px - w / 2, 0, w / 2, px); g.fillRect(0, px - w / 2, px, w / 2); }
    }
  };
  lines(7, '#8a8a8a');
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
