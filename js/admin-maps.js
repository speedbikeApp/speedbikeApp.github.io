// ADMIN > MAPS tab: pick / create / delete custom maps, then a full-screen 3D editor (free camera, floating TOOLS + SETTINGS windows).
// Server ops (server/admin-maps.js): mapList, mapGet {id}, mapSave {id?, map}, mapDelete {id}. Pure maths + validation: js/mapdef.js (also run by the server).
// Editor controls: WASD move (relative to the view), Space up, Shift down, hold LEFT mouse + drag = look (PLATFORM tool: drag draws, Alt+drag looks),
// RIGHT click = select object under the mouse, Del = delete selected, Esc = close. DOM + three only; the render loop is render.js (setEditorView).
import * as THREE from 'three';
import { registerAdminTab, ADMIN_ERR } from './admin-core.js';
import { scene, camera, setEditorView, makeBikeMesh } from './render.js';
import { MAPS, groundAt } from './maps.js';
import { spawnPoints } from './state.js';
import { validateMap, rayBox, rectPlatform, groundHit, pickObject, platformBox, spawnBox, dirOfYaw, yawOfDir, platformCorners, LIM } from './mapdef.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const errText = (r) => r.why || ADMIN_ERR[r.code] || { bad_map: 'INVALID MAP', too_many: 'TOO MANY MAPS (MAX 100)', bad_id: 'BAD MAP', not_found: 'MAP NOT FOUND' }[r.code] || String(r.code || 'ERROR').toUpperCase();
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const DEG = 180 / Math.PI;

export function newMap(name, template) {
  if (template && MAPS[template]) { // copy of a built-in map
    const m = JSON.parse(JSON.stringify(MAPS[template]));
    m.spawns = spawnPoints(4, m).map((s) => ({ x: s.x, z: s.z, dx: s.dx, dz: s.dz, y: s.y || 0 }));
    return { name, walls: false, half: m.half, killY: m.killY, platforms: m.platforms, spawns: m.spawns };
  }
  const R = 18;
  return { name, walls: false, half: 36, killY: -14, platforms: [{ x0: -30, z0: -30, x1: 30, z1: 30, y: 0 }],
    spawns: [{ x: 0, z: R, dx: 0, dz: -1, y: 0 }, { x: -R, z: 0, dx: 1, dz: 0, y: 0 }, { x: 0, z: -R, dx: 0, dz: 1, y: 0 }, { x: R, z: 0, dx: -1, dz: 0, y: 0 }] };
}

/** Arena size must cover every platform corner. */
export function fitHalf(m) { let e = 0; for (const p of m.platforms) for (const [x, z] of platformCorners(p)) e = Math.max(e, Math.abs(x), Math.abs(z)); m.half = Math.min(LIM.maxHalf, Math.max(m.half, LIM.minHalf, Math.ceil(e / 3) * 3)); }

const CSS = `body.mapEditing > *:not(canvas):not(#mapEd) { display: none !important; }
#mapEd { position: fixed; inset: 0; z-index: 50; user-select: none; touch-action: none; cursor: crosshair; font-size: 12px; letter-spacing: 1px; color: #cfe; }
#mapEd .win { position: absolute; background: rgba(0,16,26,.88); border: 1px solid #0ff; box-shadow: 0 0 12px #0ff4; cursor: default; padding: 0 8px 8px; max-height: 80vh; overflow-y: auto; }
#mapEd .win > h4 { margin: 0 -8px 6px; padding: 4px 8px; background: #0ff3; cursor: move; font-size: 11px; letter-spacing: 3px; color: #fff; }
#mapEd .win label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 3px 0; }
#mapEd .win input { width: 84px; background: #012; color: #fff; border: 1px solid #357; padding: 3px 5px; font: inherit; }
#mapEd .win input[type=text] { width: 120px; } #mapEd .win input:disabled { opacity: .5; }
#mapEd .win .mbtn { min-width: 0; min-height: 28px; padding: 2px 8px; font-size: 12px; letter-spacing: 1px; margin: 2px 2px 2px 0; }
#mapEd .win .mbtn.sel { background: rgba(0,255,255,.4); color: #fff; border-color: #fff; }
#mapEd .win b { display: block; margin: 8px 0 2px; color: var(--neon, #0ff); font-size: 11px; letter-spacing: 2px; }
#mapEdBar { position: absolute; left: 0; right: 0; bottom: 0; padding: 6px 12px; background: rgba(0,10,16,.8); cursor: default; display: flex; gap: 14px; flex-wrap: wrap; }
#mapEdBar .bad { color: #f88; } #mapEdBar .ok { color: #7f7; } #mapEdBar .hint { color: #8ab; }`;

/** Open the editor on `def` (working copy, mutated in place). onClose(savedId|null) after it closes. */
function openEditor({ def, id, call, onClose }) {
  const m = def;
  let curId = id, dirty = false, tool = 'select', sel = null, newY = 0, spawnsDirty = true, drag = null;
  const keys = new Set(), view = { map: m, dirty: true, frame };
  const cam = { x: 0, y: Math.max(40, m.half * 0.9), z: m.half * 0.9, yaw: 0, pitch: -0.75 };
  const st = el('style'); st.textContent = CSS; document.head.append(st);
  const root = el('div'); root.id = 'mapEd'; document.body.append(root); document.body.classList.add('mapEditing');
  const win = (title, x, y) => { const w = el('div', 'win'), h = el('h4', '', title); w.style.left = x; w.style.top = y; w.append(h); root.append(w);
    let o = null; h.addEventListener('pointerdown', (e) => { o = [e.clientX - w.offsetLeft, e.clientY - w.offsetTop]; h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointermove', (e) => { if (o) { w.style.left = Math.max(0, e.clientX - o[0]) + 'px'; w.style.top = Math.max(0, e.clientY - o[1]) + 'px'; } });
    h.addEventListener('pointerup', () => { o = null; }); return w; };
  const tools = win('TOOLS', '12px', '12px'), setw = win('SETTINGS', 'calc(100vw - 260px)', '12px'), bar = el('div'); bar.id = 'mapEdBar'; root.append(bar);
  const status = el('span'), hint = el('span', 'hint', 'WASD MOVE | SPACE UP | SHIFT DOWN | HOLD LEFT MOUSE: LOOK | RIGHT CLICK: SELECT | DEL: DELETE | ESC: CLOSE');
  bar.append(status, hint);
  const say = (t, k) => { status.textContent = t; status.className = k || ''; };

  // ---- scene extras: spawn bikes, selection box, platform drag preview ----
  const extras = new THREE.Group(); scene.add(extras);
  const spawnG = new THREE.Group(); extras.add(spawnG);
  const selBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: new THREE.Color(0xffdd33).multiplyScalar(2) })); selBox.visible = false; extras.add(selBox);
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.35, depthWrite: false })); ghost.visible = false; extras.add(ghost);
  const freeSpawn = (g) => { for (const mt of g.userData.mats) mt.dispose(); g.userData.arrow.dispose(); }; // bike geometries are shared / cached: never disposed
  function rebuildSpawns() {
    for (const c of [...spawnG.children]) { spawnG.remove(c); freeSpawn(c); }
    m.spawns.forEach((s, i) => {
      const { group, mats } = makeBikeMesh(0xffffff); const g = new THREE.Group();
      group.rotation.y = yawOfDir(s.dx, s.dz); g.add(group); g.position.set(s.x, s.y, s.z);
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(s.dx, 0, s.dz), new THREE.Vector3(0, 1, 0), 5, 0xffffff, 1.2, 0.8); g.add(arrow);
      g.userData = { mats, arrow }; spawnG.add(g);
    });
    spawnsDirty = false;
  }
  function syncSel() {
    selBox.visible = !!sel;
    if (!sel) return;
    const b = sel.kind === 'platform' ? platformBox(m.platforms[sel.index]) : spawnBox(m.spawns[sel.index]);
    selBox.position.set(b.cx, b.cy, b.cz); selBox.scale.set(b.hx * 2 + 0.2, b.hy * 2 + 0.2, b.hz * 2 + 0.2); selBox.rotation.y = b.rot;
  }
  function frame(dt) {
    const K = (c) => (keys.has(c) ? 1 : 0), sp = 26 * dt, s = Math.sin(cam.yaw), c = Math.cos(cam.yaw);
    const fw = K('KeyW') - K('KeyS'), rt = K('KeyD') - K('KeyA');
    cam.x += (-s * fw + c * rt) * sp; cam.z += (-c * fw - s * rt) * sp; cam.y += (K('Space') - K('ShiftLeft') - K('ShiftRight')) * sp;
    camera.position.set(cam.x, cam.y, cam.z); camera.rotation.order = 'YXZ'; camera.rotation.set(cam.pitch, cam.yaw, 0); camera.updateMatrixWorld();
    if (spawnsDirty) rebuildSpawns();
    syncSel();
  }
  setEditorView(view);

  // ---- model changes ----
  function resyncSpawnY() { for (const s of m.spawns) { const y = groundAt(m, s.x, s.z); if (y > -Infinity) s.y = y; } }
  function check() { fitHalf(m); const v = validateMap(m); say(v.ok ? 'MAP OK' : 'PROBLEM: ' + v.why, v.ok ? 'ok' : 'bad'); return v; }
  function changed() { dirty = true; view.dirty = true; resyncSpawnY(); spawnsDirty = true; check(); }
  const select = (s) => { sel = s; buildSettings(); };

  // ---- TOOLS window ----
  const toolBtns = {};
  for (const [t, label] of [['select', 'SELECT'], ['platform', 'PLATFORM'], ['spawn', 'SPAWN']]) { toolBtns[t] = btn(label, '', () => setTool(t)); tools.append(toolBtns[t]); }
  const setTool = (t) => { tool = t; for (const k in toolBtns) toolBtns[k].classList.toggle('sel', k === t); say(t === 'platform' ? 'DRAG ON THE GROUND TO SIZE A PLATFORM (ALT+DRAG = LOOK)' : t === 'spawn' ? 'CLICK A PLATFORM TO PLACE A SPAWN POINT' : 'RIGHT CLICK AN OBJECT TO SELECT IT'); };
  const del = () => {
    if (!sel) return;
    if (sel.kind === 'spawn' && m.spawns.length <= LIM.minSpawns) return say(`MIN ${LIM.minSpawns} SPAWN POINTS`, 'bad');
    if (sel.kind === 'platform' && m.platforms.length <= 1) return say('MIN 1 PLATFORM', 'bad');
    (sel.kind === 'platform' ? m.platforms : m.spawns).splice(sel.index, 1); select(null); changed();
  };
  tools.append(btn('DELETE', 'danger', del));
  const hl = el('label', '', 'NEW HEIGHT'), hi = el('input'); hi.type = 'number'; hi.step = 0.25; hi.value = newY; hi.addEventListener('input', () => { const v = Number(hi.value); if (hi.value !== '' && Number.isFinite(v)) newY = v; }); hl.append(hi); tools.append(hl);
  const saveBtn = btn('SAVE', 'primary', save), closeBtn = btn('CLOSE', '', () => close()); tools.append(el('b', '', 'MAP'), saveBtn, closeBtn);

  // ---- SETTINGS window ----
  function field(parent, label, get, set, o = {}) {
    const l = el('label', '', label), i = el('input'); i.type = o.text ? 'text' : 'number'; if (!o.text) i.step = o.step || 1; i.value = o.text ? get() : r4(get()); if (o.max) i.maxLength = o.max; i.disabled = !!o.ro;
    i.addEventListener('input', () => { if (o.text) { set(i.value); changed(); return; } const v = Number(i.value); if (i.value !== '' && Number.isFinite(v)) { set(v); changed(); } });
    if (o.snap) i.addEventListener('change', () => { i.value = r4(get()); });
    l.append(i); parent.append(l); return i;
  }
  function buildSettings() {
    for (const c of [...setw.children].slice(1)) c.remove();
    if (sel && sel.kind === 'platform') {
      const p = m.platforms[sel.index], w = () => p.x1 - p.x0, d = () => p.z1 - p.z0, cx = () => (p.x0 + p.x1) / 2, cz = () => (p.z0 + p.z1) / 2;
      setw.append(el('b', '', 'PLATFORM ' + (sel.index + 1)));
      field(setw, 'X', cx, (v) => { const h = w() / 2; p.x0 = r4(v - h); p.x1 = r4(v + h); });
      field(setw, 'Y (HEIGHT)', () => p.y, (v) => { p.y = v; }, { step: 0.25 });
      field(setw, 'Z', cz, (v) => { const h = d() / 2; p.z0 = r4(v - h); p.z1 = r4(v + h); });
      field(setw, 'WIDTH', w, (v) => { if (v > 0) { const c = cx(); p.x0 = r4(c - v / 2); p.x1 = r4(c + v / 2); } });
      field(setw, 'DEPTH', d, (v) => { if (v > 0) { const c = cz(); p.z0 = r4(c - v / 2); p.z1 = r4(c + v / 2); } });
      field(setw, 'ROTATION (DEG)', () => (p.rot || 0) * DEG, (v) => { p.rot = v / DEG; if (!p.rot) delete p.rot; }, { step: 5 });
    } else if (sel) {
      const s = m.spawns[sel.index];
      setw.append(el('b', '', 'SPAWN POINT ' + (sel.index + 1)));
      field(setw, 'X', () => s.x, (v) => { s.x = v; });
      field(setw, 'Y (FROM PLATFORM)', () => s.y, () => {}, { ro: true });
      field(setw, 'Z', () => s.z, (v) => { s.z = v; });
      field(setw, 'FACING (DEG, 90 STEPS)', () => yawOfDir(s.dx, s.dz) * DEG, (v) => { const d = dirOfYaw(v / DEG); s.dx = d.dx; s.dz = d.dz; }, { step: 90, snap: true });
    } else setw.append(el('b', '', 'NOTHING SELECTED'));
    setw.append(el('b', '', 'MAP'));
    field(setw, 'NAME', () => m.name, (v) => { m.name = v; }, { text: true, max: LIM.name });
    field(setw, 'ARENA SIZE (HALF)', () => m.half, (v) => { m.half = v; }, { step: 3 });
    field(setw, 'KILL HEIGHT', () => m.killY, (v) => { m.killY = v; });
    setw.append(el('div', 'hint', `${m.platforms.length}/${LIM.platforms} PLATFORMS | ${m.spawns.length}/${LIM.maxSpawns} SPAWNS`));
  }

  // ---- mouse ----
  const rc = new THREE.Raycaster();
  const rayOf = (e) => { rc.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera); return [rc.ray.origin.toArray(), rc.ray.direction.toArray()]; };
  const pickAt = (e) => { const [o, d] = rayOf(e); select(pickObject(m, o, d)); };
  function placeSpawn(e) {
    if (m.spawns.length >= LIM.maxSpawns) return say(`MAX ${LIM.maxSpawns} SPAWN POINTS`, 'bad');
    const [o, d] = rayOf(e);
    let best = Infinity; for (const p of m.platforms) { const t = rayBox(o, d, platformBox(p)); if (t !== null && t < best) best = t; }
    let x, z; if (best < Infinity) { x = o[0] + d[0] * best; z = o[2] + d[2] * best; } else { const g = groundHit(o, d, newY); if (!g) return; [x, z] = g; }
    const last = m.spawns[m.spawns.length - 1] || { dx: 0, dz: -1 };
    m.spawns.push({ x: Math.round(x * 2) / 2, z: Math.round(z * 2) / 2, dx: last.dx, dz: last.dz, y: newY }); changed(); select({ kind: 'spawn', index: m.spawns.length - 1 });
  }
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('pointerdown', (e) => {
    if (e.target !== root) return;
    root.setPointerCapture(e.pointerId);
    if (e.button === 2) return pickAt(e);
    if (e.button !== 0 && e.button !== 1) return;
    const look = e.button === 1 || e.altKey || tool !== 'platform';
    drag = { look, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, a: null, b: null };
    if (!look) { const [o, d] = rayOf(e); drag.a = groundHit(o, d, newY); }
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.look) {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      drag.moved = true; cam.yaw -= (e.clientX - drag.lx) * 0.005; cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - (e.clientY - drag.ly) * 0.005)); drag.lx = e.clientX; drag.ly = e.clientY;
    } else if (drag.a) {
      const [o, d] = rayOf(e); drag.b = groundHit(o, d, newY);
      const p = drag.b && { x0: Math.min(drag.a[0], drag.b[0]), x1: Math.max(drag.a[0], drag.b[0]), z0: Math.min(drag.a[1], drag.b[1]), z1: Math.max(drag.a[1], drag.b[1]) };
      ghost.visible = !!p; if (p) { ghost.scale.set(Math.max(0.1, p.x1 - p.x0), 0.3, Math.max(0.1, p.z1 - p.z0)); ghost.position.set((p.x0 + p.x1) / 2, newY + 0.15, (p.z0 + p.z1) / 2); }
    }
  });
  const up = (e) => {
    if (!drag) return; const dg = drag; drag = null; ghost.visible = false;
    if (e.type === 'pointercancel') return;
    if (!dg.look && dg.a && dg.b) {
      const p = rectPlatform(dg.a[0], dg.a[1], dg.b[0], dg.b[1], newY, 1);
      if (!p) return say(`TOO SMALL (MIN ${LIM.minSize} UNITS)`, 'bad');
      if (m.platforms.length >= LIM.platforms) return say(`MAX ${LIM.platforms} PLATFORMS`, 'bad');
      m.platforms.push(p); changed(); select({ kind: 'platform', index: m.platforms.length - 1 });
    } else if (dg.look && !dg.moved && e.button === 0) { if (tool === 'spawn') placeSpawn(e); else if (tool === 'select') pickAt(e); }
  };
  root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);

  // ---- keys (capture: the game's own input handlers must not see them) ----
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const onKey = (e) => {
    if (e.code === 'Escape' && e.type === 'keydown') { e.preventDefault(); e.stopImmediatePropagation(); if (typing(e)) e.target.blur(); else close(); return; }
    if (typing(e)) { e.stopImmediatePropagation(); return; }
    e.stopImmediatePropagation();
    if (e.type === 'keyup') return void keys.delete(e.code);
    if (e.code === 'Delete' || e.code === 'Backspace') del(); else if (!e.ctrlKey && !e.metaKey) { keys.add(e.code); if (e.code === 'Space') e.preventDefault(); }
  };
  addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true);
  const onBlur = () => keys.clear(); addEventListener('blur', onBlur);
  const onUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; addEventListener('beforeunload', onUnload);

  // ---- save / close ----
  async function save() {
    const v = check();
    if (!v.ok) return;
    saveBtn.disabled = true; say('SAVING...');
    const r = await call('mapSave', { ...(curId ? { id: curId } : {}), map: m });
    saveBtn.disabled = false;
    if (!r.ok) return say(errText(r), 'bad');
    curId = r.mapId; Object.assign(m, r.map); dirty = false; view.dirty = true; spawnsDirty = true; buildSettings(); say('SAVED', 'ok');
  }
  function close(force) {
    if (dirty && !force && !confirm('UNSAVED CHANGES WILL BE LOST. CLOSE THE EDITOR?')) return;
    removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKey, true); removeEventListener('blur', onBlur); removeEventListener('beforeunload', onUnload);
    setEditorView(null); scene.remove(extras);
    for (const g of spawnG.children) freeSpawn(g);
    for (const o of [selBox, ghost]) { o.geometry.dispose(); o.material.dispose(); }
    root.remove(); st.remove(); document.body.classList.remove('mapEditing');
    onClose(curId);
  }
  setTool('select'); buildSettings(); check();
  return { close: () => close(true) };
}

function mountMaps(root, { call, toast }) {
  const msg = el('div', 'adMsg'), body = el('div'); let editor = null, dead = false;
  root.append(msg, body);
  const say = (t, k) => toast(msg, t, k);

  async function landing() {
    body.textContent = ''; say('');
    const mk = el('div', 'adSec'), ed = el('div', 'adSec');
    mk.append(el('b', '', 'CREATE NEW'));
    const line = el('div', 'adLine'), name = el('input', 'wide'), tpl = el('select');
    name.maxLength = LIM.name; name.placeholder = 'MAP NAME (REQUIRED)'; name.autocomplete = 'off'; name.spellcheck = false;
    tpl.append(new Option('EMPTY MAP', '')); for (const k of Object.keys(MAPS)) tpl.append(new Option('COPY OF ' + MAPS[k].name, k));
    line.append(name, tpl, btn('CREATE', 'primary', () => {
      const n = name.value.trim(); if (!/^[A-Za-z0-9 _-]{1,20}$/.test(n)) return say('NAME: 1-20 LETTERS, NUMBERS, SPACE _ -', 'bad');
      edit(newMap(n, tpl.value), null);
    }));
    mk.append(line);
    ed.append(el('b', '', 'EDIT EXISTING'));
    const list = el('div'); ed.append(list); body.append(mk, ed);
    list.append(el('div', 'frEmpty', 'LOADING...'));
    const r = await call('mapList', {});
    if (dead) return;
    list.textContent = '';
    if (!r.ok) return say(errText(r), 'bad');
    if (!r.maps.length) list.append(el('div', 'frEmpty', 'NO CUSTOM MAPS YET'));
    for (const mp of r.maps) {
      const row = el('div', 'adLine');
      row.append(el('span', '', `${mp.name}  (${mp.platforms} PLATFORMS, ${mp.spawns} SPAWNS)`), btn('OPEN', 'primary', async () => {
        say('...'); const g = await call('mapGet', { id: mp.id }); if (!g.ok) return say(errText(g), 'bad');
        edit({ ...g.map }, mp.id);
      }), btn('DELETE', 'danger', async () => {
        if (!confirm(`DELETE MAP "${mp.name}"? THIS CANNOT BE UNDONE.`)) return;
        const d = await call('mapDelete', { id: mp.id }); if (!d.ok) return say(errText(d), 'bad');
        say('DELETED', 'ok'); landing();
      }));
      list.append(row);
    }
  }
  function edit(def, id) { editor = openEditor({ def, id, call, onClose: () => { editor = null; if (!dead) landing(); } }); }
  landing();
  return () => { dead = true; if (editor) editor.close(); };
}
registerAdminTab('maps', 'MAPS', mountMaps);
