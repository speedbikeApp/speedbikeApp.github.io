// Turbo dash visuals (client only, no game state). One pooled group per bike view, child of the bike group:
// wind-up = a charge orb at the rear wheel pulsing faster / brighter; dash = additive speed streaks trailing behind.
import * as THREE from 'three';
import { CFG } from './config.js';
import { turboPhase } from './abilities.js';

const orbGeo = new THREE.SphereGeometry(0.5, 12, 8), streakGeo = new THREE.BoxGeometry(1, 1, 1), ringGeo = new THREE.TorusGeometry(1, 0.05, 6, 40).rotateX(Math.PI / 2);
const STREAKS = [[-0.55, 0.5], [0.55, 0.5], [0, 0.95], [-0.3, 1.4], [0.3, 0.2]]; // local x, y (shared offsets, no per-frame allocation)
const add = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false });

function make(color) {
  const g = new THREE.Group(), c = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.2).multiplyScalar(0.7);
  g.orb = new THREE.Mesh(orbGeo, add(c, 0.6)); g.orb.position.set(0, 0.6, -1.5);
  g.ring = new THREE.Mesh(ringGeo, add(c, 0.6)); g.ring.position.set(0, 0.08, 0); // charge ring on the floor, closing in: readable from any camera
  g.add(g.orb, g.ring);
  g.streaks = STREAKS.map(([x, y]) => { const m = new THREE.Mesh(streakGeo, add(c, 0.5)); m.position.set(x, y, -3); m.scale.set(0.06, 0.06, 1); g.add(m); return m; });
  g.visible = false; g.frustumCulled = false; g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

// Call once per bike per frame from render.js. v = bike view, b = bike, t = seconds (any clock).
export function syncTurboFx(v, b, t) {
  const ph = turboPhase(b);
  if (!v.tfx) { if (!ph) return; v.tfx = make(b.color); }
  const g = v.tfx;
  if (g.parent !== v.group) v.group.add(g); // setBikeStyle swaps the bike group
  g.visible = ph > 0; if (!ph) return;
  const T = CFG.abilities.turbo, el = T.duration - b.active.turbo;
  if (ph === 1) {
    const u = el / T.windup, pulse = 0.5 + 0.5 * Math.sin(t * (14 + 40 * u)); // faster as it charges
    g.orb.visible = true; g.orb.scale.setScalar((0.3 + 0.7 * u) * (0.75 + 0.35 * pulse)); g.orb.material.opacity = (0.35 + 0.5 * u) * (0.6 + 0.4 * pulse);
    g.ring.visible = true; g.ring.scale.setScalar(2.4 - 1.4 * u); g.ring.material.opacity = (0.4 + 0.5 * u) * (0.7 + 0.3 * pulse);
    for (const s of g.streaks) s.visible = false;
  } else {
    const u = (el - T.windup) / T.dashTime;
    g.orb.visible = false; g.ring.visible = false;
    for (let i = 0; i < g.streaks.length; i++) {
      const s = g.streaks[i], len = (3 + 6 * ((i * 0.37 + t * 3) % 1)) * (1 - 0.4 * u); // lengths flicker
      s.visible = true; s.scale.z = len; s.position.z = -1.6 - len / 2; s.material.opacity = 0.65 * (1 - 0.5 * u);
    }
  }
}
