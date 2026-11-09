// Menu screens (main / mode select / settings) + pause-panel buttons. DOM only; game flow is injected by main.js.
// Settings are applied live (render + audio) and persisted through save.js.
import { CFG } from './config.js';
import { abilityIcon } from './icons.js';
import { getSave, setSetting, setUsername, saveSoon, buyAbility, buyInfinite, abilityCharges, infinitePrice, STACK_MAX, toggleEquip, buyPart, equipPart, partOwned } from './save.js';
import { CATS, CAT_LABEL, partList, getPart, glowHex, isShown, DEFAULT_PARTS } from './parts.js';
import { ACHIEVEMENTS, getAchievement, achValue, achProgress } from './achievements.js';
import { ABILITIES, ABILITY_IDS } from './abilities.js';
import { setBloom, setMaxDpr, initPreview, setPreviewParts, drawPreview } from './render.js';
import { MAPS } from './maps.js';
import { CUSTOM } from './custommaps.js';
import { MODES } from './modes.js';
import * as audio from './audio.js';
import { setPlayerName } from './hud.js';
import * as tutorial from './tutorial.js';
import { initAccountUi, openAccount, accountEsc, isSignedIn } from './account-ui.js';
import { initMultiUi, onScreen as multiScreen, multiBack } from './multi-ui.js';
import { initFriendsUi, onScreen as friendsScreen } from './friends-ui.js';
import { initAdminUi, onScreen as adminScreen } from './admin-ui.js';
import { initPartyUi } from './party-ui.js';
import { ACTIONS, ACTION_LABEL, groups, codeLabel, rebind, defaultKeys, setBindings, getBindings, captureNextKey, GAMEPAD_LAYOUT } from './input.js';

const $ = (id) => document.getElementById(id);
let current = null;      // visible screen id or null
let settingsFrom = null; // 'main' | 'pause'

const SCREENS = ['scrMain', 'scrPlay', 'scrMode', 'scrMapSel', 'scrMulti', 'scrQueue', 'scrLobby', 'scrFriends', 'scrAbilities', 'scrGarage', 'scrStats', 'scrAccount', 'scrAdmin', 'scrSettings', 'scrControls'];
const FULL_MENU = ['scrMain', 'scrPlay', 'scrMode', 'scrMapSel', 'scrMulti', 'scrQueue', 'scrLobby', 'scrFriends', 'scrAbilities', 'scrGarage', 'scrStats', 'scrAccount', 'scrAdmin']; // screens shown over the empty arena (HUD hidden)
export function showScreen(name, backdrop = 'home') {
  tutorial.syncColor(); name = tutorial.gateScreen(name, tutorial.stage()); // tutorial stages lock the menu paths
  current = name;
  $('menu').style.display = name ? 'flex' : 'none';
  $('menu').className = backdrop; // 'home' (3D visible) | 'dim' (over the paused game)
  for (const id of SCREENS) $(id).classList.toggle('on', id === name);
  document.body.classList.toggle('menu', FULL_MENU.includes(name) || ((name === 'scrSettings' || name === 'scrControls') && settingsFrom === 'main'));
  if (name === 'scrMain') {
    $('mCoins').textContent = getSave().coins; $('mName').textContent = getSave().profile.username;
    const tb = tutorial.menuButton(isSignedIn()); // TUTORIAL replaces PLAY as the bold button
    $('mTut').hidden = !tb; $('mPlay').classList.toggle('primary', !tb); $('mPlay').classList.toggle('pulse', !!tutorial.matchStage());
  }
  if (name === 'scrMode') { syncDiff(); $('mSelMapName').textContent = mapLabel(getSave().settings.spMap); }
  if (name === 'scrMapSel') { MS_IDS = ['random', ...Object.keys(MAPS), ...customIds()]; msIdx = Math.max(0, MS_IDS.indexOf(getSave().settings.spMap)); syncMapSel(); }
  if (onMapPreview) onMapPreview(name === 'scrMapSel' ? MS_IDS[msIdx] : null);
  if (name === 'scrAbilities') renderAbilities('');
  if (name === 'scrGarage') openGarage();
  else stopPreview();
  if (name === 'scrStats') renderStats();
  if (name === 'scrAccount') openAccount();
  if (name === 'scrMulti' || name === 'scrQueue' || name === 'scrLobby') multiScreen(name);
  if (name === 'scrFriends') friendsScreen();
  if (name === 'scrAdmin') adminScreen();
  if (name === 'scrSettings') syncSettingsUi();
  if (name !== 'scrControls') cancelCapture();
  if (name === 'scrControls') renderControls('');
  tutorial.refresh(name);
}
export const currentScreen = () => current;

// Push saved settings into render / audio. Call once at startup.
export function applySettings() {
  const s = getSave().settings;
  setBloom(s.bloom);
  CFG.camera.fov = s.fov; // render.js reads it every frame
  setMaxDpr(CFG.quality[s.quality]);
  audio.setMasterVolume(s.masterVol); audio.setMusicVolume(s.musicVol); audio.setSfxVolume(s.sfxVol); audio.setMuted(s.muted); audio.setEngineVolume(s.engineVol);
  setBindings(s.keys);
  setPlayerName(getSave().profile.username);
}

// ABILITIES screen: buy with SBCoins, equip / unequip into the limited slots.
function renderAbilities(msg) {
  const d = getSave(), own = d.unlocks.abilities, eq = d.equipped.abilities;
  $('abHead').textContent = `SBCOINS ${d.coins}   SLOTS ${eq.length}/${CFG.abilities.maxSlots}`;
  $('abMsg').textContent = msg;
  $('abList').innerHTML = ABILITY_IDS.map((id) => {
    const a = ABILITIES[id], owned = own.includes(id), on = eq.includes(id), n = abilityCharges(id), free = a.price === 0;
    const cnt = n === Infinity ? '<span class="star">✪</span>' : 'x' + n;
    const dim = (p) => (d.coins < p ? ' style="opacity:.55"' : '');
    let buy = '';
    if (!free && n === Infinity) buy = '';
    else if (!free) { // BUY ✪ always shown, dimmed until 99 charges (click below 99 says NEED 99 CHARGES FIRST)
      const p = infinitePrice(id);
      buy = (n < STACK_MAX ? `<button class="mbtn frame" type="button" data-id="${id}" data-act="buy"${dim(a.price)}>BUY +1 <span class="coins">${a.price}</span></button>` : '')
        + `<button class="mbtn frame" type="button" data-id="${id}" data-act="inf"${n < STACK_MAX ? ' style="opacity:.55"' : dim(p)}>BUY <span class="star">✪</span> <span class="coins">${p}</span></button>`;
    }
    const eqBtn = owned ? `<button class="mbtn frame${on ? ' sel' : ''}" type="button" data-id="${id}" data-act="eq">${on ? 'EQUIPPED' : 'EQUIP'}</button>` : '';
    const kind = a.type === 'passive' ? 'PASSIVE - 1 PER MATCH' : a.once ? 'ACTIVE - 1 PER USE' : 'ACTIVE';
    return `<div class="abItem frame${on ? ' eq' : ''}"${on && n < 1 ? ' style="opacity:.6"' : ''}>${abilityIcon(id)}<p>${a.desc}</p>${buy}${eqBtn}<b>${a.name.toUpperCase()}</b><span class="tag">${kind}${free ? ' - FREE' : ' - ' + cnt}</span></div>`;
  }).join('');
}
// ---- GARAGE: category tabs, part cards (preview on select), buy / equip. 3D preview = separate small renderer. ----
let gCat = 'body', gSel = null, gPreview = null, gRaf = 0, gLast = 0, gInit = false;
const unlockText = (p) => { const a = p.ach && getAchievement(p.ach); return a ? a.desc : ''; };
const swatch = (p) => (p.color ? `<i class="sw" style="background:#${p.color.toString(16).padStart(6, '0')}"></i>` : '');
function previewParts() { const eq = getSave().equipped.parts; return { ...eq, ...(gPreview || {}) }; }
function openGarage() {
  if (!gInit) { initPreview($('gCanvas')); gInit = true; }
  const forced = tutorial.stage() === 'color'; // tutorial: only the cyan colour, nothing else
  gCat = forced ? 'glow' : 'body'; gSel = forced ? 'cyan' : null; gPreview = null;
  renderGarage('');
  gLast = performance.now();
  const loop = (now) => { drawPreview(Math.min(0.1, (now - gLast) / 1000)); gLast = now; gRaf = requestAnimationFrame(loop); };
  cancelAnimationFrame(gRaf); gRaf = requestAnimationFrame(loop);
}
function stopPreview() { cancelAnimationFrame(gRaf); gRaf = 0; }
function renderGarage(msg) {
  const d = getSave(), eqId = d.equipped.parts[gCat];
  if (!gSel || !getPart(gCat, gSel)) gSel = getPart(gCat, eqId) ? eqId : DEFAULT_PARTS[gCat]; // equipped custom id not in the catalog (yet): show the default
  $('gHead').textContent = `SBCOINS ${d.coins}`;
  $('gMsg').textContent = msg;
  for (const b of $('gTabs').children) b.classList.toggle('sel', b.dataset.cat === gCat);
  $('gList').innerHTML = partList(gCat).filter((p) => isShown(p, partOwned(gCat, p.id)) && (tutorial.stage() !== 'color' || p.id === 'cyan')).map((p) => {
    const owned = partOwned(gCat, p.id), tag = p.id === eqId ? 'EQUIPPED' : owned ? 'OWNED' : p.ach ? 'LOCKED' : `${p.price}`;
    return `<button class="mbtn frame gcard${p.id === gSel ? ' sel' : ''}${owned ? '' : ' locked'}" type="button" data-id="${p.id}">${swatch(p)}<b>${p.name.toUpperCase()}</b><small class="${owned || p.ach ? '' : 'coins'}">${tag}</small></button>`;
  }).join('');
  const p = getPart(gCat, gSel), owned = partOwned(gCat, gSel), eqd = gSel === eqId;
  const act = $('gAct');
  act.dataset.act = owned ? 'equip' : p.ach ? '' : 'buy';
  act.disabled = eqd || (!owned && !!p.ach);
  act.classList.toggle('dim', !owned && !p.ach && d.coins < p.price);
  act.innerHTML = eqd ? 'EQUIPPED' : owned ? 'EQUIP' : p.ach ? 'LOCKED' : `BUY <span class="coins">${p.price}</span>`;
  $('gInfo').textContent = `${p.name.toUpperCase()}${owned ? '' : p.ach ? ' - ' + unlockText(p).toUpperCase() : ` - ${p.price} SBCOINS`}`;
  gPreview = { [gCat]: gSel };
  setPreviewParts(previewParts());
}
const G_MSG = { coins: 'NOT ENOUGH SBCOINS', ach: 'EARN THE ACHIEVEMENT TO UNLOCK' };

// ---- STATS ----
const fmt = (n) => Math.floor(n).toLocaleString('en-US');
function renderStats() {
  const d = getSave(), st = d.stats, pctWin = st.matches ? Math.round((st.wins / st.matches) * 100) : 0;
  const cells = [['MATCHES', st.matches], ['WINS', st.wins], ['WIN %', pctWin + '%'], ['STREAK', st.winStreak], ['BEST STREAK', st.bestStreak],
    ['KILLS', st.kills], ['DISTANCE', fmt(st.distance)], ['BOOSTS', st.boosts], ['JUMPS', st.jumps], ['SBCOINS', d.coins]];
  $('stGrid').innerHTML = cells.map(([k, v]) => `<div class="stCell frame"><small>${k}</small><b>${v}</b></div>`).join('');
  const own = new Set(d.unlocks.achievements);
  $('stAch').innerHTML = ACHIEVEMENTS.map((a) => {
    const done = own.has(a.id), p = done ? 1 : achProgress(a, st), r = getPart(a.reward.cat, a.reward.id);
    return `<div class="achRow frame${done ? ' done' : ''}"><div><b>${a.name.toUpperCase()}</b> <span class="tag">${done ? 'UNLOCKED' : fmt(Math.min(achValue(a, st), a.target)) + ' / ' + fmt(a.target)}</span></div>
      <small>${a.desc} - reward: ${r.name} ${CAT_LABEL[a.reward.cat].toLowerCase()}</small><div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div></div>`;
  }).join('');
  $('stSum').textContent = `ACHIEVEMENTS ${own.size}/${ACHIEVEMENTS.length}`;
}
const AB_MSG = { max: 'AT 99 - BUY INFINITE', need99: 'NEED 99 CHARGES FIRST', owned: 'ALREADY UNLIMITED', coins: 'NOT ENOUGH SBCOINS', full: 'ALL SLOTS FULL - UNEQUIP ONE FIRST' };

// ---- single-player MAP SELECT: RANDOM + built-in maps; main.js shows the preview (onMapPreview(id|'random'|null)) ----
const customIds = () => Object.keys(CUSTOM).sort((a, b) => CUSTOM[a].name.localeCompare(CUSTOM[b].name));
let MS_IDS = ['random', ...Object.keys(MAPS)]; // rebuilt each time the screen opens (custom maps load in the background)
const mapLabel = (id) => (id === 'random' ? 'RANDOM' : (MAPS[id] || CUSTOM[id] || { name: 'RANDOM' }).name); // unknown (not loaded / deleted) -> random at match start
let msIdx = 0, onMapPreview = null;
function syncMapSel() {
  $('msName').textContent = mapLabel(MS_IDS[msIdx]);
  const c = CUSTOM[MS_IDS[msIdx]];
  $('msHint').textContent = c ? 'CUSTOM MAP: ' + c.modes.map((k) => MODES[k].label).join(' / ') : MS_IDS[msIdx] === 'random' ? 'A RANDOM MAP EACH MATCH' : '3D / HYPER USE ONLY THEIR OWN MAPS';
}
function stepMap(d) {
  msIdx = (msIdx + d + MS_IDS.length) % MS_IDS.length; syncMapSel();
  if (onMapPreview) onMapPreview(MS_IDS[msIdx]);
}
function syncDiff() {
  const d = getSave().settings.aiDifficulty;
  for (const b of $('diffRow').children) b.classList.toggle('sel', +b.dataset.diff === d);
}
const pct = (v) => Math.round(v * 100);
function syncSettingsUi() {
  const s = getSave().settings;
  $('sName').value = getSave().profile.username;
  $('sName').disabled = isSignedIn(); $('sName').title = isSignedIn() ? 'Set by your account (ACCOUNT screen)' : '';
  $('sBloom').value = s.bloom; $('vBloom').textContent = s.bloom === 0 ? 'OFF' : s.bloom.toFixed(2);
  $('sFov').value = s.fov; $('vFov').textContent = s.fov;
  for (const [id, v, k] of [['sMaster', s.masterVol, 'vMaster'], ['sMusic', s.musicVol, 'vMusic'], ['sSfx', s.sfxVol, 'vSfx'], ['sEngine', s.engineVol, 'vEngine']]) {
    $(id).value = pct(v); $(k).textContent = k === 'vEngine' && !v ? 'OFF' : pct(v);
  }
  $('sMute').textContent = s.muted ? 'MUTED' : 'ON';
  $('sMute').classList.toggle('sel', s.muted);
  $('sQuality').value = s.quality;
}

// h: {onPlay(modeId), onResume, onRestart, onQuit, onTutorial}
export function initMenu(h) {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('mPlay', () => showScreen('scrPlay'));
  on('mTut', () => h.onTutorial());
  on('pSingle', () => showScreen('scrMode'));
  on('pMulti', () => showScreen('scrMulti'));
  on('playBack', () => showScreen('scrMain'));
  on('modeBack', () => showScreen('scrPlay'));
  onMapPreview = h.onMapPreview;
  on('mSelMap', () => showScreen('scrMapSel'));
  on('msPrev', () => stepMap(-1)); on('msNext', () => stepMap(1));
  on('msBack', () => showScreen('scrMode'));
  on('msOk', () => { setSetting('spMap', MS_IDS[msIdx]); showScreen('scrMode'); });
  addEventListener('keydown', (e) => { if (current === 'scrMapSel' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) { e.preventDefault(); stepMap(e.code === 'ArrowLeft' ? -1 : 1); } });
  let sx = null; // swipe
  addEventListener('touchstart', (e) => { sx = current === 'scrMapSel' ? e.touches[0].clientX : null; }, { passive: true });
  addEventListener('touchend', (e) => { if (sx !== null && Math.abs(e.changedTouches[0].clientX - sx) > 50) stepMap(e.changedTouches[0].clientX < sx ? 1 : -1); sx = null; }, { passive: true });
  initMultiUi({ show: showScreen, openAccount: () => showScreen('scrAccount') });
  initFriendsUi({ show: showScreen, openAccount: () => showScreen('scrAccount') });
  initAdminUi({ show: showScreen });
  initPartyUi();
  on('mAbilities', () => showScreen('scrAbilities'));
  on('mGarage', () => showScreen('scrGarage'));
  on('mStats', () => showScreen('scrStats'));
  on('mAccount', () => showScreen('scrAccount'));
  initAccountUi({ newAccount: () => h.onTutorial(true), back: () => showScreen('scrMain'), open: () => showScreen('scrAccount'), refresh: () => { if (['scrMain', 'scrAbilities', 'scrGarage', 'scrStats'].includes(current)) showScreen(current); } });
  // Esc: close the delete confirmation first, else back to the main menu (capture phase: runs before the pause handler)
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && current === 'scrAccount') { e.preventDefault(); if (!accountEsc()) showScreen('scrMain'); } });
  on('gBack', () => { saveSoon(); showScreen('scrMain'); });
  on('stBack', () => showScreen('scrMain'));
  $('gTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-cat]'); if (b && tutorial.stage() !== 'color') { gCat = b.dataset.cat; gSel = null; renderGarage(''); } });
  $('gList').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) { gSel = b.dataset.id; renderGarage(''); } });
  on('gAct', () => {
    const a = $('gAct').dataset.act;
    if (!a) return;
    const r = a === 'buy' ? buyPart(gCat, gSel) : equipPart(gCat, gSel);
    if (r.ok && a === 'buy') equipPart(gCat, gSel);
    renderGarage(r.ok ? '' : G_MSG[r.reason] || '');
    if (r.ok && tutorial.stage() === 'color') { tutorial.syncColor(); if (tutorial.stage() !== 'color') showScreen('scrMain'); }
  });
  on('abBack', () => { saveSoon(); showScreen('scrMain'); });
  $('abList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const r = b.dataset.act === 'buy' ? buyAbility(b.dataset.id) : b.dataset.act === 'inf' ? buyInfinite(b.dataset.id) : toggleEquip(b.dataset.id);
    renderAbilities(r.ok ? '' : AB_MSG[r.reason] || '');
  });
  for (const b of $('scrMode').querySelectorAll('button[data-mode]')) b.addEventListener('click', () => h.onPlay(b.dataset.mode));
  for (const b of $('diffRow').children) b.addEventListener('click', () => { setSetting('aiDifficulty', +b.dataset.diff); syncDiff(); });
  on('mSettings', () => { settingsFrom = 'main'; showScreen('scrSettings'); });
  on('pSettings', () => { settingsFrom = 'pause'; showScreen('scrSettings', 'dim'); });
  on('sBack', closeSettings);
  on('sControls', () => showScreen('scrControls', settingsFrom === 'pause' ? 'dim' : 'home'));
  on('cBack', closeSettings);
  on('kReset', () => { cancelCapture(); commitKeys(defaultKeys()); renderControls('Defaults restored'); });
  $('kRows').addEventListener('click', onCapClick);
  on('pRestart', h.onRestart);
  on('pQuit', h.onQuit);

  const name = $('sName');
  const commitName = () => { const n = setUsername(name.value); name.value = n; setPlayerName(n); };
  name.addEventListener('change', commitName);
  name.addEventListener('blur', commitName);
  name.addEventListener('input', () => { // keep the field within the safe charset while typing (full trim on commit)
    const v = name.value.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 12);
    if (v !== name.value) name.value = v;
  });
  $('sFov').addEventListener('input', (e) => { const v = setSetting('fov', +e.target.value); CFG.camera.fov = v; $('vFov').textContent = v; });
  $('sBloom').addEventListener('input', (e) => {
    const v = setSetting('bloom', +e.target.value); setBloom(v); $('vBloom').textContent = v === 0 ? 'OFF' : v.toFixed(2);
  });
  for (const [id, key, fn, k] of [['sMaster', 'masterVol', audio.setMasterVolume, 'vMaster'], ['sMusic', 'musicVol', audio.setMusicVolume, 'vMusic'], ['sSfx', 'sfxVol', audio.setSfxVolume, 'vSfx'], ['sEngine', 'engineVol', audio.setEngineVolume, 'vEngine']]) {
    $(id).addEventListener('input', (e) => { const v = setSetting(key, +e.target.value / 100); fn(v); $(k).textContent = k === 'vEngine' && !v ? 'OFF' : pct(v); });
  }
  on('sMute', () => { const m = setSetting('muted', !getSave().settings.muted); audio.setMuted(m); syncSettingsUi(); });
  $('sQuality').addEventListener('change', (e) => { const q = setSetting('quality', e.target.value); setMaxDpr(CFG.quality[q]); });
}

// Back out of settings (also bound to Esc by main).
export function closeSettings() {
  const n = $('sName'); if (document.activeElement === n) n.blur();
  saveSoon();
  if (current === 'scrControls') { showScreen('scrSettings', settingsFrom === 'pause' ? 'dim' : 'home'); return; }
  if (settingsFrom === 'pause') { settingsFrom = null; showScreen(null); } else { settingsFrom = null; showScreen('scrMain'); }
}
// Esc inside a menu screen: step back one level. Returns true if the screen was handled.
export function menuBack() {
  if (current === 'scrMapSel') { showScreen('scrMode'); return true; }
  if (current === 'scrMode' || current === 'scrMulti') { showScreen('scrPlay'); return true; }
  if (current === 'scrQueue' || current === 'scrLobby') return multiBack(current);
  if (current === 'scrPlay' || current === 'scrFriends' || current === 'scrAdmin' || current === 'scrAbilities' || current === 'scrGarage' || current === 'scrStats') { showScreen('scrMain'); return true; }
  return false;
}
export const inSettings = () => current === 'scrSettings' || current === 'scrControls';

// ---- controls screen: keycaps, rebinding, touch / gamepad reference ----
let cancelCap = null;
function cancelCapture() { if (cancelCap) { cancelCap(); cancelCap = null; } }
function commitKeys(map) { setBindings(map); getSave().settings.keys = getBindings(); saveSoon(); }
const cap = (txt, cls, act, slot) => `<button type="button" class="kcap ${cls}" data-act="${act}" data-slot="${slot}">${txt}</button>`;
function renderControls(msg, waiting) { // waiting: {act, slot}
  const map = getBindings();
  $('kRows').innerHTML = ACTIONS.map((a) => {
    const gs = groups(map[a]);
    let h = gs.map((g, i) => cap(waiting && waiting.act === a && waiting.slot === i ? 'press a key…' : codeLabel(g[0]), waiting && waiting.act === a && waiting.slot === i ? 'wait' : '', a, i)).join('');
    if (a === 'pause') h = '<button type="button" class="kcap fixed" tabindex="-1" disabled>Esc</button>' + h;
    if (gs.length < 2) h += waiting && waiting.act === a && waiting.slot === -1 ? cap('press a key…', 'wait', a, -1) : cap('+', 'add', a, -1);
    return `<div class="krow"><span>${ACTION_LABEL[a]}</span><span class="kcaps">${h}</span></div>`;
  }).join('');
  $('padRows').innerHTML = GAMEPAD_LAYOUT.map(([n, k]) => `<div class="prow"><span>${n}</span><span>${k}</span></div>`).join('');
  $('kMsg').textContent = msg || '';
}
const REASON = { last: 'Every action needs at least one key', full: 'Max 2 keys per action', bad: 'Key not allowed' };
function onCapClick(e) {
  const b = e.target.closest('button.kcap[data-act]');
  if (!b || b.disabled) return;
  cancelCapture();
  const act = b.dataset.act, slot = +b.dataset.slot;
  renderControls('Press a key (Esc cancels, Backspace removes)', { act, slot });
  b.blur();
  cancelCap = captureNextKey((code) => {
    cancelCap = null;
    if (code === null) { renderControls(''); return; }
    const r = code === 'Backspace' || code === 'Delete' ? rebind(getBindings(), act, slot, null) : rebind(getBindings(), act, slot, code);
    if (!r.ok) { renderControls(REASON[r.reason] || 'Not possible'); return; }
    commitKeys(r.map);
    renderControls(r.swapped ? `Swapped with ${ACTION_LABEL[r.swapped]}` : '');
  });
}
