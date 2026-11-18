// ADMIN > BIKE EDITOR tab: build custom garage BODIES / TIRES / RIMS from a base model (or from nothing) plus primitive shapes (box, sphere, cylinder, cone, torus,
// capsule, wedge, tube). Data format, limits and the validator: js/shapedef.js (the server runs the same one). Saves through the existing custom item ops
// (server/admin-items.js itemSave: {item:{cat,name,price,ach,base,shapes}} creates, {id,item} updates). The preview is its own small three.js renderer
// (the real model from makeBikeMesh, so what you see is what the garage shows). Tire / rim shapes are in WHEEL space (origin = wheel centre) and shown on the front wheel (wheels[1], z +0.85).
// View: drag = orbit (ORBIT mode) or move the selected shape in the screen plane (MOVE mode); wheel / pinch = zoom; click = select a shape. DOM + three only.
import * as THREE from 'three';
import { registerAdminTab } from './admin-core.js';
import { BUILTIN_PARTS, partList } from './parts.js';
import { ACHIEVEMENTS } from './achievements.js';
import { useCatalog } from './catalog.js';
import { makeBikeMesh, shapeGeom, placeShape, dropShapeUnits } from './bikemodels.js';
import { SHAPE_TYPES, SHAPE_ROLES, MAX_SHAPES, cleanShape, validateShapes } from './shapedef.js';

const ERR = { bad_name: "NAME: 1-20 LETTERS, NUMBERS, SPACE _ . ' -", bad_price: 'PRICE: WHOLE NUMBER 0-1,000,000', bad_ach: 'UNKNOWN ACHIEVEMENT', bad_base: 'BAD BASE MODEL', bad_shapes: 'INVALID SHAPES', too_many: 'TOO MANY CUSTOM ITEMS', not_found: 'ITEM NOT FOUND', forbidden: 'NOT AN ADMIN', offline: 'NOT CONNECTED', timeout: 'NO ANSWER FROM SERVER' };
const CATN = { body: 'BODY', tire: 'TIRE', rim: 'RIM' };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const sel = (opts, val) => { const s = el('select'); for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; s.appendChild(o); } s.value = val; return s; };
const r3 = (v) => Math.round(v * 1000) / 1000;
const baseOpts = (cat) => [['none', 'NONE (FROM SCRATCH)'], ...BUILTIN_PARTS[cat].map((b) => [b.id, b.name.toUpperCase()])];
const COLORS = [0xff5a1f, 0x00e5ff, 0xff2a3d, 0x1f8fff, 0xb04dff, 0x7dff2e, 0xffe600, 0xff2fd0, 0xf2f2ff];

const CSS = `body.bkEditing > *:not(#bkEd) { display: none !important; }
#bkEd { position: fixed; inset: 0; z-index: 60; display: flex; background: #04070b; color: #cfe; font-family: 'Orbitron', monospace; font-size: 11px; letter-spacing: 1px; user-select: none; }
#bkEd .bkView { flex: 1; position: relative; min-width: 0; touch-action: none; cursor: grab; }
#bkEd .bkView canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; } /* beats the game's global canvas:not(#minimap) { position: fixed } */
#bkEd .bkTL, #bkEd .bkBL { position: absolute; left: 8px; display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
#bkEd .bkTL { top: 8px; } #bkEd .bkBL { bottom: 8px; }
#bkEd .bkSt { position: absolute; right: 8px; bottom: 8px; color: #8ab; text-align: right; max-width: 60%; font-size: 10px; }
#bkEd .bkSt.bad { color: #f88; } #bkEd .bkSt.ok { color: #7f7; }
#bkEd .bkSide { width: min(330px, 46vw); display: flex; flex-direction: column; border-left: 2px solid #0ff; box-shadow: 0 0 10px #0ff, inset 0 0 8px rgba(0,255,255,.25); background: rgba(0,16,26,.96); box-sizing: border-box; min-height: 0; }
#bkEd .bkSc { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 4px; overscroll-behavior: contain; }
#bkEd .bkBar { flex: none; padding: 5px 8px; border-top: 1px solid #0ff; background: rgba(0,10,16,.98); display: flex; flex-direction: column; gap: 4px; }
#bkEd b { color: var(--neon, #0ff); font-size: 10px; letter-spacing: 2px; margin-top: 4px; }
#bkEd .bkRow { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
#bkEd .bkRow.bkN { flex-wrap: nowrap; gap: 2px; }
#bkEd .mbtn { min-width: 0; min-height: 26px; padding: 1px 7px; font-size: 10px; letter-spacing: 1px; margin: 0; }
#bkEd .bkList { max-height: 92px; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 3px; border: 1px solid #357; padding: 3px; min-height: 18px; }
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
  let base = start.base, shapes = (validateShapes(cat, start.shapes).shapes || []).slice(), cur = shapes.length ? 0 : -1, mode = 'orbit', mult = 1, color = COLORS[0], loaded = item && item.id, dirty = false, dead = false;
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const root = el('div'); root.id = 'bkEd'; document.body.append(root); document.body.classList.add('bkEditing');
  const view = el('div', 'bkView'), wrap = el('div', 'bkSide'), side = el('div', 'bkSc'), bar = el('div', 'bkBar'); wrap.append(side, bar); root.append(view, wrap);
  const canvas = el('canvas'); view.append(canvas);
  const status = el('div', 'bkSt'); view.append(status);
  const say = (t, k) => { status.textContent = t || ''; status.className = 'bkSt' + (k ? ' ' + k : ''); };

  // ---- 3D preview ----
  const R = new THREE.WebGLRenderer({ canvas, antialias: true }); R.setClearColor(0x04070b);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, 1, 0.1, 80), K = 1.1; // K = bike scale
  const grid = new THREE.GridHelper(8, 32, 0x0a8a9a, 0x123040); scene.add(grid);
  const wheelCat = cat !== 'body', tgt = wheelCat ? new THREE.Vector3(0, 0.5 * K, 0.85 * K) : new THREE.Vector3(0, 1.0 * K, 0);
  const orb = { yaw: wheelCat ? 0.9 : 0.75, pitch: 0.28, dist: wheelCat ? 3.2 : 6.2 };
  let model = null, anchor = null, proxies = null, hl = null;
  const hlMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffdd33).multiplyScalar(2), wireframe: true, depthTest: false, transparent: true }), pxMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const twins = (sh) => (sh.mirror && Math.abs(sh.p[0]) > 0.001 ? [false, true] : [false]);
  function free() { if (!model) return; scene.remove(model.group); model.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); for (const m of model.mats) m.dispose(); model = null; }
  function rebuild() { // the model + the pick proxies + the selection outline
    dropShapeUnits(); free();
    model = makeBikeMesh(color, { [cat]: { base, shapes, custom: true } }); scene.add(model.group);
    anchor = wheelCat ? model.wheels[1] : model.group;
    proxies = new THREE.Group(); hl = new THREE.Group(); anchor.add(proxies, hl);
    shapes.forEach((sh, i) => { for (const mir of twins(sh)) { const p = placeShape(new THREE.Mesh(shapeGeom(sh.type), pxMat), sh, mir); p.visible = false; p.userData.i = i; proxies.add(p); if (i === cur) hl.add(placeShape(new THREE.Mesh(shapeGeom(sh.type), hlMat), sh, mir)); } });
    stat();
  }
  const stat = () => say(`${shapes.length}/${MAX_SHAPES} SHAPES${dirty ? ' - UNSAVED' : ''}`);
  const size = () => { const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return; R.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(size); ro.observe(view);
  let raf = 0, t0 = performance.now();
  (function loop() {
    if (dead) return; raf = requestAnimationFrame(loop);
    const t = performance.now(); hlMat.opacity = 0.55 + 0.45 * Math.sin((t - t0) / 160); // pulsing outline (never fully hidden)
    const cp = Math.cos(orb.pitch); cam.position.set(tgt.x + orb.dist * cp * Math.sin(orb.yaw), tgt.y + orb.dist * Math.sin(orb.pitch), tgt.z + orb.dist * cp * Math.cos(orb.yaw)); cam.lookAt(tgt);
    R.render(scene, cam);
  })();

  // ---- view input ----
  const ptrs = new Map(); let drag = null, pinch = 0;
  const rc = new THREE.Raycaster();
  function pick(e) {
    const r = canvas.getBoundingClientRect(); rc.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
    scene.updateMatrixWorld(true); const h = rc.intersectObjects(proxies.children, false)[0];
    if (h) choose(h.object.userData.i);
  }
  view.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    view.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, moved: false };
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); drag.moved = true; }
  });
  view.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const o = ptrs.get(e.pointerId), dx = e.clientX - o[0], dy = e.clientY - o[1]; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) orb.dist = Math.min(14, Math.max(0.8, orb.dist * pinch / d)); pinch = d; return; }
    if (!drag || (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5)) return;
    drag.moved = true;
    if (mode === 'move' && cur >= 0) { // move in the screen plane: world delta -> bike-local units
      const sc = 2 * orb.dist * Math.tan(cam.fov * Math.PI / 360) / view.clientHeight / K, m = cam.matrixWorld.elements;
      const sh = shapes[cur], d = [dx * m[0] - dy * m[4], dx * m[1] - dy * m[5], dx * m[2] - dy * m[6]].map((v) => v * sc);
      put({ p: sh.p.map((v, i) => v + d[i]) }, false);
    } else { orb.yaw -= dx * 0.008; orb.pitch = Math.min(1.5, Math.max(-0.2, orb.pitch + dy * 0.008)); }
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch = 0; if (drag && !drag.moved && e.type === 'pointerup' && !ptrs.size) pick(e); if (!ptrs.size) drag = null; };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', (e) => { e.preventDefault(); orb.dist = Math.min(14, Math.max(0.8, orb.dist * Math.exp(e.deltaY * 0.001))); }, { passive: false });

  // overlay controls
  const tl = el('div', 'bkTL'), bl = el('div', 'bkBL'); view.append(tl, bl);
  const modeBtns = { orbit: btn('ORBIT', '', () => setMode('orbit')), move: btn('MOVE SHAPE', '', () => setMode('move')) };
  const setMode = (m) => { mode = m; for (const k in modeBtns) modeBtns[k].classList.toggle('sel', k === m); say(m === 'move' ? 'DRAG MOVES THE SELECTED SHAPE ON SCREEN' : 'DRAG TO ORBIT, WHEEL / PINCH TO ZOOM, TAP A SHAPE TO SELECT'); };
  tl.append(modeBtns.orbit, modeBtns.move, btn('RESET VIEW', '', () => { orb.yaw = wheelCat ? 0.9 : 0.75; orb.pitch = 0.28; orb.dist = wheelCat ? 3.2 : 6.2; }));
  const sws = COLORS.map((c) => { const b = el('button', 'bkSw'); b.type = 'button'; b.style.background = '#' + c.toString(16).padStart(6, '0'); b.addEventListener('click', () => { color = c; sws.forEach((s, i) => s.classList.toggle('sel', COLORS[i] === c)); rebuild(); }); bl.append(b); return b; });
  sws[0].classList.add('sel');

  // ---- side panel ----
  const head = el('div', 'bkRow'); head.append(el('b', '', `${CATN[cat]} EDITOR${wheelCat ? ' (WHEEL SPACE, FRONT WHEEL SHOWN)' : ''}`)); side.append(head);
  const baseSel = sel(baseOpts(cat), base); baseSel.addEventListener('change', () => { base = baseSel.value; touch(); rebuild(); });
  const brow = el('div', 'bkRow'); brow.append(el('span', 'bkLab', 'BASE'), baseSel); side.append(brow);
  side.append(el('b', '', 'SHAPES')); const list = el('div', 'bkList'); side.append(list);
  const addRow = el('div', 'bkRow'); side.append(addRow);
  for (const t of SHAPE_TYPES) addRow.append(btn('+' + t.toUpperCase(), '', () => add(t)));
  const act = el('div', 'bkRow'); side.append(act);
  act.append(btn('DUPLICATE', '', () => { if (cur < 0) return; const s = shapes[cur]; add(null, { ...s, p: [s.p[0], s.p[1], s.p[2] + 0.12] }); }), btn('DELETE', 'danger', del));
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
  function choose(i) { cur = i; draw(); rebuild(); }
  function fields() { // selected shape -> inputs
    const s = shapes[cur]; for (const k in inputs) inputs[k].forEach((inp, i) => { inp.disabled = !s; if (s && document.activeElement !== inp) inp.value = r3(s[k][i]); });
    roleSel.disabled = mir.disabled = !s; if (s) { roleSel.value = s.role; mir.checked = s.mirror; }
  }
  function draw() { // shape list + fields
    list.textContent = ''; if (!shapes.length) list.append(el('span', '', 'NO SHAPES YET - ADD ONE BELOW'));
    shapes.forEach((s, i) => list.append(btn(`${i + 1} ${s.type.toUpperCase()}${s.mirror ? ' ⇄' : ''}`, i === cur ? 'sel' : '', () => choose(i))));
    fields();
  }
  function put(patch, redrawFields) { // change the selected shape (clamped by the shared validator)
    const s = shapes[cur]; if (!s) return; const n = cleanShape(cat, { ...s, ...patch }); if (!n) return;
    shapes[cur] = n; touch(); if (redrawFields) fields(); else for (const k in inputs) inputs[k].forEach((inp, i) => { if (document.activeElement !== inp) inp.value = r3(n[k][i]); }); rebuild();
    if (patch.mirror !== undefined) draw();
  }
  function add(type, from) {
    if (shapes.length >= MAX_SHAPES) return say(`MAX ${MAX_SHAPES} SHAPES`, 'bad');
    const s = cleanShape(cat, from || { type, p: wheelCat ? [0, 0.45, 0] : [0, 1, 0], r: [0, 0, 0], s: wheelCat ? [0.12, 0.12, 0.12] : [0.3, 0.3, 0.3], role: 'glow', mirror: false });
    shapes.push(s); cur = shapes.length - 1; touch(); draw(); rebuild(); list.scrollTop = 1e6;
  }
  function del() { if (cur < 0) return; shapes.splice(cur, 1); cur = Math.min(cur, shapes.length - 1); touch(); draw(); rebuild(); }

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
  const onKey = (e) => { if (e.code === 'Escape') { e.stopImmediatePropagation(); if (typing(e)) e.target.blur(); else close(); } else if (e.code === 'Delete' && !typing(e)) { e.stopImmediatePropagation(); del(); } };
  addEventListener('keydown', onKey, true);
  const onUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; addEventListener('beforeunload', onUnload);
  function close(force) {
    if (dirty && !force && !confirm('UNSAVED CHANGES WILL BE LOST. CLOSE THE EDITOR?')) return;
    dead = true; cancelAnimationFrame(raf); ro.disconnect(); removeEventListener('keydown', onKey, true); removeEventListener('beforeunload', onUnload);
    free(); R.dispose(); hlMat.dispose(); pxMat.dispose(); grid.geometry.dispose(); root.remove(); st.remove(); document.body.classList.remove('bkEditing'); onClose();
  }
  setMode('orbit'); draw(); rebuild(); size();
  return { close: () => close(true), state: () => ({ base, shapes, cur }), add, choose, put };
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
