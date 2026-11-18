// ADMIN > BIKE EDITOR tab: build custom garage BODIES / TIRES / RIMS from a base model (or from nothing) plus primitive shapes (box, sphere, cylinder, cone, torus,
// capsule, wedge, tube). Data format, limits and the validator: js/shapedef.js (the server runs the same one). Saves through the existing custom item ops
// (server/admin-items.js itemSave: {item:{cat,name,price,ach,base,shapes}} creates, {id,item} updates). The preview is its own small three.js renderer
// (the real model from makeBikeMesh, so what you see is what the garage shows). Tire / rim shapes are in WHEEL space (origin = wheel centre) and shown on the front wheel (wheels[1], z +0.85).
// Mouse: left drag = orbit, left click = select, right drag = move (the shape under the cursor, else the selected one), green spheres = resize one side,
// wheel / pinch = zoom. OBJECT TREE: drag a row onto another row to put it inside (keeps its place in the world); EMPTY = a group. Hotkeys per type are
// set in the panel (kept in this browser). DOM + three only.
import * as THREE from 'three';
import { registerAdminTab } from './admin-core.js';
import { BUILTIN_PARTS, partList } from './parts.js';
import { ACHIEVEMENTS } from './achievements.js';
import { useCatalog } from './catalog.js';
import { makeBikeMesh, shapeGeom, buildShapes, dropShapeUnits } from './bikemodels.js';
import { SHAPE_TYPES, SHAPE_ROLES, MAX_SHAPES, cleanShape, validateShapes } from './shapedef.js';

const ERR = { bad_name: "NAME: 1-20 LETTERS, NUMBERS, SPACE _ . ' -", bad_price: 'PRICE: WHOLE NUMBER 0-1,000,000', bad_ach: 'UNKNOWN ACHIEVEMENT', bad_base: 'BAD BASE MODEL', bad_shapes: 'INVALID SHAPES', too_many: 'TOO MANY CUSTOM ITEMS', not_found: 'ITEM NOT FOUND', forbidden: 'NOT AN ADMIN', offline: 'NOT CONNECTED', timeout: 'NO ANSWER FROM SERVER' };
const CATN = { body: 'BODY', tire: 'TIRE', rim: 'RIM' };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const sel = (opts, val) => { const s = el('select'); for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; s.appendChild(o); } s.value = val; return s; };
const r3 = (v) => Math.round(v * 1000) / 1000;
const baseOpts = (cat) => [['none', 'NONE (FROM SCRATCH)'], ...BUILTIN_PARTS[cat].map((b) => [b.id, b.name.toUpperCase()])];
const KEYS_KEY = 'sb.bikeEditKeys', DEF_KEYS = { box: 'Digit1', sphere: 'Digit2', cylinder: 'Digit3', cone: 'Digit4', torus: 'Digit5', capsule: 'Digit6', wedge: 'Digit7', tube: 'Digit8', empty: 'Digit0' };
const loadKeys = () => { try { return { ...DEF_KEYS, ...JSON.parse(localStorage.getItem(KEYS_KEY) || '{}') }; } catch { return { ...DEF_KEYS }; } };
const keyName = (c) => (c ? c.replace(/^(Digit|Key|Numpad)/, '') : '-');
const COLORS = [0xff5a1f, 0x00e5ff, 0xff2a3d, 0x1f8fff, 0xb04dff, 0x7dff2e, 0xffe600, 0xff2fd0, 0xf2f2ff];

const CSS = `body.bkEditing > *:not(#bkEd) { display: none !important; }
#bkEd { position: fixed; inset: 0; z-index: 60; display: flex; background: #04070b; color: #cfe; font-family: 'Orbitron', monospace; font-size: 11px; letter-spacing: 1px; user-select: none; }
#bkEd .bkView { flex: 1; position: relative; min-width: 0; touch-action: none; cursor: grab; } #bkEd .bkView.hand { cursor: move; }
#bkEd .bkView canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; } /* beats the game's global canvas:not(#minimap) { position: fixed } */
#bkEd .bkTL, #bkEd .bkBL { position: absolute; left: 8px; display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
#bkEd .bkTL { top: 8px; right: 8px; } #bkEd .bkTL span { color: #8ab; font-size: 10px; } #bkEd .bkBL { bottom: 8px; }
#bkEd .bkSt { position: absolute; right: 8px; bottom: 8px; color: #8ab; text-align: right; max-width: 60%; font-size: 10px; }
#bkEd .bkSt.bad { color: #f88; } #bkEd .bkSt.ok { color: #7f7; }
#bkEd .bkSide { width: min(330px, 46vw); display: flex; flex-direction: column; border-left: 2px solid #0ff; box-shadow: 0 0 10px #0ff, inset 0 0 8px rgba(0,255,255,.25); background: rgba(0,16,26,.96); box-sizing: border-box; min-height: 0; }
#bkEd .bkSc { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 4px; overscroll-behavior: contain; }
#bkEd .bkBar { flex: none; padding: 5px 8px; border-top: 1px solid #0ff; background: rgba(0,10,16,.98); display: flex; flex-direction: column; gap: 4px; }
#bkEd b { color: var(--neon, #0ff); font-size: 10px; letter-spacing: 2px; margin-top: 4px; }
#bkEd .bkRow { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
#bkEd .bkRow.bkN { flex-wrap: nowrap; gap: 2px; }
#bkEd .mbtn { min-width: 0; min-height: 26px; padding: 1px 7px; font-size: 10px; letter-spacing: 1px; margin: 0; }
#bkEd .bkTree { width: min(230px, 30vw); flex: none; display: flex; flex-direction: column; gap: 4px; padding: 4px 6px 6px; box-sizing: border-box; min-height: 0; border-right: 2px solid #0ff; box-shadow: 0 0 10px #0ff, inset 0 0 8px rgba(0,255,255,.25); background: rgba(0,16,26,.96); }
#bkEd .bkList { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; border: 1px solid #357; padding: 3px 3px 24px; overscroll-behavior: contain; }
#bkEd .bkTree span { color: #8ab; font-size: 9px; } #bkEd .bkList .mbtn { flex: none; justify-content: flex-start; text-align: left; overflow: hidden; white-space: nowrap; }
#bkEd .bkList .drop { box-shadow: 0 0 8px #7f7; border-color: #7f7; } #bkEd .bkList.drop { border-color: #7f7; }
#bkEd .bkKeys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; } #bkEd .bkKeys .mbtn.wait { border-color: #ff0; color: #ff0; }
#bkEd .bkCell { display: flex; align-items: center; } #bkEd .bkCell span { width: 9px; color: #8ab; }
#bkEd .bkCell .mbtn { min-height: 24px; width: 16px; padding: 0; }
#bkEd input, #bkEd select { background: #012; color: #fff; border: 1px solid #357; font: inherit; font-size: 11px; letter-spacing: 0; padding: 3px 4px; min-width: 0; box-sizing: border-box; }
#bkEd input:focus, #bkEd select:focus { outline: none; border-color: #0ff; box-shadow: 0 0 6px #0ff; }
#bkEd .bkCell input { width: 44px; padding: 3px 0; font-size: 10px; text-align: center; } #bkEd .bkLab { width: 40px; color: #0ff; }
#bkEd input[type=text] { width: 120px; } #bkEd input[type=number].wide { width: 76px; } #bkEd select { max-width: 150px; }
#bkEd .bkBar input[type=text] { flex: 1; width: auto; } #bkEd .bkBar .mbtn { flex: 1; }
#bkEd .bkSw { width: 22px; height: 22px; border: 2px solid #345; padding: 0; cursor: pointer; } #bkEd .bkSw.sel { border-color: #fff; box-shadow: 0 0 8px #fff; }
.bkTab .adLine select { background: #012; color: #fff; border: 1px solid #357; padding: 5px; font: inherit; }`;

/** Open the editor. start = {cat, base, shapes, item?:{id,name,price,ach}}; call = admin op caller. onClose() afterwards. Returns {close()}. */
export function openBikeEditor({ start, call, onClose = () => {} }) {
  const cat = start.cat, item = start.item || null;
  let base = start.base, shapes = (validateShapes(cat, start.shapes).shapes || []).slice(), cur = shapes.length ? 0 : -1, keys = loadKeys(), binding = null, mult = 1, color = COLORS[0], loaded = item && item.id, dirty = false, dead = false;
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const root = el('div'); root.id = 'bkEd'; document.body.append(root); document.body.classList.add('bkEditing');
  const view = el('div', 'bkView'), wrap = el('div', 'bkSide'), side = el('div', 'bkSc'), bar = el('div', 'bkBar'); wrap.append(side, bar); const treeBox = el('div', 'bkTree'); root.append(treeBox, view, wrap);
  const canvas = el('canvas'); view.append(canvas);
  const status = el('div', 'bkSt'); view.append(status);
  const say = (t, k) => { status.textContent = t || ''; status.className = 'bkSt' + (k ? ' ' + k : ''); };

  // ---- 3D preview ----
  const R = new THREE.WebGLRenderer({ canvas, antialias: true }); R.setClearColor(0x04070b);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, 1, 0.1, 80), K = 1.1; // K = bike scale
  const grid = new THREE.GridHelper(8, 32, 0x0a8a9a, 0x123040); scene.add(grid);
  const wheelCat = cat !== 'body', tgt = wheelCat ? new THREE.Vector3(0, 0.5 * K, 0.85 * K) : new THREE.Vector3(0, 1.0 * K, 0);
  const orb = { yaw: wheelCat ? 0.9 : 0.75, pitch: 0.28, dist: wheelCat ? 3.2 : 6.2 };
  let model = null, anchor = null, proxies = null, hl = null, objs = [];
  const hlMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffdd33).multiplyScalar(2), wireframe: true, depthTest: false, transparent: true }), pxMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  // tree helpers: shapes stay a flat list with parents first (the validator's rule)
  const depth = (i) => { let d = 0; for (let p = shapes[i].parent; p !== undefined; p = shapes[p].parent) d++; return d; };
  const sub = (i) => { const set = new Set([i]); for (let j = i + 1; j < shapes.length; j++) if (set.has(shapes[j].parent)) set.add(j); return set; };
  const order = () => { const out = [], walk = (p) => shapes.forEach((s, i) => { if ((s.parent ?? -1) === p) { out.push(i); walk(i); } }); walk(-1); return out; };
  function setList(ord, keep) { // ord = old indices in their new order; parent links remapped
    const at = new Map(ord.map((o, n) => [o, n]));
    shapes = ord.map((o) => { const s = { ...shapes[o] }; if (s.parent !== undefined) s.parent = at.get(s.parent); return s; });
    cur = at.has(keep) ? at.get(keep) : -1;
  }
  function free() { if (!model) return; scene.remove(model.group); model.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); for (const m of model.mats) m.dispose(); model = null; }
  function rebuild() { // the model + the pick proxies (same tree, invisible) + the selection outline
    dropShapeUnits(); free();
    model = makeBikeMesh(color, { [cat]: { base, shapes, custom: true } }); scene.add(model.group);
    anchor = wheelCat ? model.wheels[1] : model.group;
    proxies = new THREE.Group(); hl = new THREE.Group(); anchor.add(proxies, hl);
    objs = buildShapes(proxies, shapes, () => pxMat); proxies.traverse((o) => { if (o.isMesh) o.visible = false; });
    objs.forEach((cp, i) => cp.forEach((o) => { o.userData.i = i; }));
    const inSel = cur >= 0 ? sub(cur) : new Set(); buildShapes(hl, shapes, (sh, i) => (inSel.has(i) ? hlMat : null));
    stat();
  }
  // green resize handles: the centre of each face of the selected object's box (unit box for an EMPTY)
  const hGeo = new THREE.SphereGeometry(1, 12, 8), hMat = new THREE.MeshBasicMaterial({ color: 0x33ff66, depthTest: false, transparent: true, opacity: 0.95 });
  const handles = [0, 1, 2].flatMap((a) => [-1, 1].map((sg) => { const m = new THREE.Mesh(hGeo, hMat); m.renderOrder = 10; m.userData.h = { a, sg }; m.visible = false; scene.add(m); return m; }));
  const unitBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const boxOf = (i) => { if (shapes[i].type === 'empty') return unitBox; const g = shapeGeom(shapes[i].type); if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox; };
  function placeHandles() {
    const o = cur >= 0 && objs[cur] && objs[cur][0]; for (const h of handles) h.visible = !!o; if (!o) return;
    const bb = boxOf(cur), c = bb.getCenter(new THREE.Vector3());
    for (const h of handles) { const { a, sg } = h.userData.h, pt = c.clone(); pt.setComponent(a, sg > 0 ? bb.max.getComponent(a) : bb.min.getComponent(a)); h.position.copy(o.localToWorld(pt)); h.scale.setScalar(0.007 * h.position.distanceTo(cam.position)); }
  }
  const stat = () => say(`${shapes.length}/${MAX_SHAPES} SHAPES${dirty ? ' - UNSAVED' : ''}`);
  const size = () => { const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return; R.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(size); ro.observe(view);
  let raf = 0, t0 = performance.now();
  (function loop() {
    if (dead) return; raf = requestAnimationFrame(loop);
    const t = performance.now(); hlMat.opacity = 0.55 + 0.45 * Math.sin((t - t0) / 160); // pulsing outline (never fully hidden)
    const cp = Math.cos(orb.pitch); cam.position.set(tgt.x + orb.dist * cp * Math.sin(orb.yaw), tgt.y + orb.dist * Math.sin(orb.pitch), tgt.z + orb.dist * cp * Math.cos(orb.yaw)); cam.lookAt(tgt);
    scene.updateMatrixWorld(true); placeHandles(); R.render(scene, cam);
  })();

  // ---- view input: left = orbit / select, right = move, green sphere = resize ----
  const ptrs = new Map(); let drag = null, pinch = 0;
  const rc = new THREE.Raycaster();
  function ray(e, list) {
    const r = canvas.getBoundingClientRect(); rc.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
    scene.updateMatrixWorld(true); const h = rc.intersectObjects(list, false)[0]; return h && h.object;
  }
  const meshes = () => { const out = []; proxies.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };
  const shown = () => handles.filter((x) => x.visible);
  // screen drag (px) -> world vector in the plane facing the camera, at the object's depth
  const worldDelta = (o, dx, dy) => { const sc = 2 * o.getWorldPosition(new THREE.Vector3()).distanceTo(cam.position) * Math.tan(cam.fov * Math.PI / 360) / view.clientHeight, m = cam.matrixWorld.elements; return new THREE.Vector3((dx * m[0] - dy * m[4]) * sc, (dx * m[1] - dy * m[5]) * sc, (dx * m[2] - dy * m[6]) * sc); };
  const parentObj = (i) => (shapes[i].parent === undefined ? proxies : objs[shapes[i].parent][0]);
  const toLocal = (i, wd) => { const P = parentObj(i), w0 = objs[i][0].getWorldPosition(new THREE.Vector3()); return P.worldToLocal(w0.clone().add(wd)).sub(P.worldToLocal(w0)); };
  function dragMove(dx, dy) { const d = toLocal(cur, worldDelta(objs[cur][0], dx, dy)), sh = shapes[cur]; put({ p: sh.p.map((v, i) => v + d.getComponent(i)) }, false); }
  function dragSize(h, dx, dy) { // move one face along its axis, the opposite face stays put
    const o = objs[cur][0], { a, sg } = h, W = new THREE.Vector3().setFromMatrixColumn(o.matrixWorld, a), len = W.length(); if (len < 1e-6) return;
    const bb = boxOf(cur), E = (bb.max.getComponent(a) - bb.min.getComponent(a)) * len, d = worldDelta(o, dx, dy).dot(W.clone().multiplyScalar(sg / len));
    const sh = shapes[cur], s = Math.max(0.01, sh.s[a] * (E + d) / E), f = s / sh.s[a], q = sg > 0 ? bb.min.getComponent(a) : bb.max.getComponent(a);
    const pd = toLocal(cur, W.multiplyScalar(q * (1 - f)));
    put({ s: sh.s.map((v, i) => (i === a ? s : v)), p: sh.p.map((v, i) => v + pd.getComponent(i)) }, false);
  }
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]); try { view.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); drag = { kind: 'pinch', moved: true }; return; }
    const h = ray(e, shown());
    if (h) drag = { kind: 'size', h: h.userData.h, moved: true };
    else if (e.button === 2) { const o = ray(e, meshes()); if (o) choose(o.userData.i); drag = { kind: cur >= 0 ? 'move' : 'none', moved: true }; }
    else drag = { kind: 'orbit', x: e.clientX, y: e.clientY, moved: false };
    view.classList.toggle('hand', drag.kind === 'move' || drag.kind === 'size');
  });
  view.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse') view.classList.toggle('hand', !!ray(e, shown())); return; }
    const o = ptrs.get(e.pointerId), dx = e.clientX - o[0], dy = e.clientY - o[1]; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) orb.dist = Math.min(14, Math.max(0.8, orb.dist * pinch / d)); pinch = d; return; }
    if (!drag || (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5)) return;
    drag.moved = true; scene.updateMatrixWorld(true);
    if (drag.kind === 'move') dragMove(dx, dy);
    else if (drag.kind === 'size') dragSize(drag.h, dx, dy);
    else if (drag.kind === 'orbit') { orb.yaw -= dx * 0.008; orb.pitch = Math.min(1.5, Math.max(-0.2, orb.pitch + dy * 0.008)); }
  });
  const up = (e) => {
    ptrs.delete(e.pointerId); pinch = 0;
    if (drag && !drag.moved && e.type === 'pointerup' && !ptrs.size) { const o = ray(e, meshes()); choose(o ? o.userData.i : -1); }
    if (!ptrs.size) { if (drag && (drag.kind === 'move' || drag.kind === 'size')) fields(); drag = null; view.classList.remove('hand'); }
  };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', (e) => { e.preventDefault(); orb.dist = Math.min(14, Math.max(0.8, orb.dist * Math.exp(e.deltaY * 0.001))); }, { passive: false });

  // overlay controls
  const tl = el('div', 'bkTL'), bl = el('div', 'bkBL'); view.append(tl, bl);
  tl.append(el('span', '', 'LEFT DRAG: ORBIT · CLICK: SELECT · RIGHT DRAG: MOVE · GREEN: RESIZE · WHEEL: ZOOM'), btn('RESET VIEW', '', () => { orb.yaw = wheelCat ? 0.9 : 0.75; orb.pitch = 0.28; orb.dist = wheelCat ? 3.2 : 6.2; }));
  const sws = COLORS.map((c) => { const b = el('button', 'bkSw'); b.type = 'button'; b.style.background = '#' + c.toString(16).padStart(6, '0'); b.addEventListener('click', () => { color = c; sws.forEach((s, i) => s.classList.toggle('sel', COLORS[i] === c)); rebuild(); }); bl.append(b); return b; });
  sws[0].classList.add('sel');

  // ---- side panel ----
  const head = el('div', 'bkRow'); head.append(el('b', '', `${CATN[cat]} EDITOR${wheelCat ? ' (WHEEL SPACE, FRONT WHEEL SHOWN)' : ''}`)); side.append(head);
  const baseSel = sel(baseOpts(cat), base); baseSel.addEventListener('change', () => { base = baseSel.value; touch(); rebuild(); });
  const brow = el('div', 'bkRow'); brow.append(el('span', 'bkLab', 'BASE'), baseSel); side.append(brow);
  treeBox.append(el('b', '', 'OBJECT TREE'), el('span', '', 'DRAG A ROW ONTO ANOTHER TO PUT IT INSIDE, ONTO THE EMPTY SPACE TO TAKE IT OUT')); const list = el('div', 'bkList'); treeBox.append(list);
  // row drag with plain pointer events (works with mouse and touch): drop on a row = put inside it, on the empty list area = top level
  let rowDrag = null;
  const rowAt = (e) => { const t = document.elementFromPoint(e.clientX, e.clientY); return !t || !list.contains(t) ? null : t.dataset.i !== undefined ? Number(t.dataset.i) : -1; };
  const mark = (at) => { list.classList.toggle('drop', at === -1); for (const b of list.children) b.classList.toggle('drop', at !== null && Number(b.dataset.i) === at && at !== rowDrag.i); };
  root.addEventListener('pointermove', (e) => { if (!rowDrag) return; if (Math.hypot(e.clientX - rowDrag.x, e.clientY - rowDrag.y) > 6) rowDrag.moved = true; if (rowDrag.moved) mark(rowAt(e)); });
  root.addEventListener('pointerup', (e) => { const d = rowDrag; rowDrag = null; if (!d || !d.moved) return; mark(null); const at = rowAt(e); if (at !== null && at !== d.i) reparent(d.i, at); });
  const addRow = el('div', 'bkRow'); side.append(addRow);
  for (const t of SHAPE_TYPES) addRow.append(btn('+' + t.toUpperCase(), '', () => add(t)));
  const act = el('div', 'bkRow'); side.append(act);
  act.append(btn('DUPLICATE', '', dup), btn('TO TOP LEVEL', '', () => { if (cur >= 0) reparent(cur, -1); }), btn('DELETE', 'danger', del));
  side.append(el('b', '', 'HOTKEYS (CLICK, THEN PRESS A KEY)')); const keyBox = el('div', 'bkKeys'); side.append(keyBox);
  function drawKeys() {
    keyBox.textContent = '';
    for (const t of SHAPE_TYPES) keyBox.append(btn(binding === t ? t.toUpperCase() + ': ...' : `${t.toUpperCase()}: ${keyName(keys[t])}`, binding === t ? 'wait' : '', () => { binding = binding === t ? null : t; drawKeys(); }));
  }
  function bindKey(code) {
    for (const t in keys) if (keys[t] === code) keys[t] = ''; // one key = one type
    keys[binding] = code; binding = null; try { localStorage.setItem(KEYS_KEY, JSON.stringify(keys)); } catch { /* private window: kept until the editor closes */ }
    drawKeys();
  }
  side.append(el('b', '', 'SELECTED SHAPE')); const inputs = {};
  const stepBtn = btn('STEP: NORMAL', '', () => { mult = mult === 1 ? 0.2 : mult === 0.2 ? 5 : 1; stepBtn.textContent = 'STEP: ' + (mult === 1 ? 'NORMAL' : mult < 1 ? 'FINE' : 'COARSE'); for (const k in inputs) inputs[k].forEach((i) => { i.step = i.dataset.step * mult; }); });
  side.append(stepBtn);
  for (const [k, label, step] of [['p', 'POS', 0.05], ['r', 'ROT', 5], ['s', 'SIZE', 0.05]]) {
    const row = el('div', 'bkRow bkN'); row.append(el('span', 'bkLab', label)); inputs[k] = [];
    for (let i = 0; i < 3; i++) {
      const c = el('div', 'bkCell'), inp = el('input'); inp.type = 'number'; inp.step = step; inp.dataset.step = step; inputs[k].push(inp);
      const nudge = (d) => { const s = shapes[cur]; if (s) put({ [k]: s[k].map((v, j) => (j === i ? v + d * step * mult : v)) }, true); };
      inp.addEventListener('input', () => { const v = Number(inp.value), s = shapes[cur]; if (inp.value !== '' && Number.isFinite(v) && s) put({ [k]: s[k].map((x, j) => (j === i ? v : x)) }, false); });
      inp.addEventListener('change', fields);
      c.append(el('span', '', 'XYZ'[i]), btn('-', '', () => nudge(-1)), inp, btn('+', '', () => nudge(1))); row.append(c);
    }
    side.append(row);
  }
  const roleSel = sel(SHAPE_ROLES.map((r) => [r, r.toUpperCase()]), 'glow'), mir = el('input'); mir.type = 'checkbox';
  roleSel.addEventListener('change', () => put({ role: roleSel.value }, true)); mir.addEventListener('change', () => put({ mirror: mir.checked }, true));
  const rr = el('div', 'bkRow'); rr.append(el('span', 'bkLab', 'ROLE'), roleSel, el('span', '', 'MIRROR'), mir); side.append(rr);
  side.append(el('b', '', 'ACHIEVEMENT (OPTIONAL, REPLACES PRICE)'));
  const name = el('input'); name.type = 'text'; name.maxLength = 20; name.value = item ? item.name : ''; name.placeholder = 'NAME';
  const price = el('input'); price.type = 'number'; price.className = 'wide'; price.min = 0; price.max = 1000000; price.value = item ? item.price : 0; price.title = 'PRICE';
  const ach = sel([['', 'NONE (PRICE)'], ...ACHIEVEMENTS.map((a) => [a.id, a.name.toUpperCase()])], item && item.ach || ''); side.append(ach);
  const r1 = el('div', 'bkRow'); r1.append(name, price); // pinned action bar: always reachable
  const r3b = el('div', 'bkRow'); const saveBtn = btn('SAVE', 'primary', () => save(true)), newBtn = btn('SAVE NEW', 'primary', () => save(false)); saveBtn.disabled = !loaded;
  r3b.append(saveBtn, newBtn, btn('CLOSE', '', () => close())); bar.append(r1, r3b);

  // ---- model changes ----
  const touch = () => { dirty = true; stat(); };
  function choose(i) { if (i === cur) return; cur = i; draw(); rebuild(); }
  function fields() { // selected shape -> inputs
    const s = shapes[cur]; for (const k in inputs) inputs[k].forEach((inp, i) => { inp.disabled = !s; if (s && document.activeElement !== inp) inp.value = r3(s[k][i]); });
    roleSel.disabled = !s || s.type === 'empty'; mir.disabled = !s || s.parent !== undefined; if (s) { roleSel.value = s.role; mir.checked = s.mirror; }
  }
  function draw() { // shape list + fields
    list.textContent = ''; if (!shapes.length) list.append(el('span', '', 'NO SHAPES YET - ADD ONE BELOW OR PRESS A HOTKEY'));
    shapes.forEach((s, i) => {
      const b = btn(`${s.type === 'empty' ? '▾ ' : ''}${s.type.toUpperCase()} ${i + 1}${s.mirror ? ' ⇄' : ''}`, i === cur ? 'sel' : '', () => choose(i));
      b.style.marginLeft = depth(i) * 14 + 'px'; b.style.width = `calc(100% - ${depth(i) * 14}px)`; b.dataset.i = i; b.style.touchAction = 'none';
      b.addEventListener('pointerdown', (e) => { if (e.button === 0) { rowDrag = { i, x: e.clientX, y: e.clientY, moved: false }; try { b.releasePointerCapture(e.pointerId); } catch { /* not captured */ } } });
      list.append(b);
    });
    fields();
  }
  function put(patch, redrawFields) { // change the selected shape (clamped by the shared validator)
    const s = shapes[cur]; if (!s) return; const n = cleanShape(cat, { ...s, ...patch }); if (!n) return;
    shapes[cur] = n; touch(); if (redrawFields) fields(); else for (const k in inputs) inputs[k].forEach((inp, i) => { if (document.activeElement !== inp) inp.value = r3(n[k][i]); }); rebuild();
    if (patch.mirror !== undefined) draw();
  }
  function add(type) { // inside the selected EMPTY, else at the top level
    if (shapes.length >= MAX_SHAPES) return say(`MAX ${MAX_SHAPES} SHAPES`, 'bad');
    const into = cur >= 0 && shapes[cur].type === 'empty' ? cur : undefined, sz = wheelCat ? 0.12 : 0.3;
    shapes.push(cleanShape(cat, { type, p: into !== undefined ? [0, 0, 0] : wheelCat ? [0, 0.45, 0] : [0, 1, 0], r: [0, 0, 0], s: type === 'empty' ? [1, 1, 1] : [sz, sz, sz], role: 'glow', mirror: false, parent: into }));
    setList(order(), shapes.length - 1); touch(); draw(); rebuild(); list.scrollTop = 1e6;
  }
  function dup() { // the selected object and everything inside it
    if (cur < 0) return; const set = [...sub(cur)]; if (shapes.length + set.length > MAX_SHAPES) return say(`MAX ${MAX_SHAPES} SHAPES`, 'bad');
    const n0 = shapes.length, at = new Map(set.map((o, k) => [o, n0 + k]));
    for (const o of set) { const s = { ...shapes[o] }; if (o === cur) s.p = [s.p[0], s.p[1], s.p[2] + 0.12]; else s.parent = at.get(s.parent); shapes.push(s); }
    setList(order(), n0); touch(); draw(); rebuild();
  }
  function del() { if (cur < 0) return; const gone = sub(cur), keep = cur; setList(order().filter((i) => !gone.has(i)), -1); cur = Math.min(keep, shapes.length - 1); touch(); draw(); rebuild(); }
  function reparent(i, p) { // keeps the object where it is in the world (Unity style)
    if (p === (shapes[i].parent ?? -1)) return; if (p >= 0 && sub(i).has(p)) return say('CAN NOT PUT AN OBJECT INSIDE ITSELF', 'bad');
    scene.updateMatrixWorld(true);
    const loc = (p >= 0 ? objs[p][0] : proxies).matrixWorld.clone().invert().multiply(objs[i][0].matrixWorld), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
    loc.decompose(P, Q, S); const E = new THREE.Euler().setFromQuaternion(Q), D = 180 / Math.PI;
    const n = cleanShape(cat, { ...shapes[i], parent: p >= 0 ? p : undefined, p: P.toArray(), r: [E.x * D, E.y * D, E.z * D], s: S.toArray() }); if (!n) return;
    shapes[i] = n; setList(order(), i); touch(); draw(); rebuild();
  }

  async function save(update) {
    const v = validateShapes(cat, shapes); if (!v.ok) return say(v.why.toUpperCase(), 'bad');
    if (base === 'none' && !shapes.length) return say('A FROM-SCRATCH PART NEEDS AT LEAST ONE SHAPE', 'bad');
    const it = { name: name.value, price: Number(price.value), ach: ach.value || null, base, shapes: shapes.length ? shapes : null };
    saveBtn.disabled = newBtn.disabled = true; say('SAVING...');
    const r = await call('itemSave', update ? { id: loaded, item: it } : { item: { ...it, cat } });
    if (dead) return;
    newBtn.disabled = false; saveBtn.disabled = !loaded;
    if (!r.ok) return say(ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad');
    loaded = r.item.id; saveBtn.disabled = false; dirty = false; stat(); say('SAVED', 'ok');
    const c = await call('itemList', {}); if (c.ok) useCatalog(c); // merge into PARTS: the garage list shows it
  }
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const onKey = (e) => {
    if (binding) { e.stopImmediatePropagation(); e.preventDefault(); if (e.code === 'Escape') { binding = null; drawKeys(); } else if (e.code !== 'Delete') bindKey(e.code); return; }
    if (e.code === 'Escape') { e.stopImmediatePropagation(); if (typing(e)) e.target.blur(); else close(); }
    else if (typing(e) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.code === 'Delete') { e.stopImmediatePropagation(); del(); }
    else { const t = SHAPE_TYPES.find((k) => keys[k] === e.code); if (t) { e.stopImmediatePropagation(); e.preventDefault(); add(t); } }
  };
  addEventListener('keydown', onKey, true);
  const onUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; addEventListener('beforeunload', onUnload);
  function close(force) {
    if (dirty && !force && !confirm('UNSAVED CHANGES WILL BE LOST. CLOSE THE EDITOR?')) return;
    dead = true; cancelAnimationFrame(raf); ro.disconnect(); removeEventListener('keydown', onKey, true); removeEventListener('beforeunload', onUnload);
    free(); R.dispose(); hlMat.dispose(); pxMat.dispose(); hGeo.dispose(); hMat.dispose(); grid.geometry.dispose(); root.remove(); st.remove(); document.body.classList.remove('bkEditing'); onClose();
  }
  say('LEFT DRAG: ORBIT · RIGHT DRAG: MOVE · GREEN SPHERES: RESIZE'); drawKeys(); draw(); rebuild(); size();
  return { close: () => close(true), state: () => ({ base, shapes, cur }), add, choose, put, reparent, dup, del };
}

function mountBikeEditor(root, { call }) {
  root.classList.add('bkTab');
  const msg = el('div', 'adMsg'), body = el('div'); let ed = null, dead = false, cat = 'body';
  root.append(msg, body);
  const say = (t, k) => { msg.textContent = t || ''; msg.className = 'adMsg' + (k ? ' ' + k : ''); };
  async function landing() {
    body.textContent = ''; say('...');
    const r = await call('itemList', {}); if (dead) return;
    if (r.ok) { useCatalog(r); say(''); } else say(ERR[r.code] || String(r.code).toUpperCase(), 'bad');
    const mk = el('div', 'adSec'), old = el('div', 'adSec'), line = el('div', 'adLine'); body.append(mk, old);
    mk.append(el('b', '', 'NEW PART: PICK A CATEGORY AND A BASE MODEL TO ADD DETAILS TO (OR START FROM SCRATCH)'), line);
    const base = sel(baseOpts(cat), BUILTIN_PARTS[cat][0].id), cats = el('select');
    for (const c of Object.keys(CATN)) cats.append(Object.assign(el('option', '', CATN[c]), { value: c })); cats.value = cat;
    cats.addEventListener('change', () => { cat = cats.value; landing(); });
    line.append(cats, base, btn('OPEN EDITOR', 'primary', () => open({ cat, base: base.value, shapes: [] })));
    old.append(el('b', '', 'EDIT AN EXISTING CUSTOM PART'));
    const items = Object.keys(CATN).flatMap((c) => partList(c).filter((p) => p.custom).map((p) => ({ ...p, cat: c })));
    if (!items.length) old.append(el('div', 'frEmpty', 'NO CUSTOM PARTS YET'));
    for (const p of items) { const row = el('div', 'adLine'); row.append(el('span', '', `${p.name.toUpperCase()}  [${CATN[p.cat]}${p.hidden ? ', HIDDEN' : ''}, ${(p.shapes || []).length} SHAPES]`), btn('EDIT', 'primary', () => open({ cat: p.cat, base: p.base, shapes: p.shapes || [], item: { id: p.id, name: p.name, price: p.price, ach: p.ach } }))); old.append(row); }
  }
  function open(start) { ed = openBikeEditor({ start, call, onClose: () => { ed = null; if (!dead) landing(); } }); }
  landing();
  return () => { dead = true; if (ed) ed.close(); };
}
registerAdminTab('bikeedit', 'BIKE EDITOR', mountBikeEditor);
