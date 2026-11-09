import { CFG } from './config.js';
import { createState, createBike } from './state.js';
import { step, turnBike, canTurn, isAirborne, startBoost, startJump } from './physics.js';
import { initInput, popTurn, popAction, pushAction, clearQueue, setOnPause } from './input.js';
import { render, renderMapPreview, burst, resetCamera, resetEffects, setBikeStyle, spectateNext } from './render.js';
import * as audio from './audio.js';
import { initHud, setTimer, setPing, setScoreboard, setStatus, showPause, showLeave, syncOverlays, drawMinimap, setAbilityButtons, setMatchReward, setAbilityHud, setShieldTag, flashTurn, setBikeInfo, showUnlocks, showAnnounce } from './hud.js';
import { createAI, updateAIs } from './ai.js';
import { useAbility, cycleAbility, setLoadout, activeDef, ABILITIES } from './abilities.js';
import { createMatch, MODES, modeWithMap } from './modes.js';
import { MAPS } from './maps.js';
import { awardDrops } from './drops.js';
import { getSave, addSessionStats, recordMatch, recordRound, flushSave, abilityCharges, spendAbility, spendPassives } from './save.js';
import { glowHex, DEFAULT_PARTS, resolveAiColors } from './parts.js';
import { initMenu, showScreen, applySettings, closeSettings, inSettings, currentScreen, menuBack } from './menu.js';
import * as online from './online.js';
import { queueMode } from './multi-ui.js';
import { initCatalog } from './catalog.js';
import { initCustomMaps, CUSTOM } from './custommaps.js';
import { initUpdate } from './update.js';

const DT = 1 / CFG.tickHz;
const state = createState();
const ais = new Map(); // bike id -> ai
CFG.players.forEach((p, i) => {
  const b = createBike(i, p.color, 0, 0, 0, -1); // real spawn set by match.startRound
  b.name = p.name;
  state.bikes.push(b);
});
state.playerId = 0;
const spBikes = state.bikes; // singleplayer bikes: state.bikes is swapped for the room's bikes during an online match

let modeId = 'standard';
const match = createMatch(state, MODES.standard, Math.random, {
  maps: CUSTOM, // single-player custom maps (custommaps.js), resolved at match start
  onRoundStart() { roundCnt = { boosts: 0, jumps: 0 }; clearQueue(); resetCamera(); resetEffects(); },
  onRespawn(b) { if (b.id === state.playerId) { clearQueue(); resetCamera(); } }, // Death Match
});
let paused = false;
let screen = 'menu'; // 'menu' | 'game' (singleplayer) | 'online' (multiplayer match, see online.js)
let leaveOpen = false;
let session = { kills: 0, distance: 0, boosts: 0, jumps: 0 }; // player tallies not yet written to the save
let rewarded = false;
let roundCnt = { boosts: 0, jumps: 0 }; // player's boosts / jumps this round (Death Match: whole match) for achievements

// Add the player's tallies to the save (call at round end, match end, quit, restart, page hide).
function commitSession() {
  if (session.kills || session.distance || session.boosts || session.jumps) showUnlocks(addSessionStats(session));
  session = { kills: 0, distance: 0, boosts: 0, jumps: 0 };
}

function setPaused(p) {
  if (screen !== 'game' || match.phase === 'matchEnd') p = false;
  if (p === paused) return;
  paused = p; showPause(p); clearQueue(); audio.setPaused(p);
  if (!p && currentScreen()) showScreen(null); // settings opened from the pause panel
}
function clearPause() { paused = false; showPause(false); audio.setPaused(false); showLeave(false); leaveOpen = false; showScreen(null); }

function startGame(id) {
  if (typeof id === 'string' && MODES[id]) modeId = id; // play again / restart keep the current mode
  demoMap = null; state.playerId = 0; // must come first: the menu mock match left playerId = -1; next menu gets a new random map
  match.setMode(modeWithMap(modeId, getSave().settings.spMap));
  commitSession();
  const diff = getSave().settings.aiDifficulty;
  ais.clear();
  for (let i = 1; i < state.bikes.length; i++) ais.set(i, createAI(diff, i * 2)); // staggered thinking
  // loadouts (kept across rounds; resetBike only clears timers): player's equipped slots, AI per difficulty (Hard only)
  { // consumables: passives cost 1 charge per match; equipped actives stay (unusable at 0 charges)
    const eq = getSave().equipped.abilities, on = spendPassives(eq);
    setLoadout(state.bikes[state.playerId], eq.filter((id) => ABILITIES[id].type === 'active' || on.includes(id)));
  }
  for (const b of state.bikes) if (b.id !== state.playerId) setLoadout(b, CFG.ai.loadouts[diff] || []);
  // looks: player's equipped parts + glow colour; AIs get a colour that does not clash with it
  const eq = getSave().equipped.parts, pc = glowHex(eq.glow);
  const aiDefs = resolveAiColors(pc, CFG.players.slice(1).map((p) => ({ name: p.name, color: p.color })));
  state.bikes[state.playerId].color = pc; setBikeInfo(state.playerId, getSave().profile.username, pc);
  setBikeStyle(state.bikes[state.playerId], eq);
  aiDefs.forEach((a, i) => { const b = state.bikes[i + 1]; b.color = a.color; b.name = a.name; setBikeInfo(b.id, a.name, a.color); setBikeStyle(b, DEFAULT_PARTS); });
  roundCnt = { boosts: 0, jumps: 0 };
  screen = 'game'; rewarded = false; setMatchReward(null);
  document.body.classList.remove('menu');
  clearPause(); clearQueue();
  state.tick = 0;
  match.startMatch();
}
// Menu background: 4 bots play endlessly on a random built-in map (picked once per menu visit after a real game, not on every
// return from garage/settings). Never touches the save/audio/HUD: trackMatch/trackAudio/session only run for real games.
let demoMap = null;
function startDemo() {
  if (!demoMap) { const ids = Object.keys(MAPS); demoMap = ids[Math.floor(Math.random() * ids.length)]; }
  state.playerId = -1; // nobody is "the player": plain bot-vs-bot rules, camera follows a survivor
  match.setMode({ ...MODES.standard, map: demoMap, winPoints: 1e9 });
  ais.clear();
  state.bikes.forEach((b, i) => { ais.set(b.id, createAI(1, i * 2)); setLoadout(b, []); b.color = CFG.players[i].color; setBikeStyle(b, DEFAULT_PARTS); });
  state.tick = 0;
  match.startMatch();
}
function demoTick() {
  if (match.phase === 'matchEnd') match.startMatch(); // same map, fresh match
  if (match.phase !== 'running') { match.advance(DT); return; }
  updateAIs(state, ais, state.tick++);
  const events = step(state, DT);
  for (const e of events) { const b = state.bikes.find((v) => v.id === e.victim); burst(b.x, b.z, b.color, b.y + 0.8); }
  match.onTick(events, DT);
}
function quitToMenu() {
  commitSession(); flushSave();
  screen = 'menu'; clearPause();
  for (const b of state.bikes) { b.alive = false; b.trail.length = 0; }
  match.phase = 'idle'; resetEffects(); syncOverlays(match); audio.setEngine(false, 0, 1, false);
  showScreen('scrMain');
  startDemo();
}

// ---- online match glue (the sim / HUD feed lives in online.js) ----
function startOnline(msg) {
  commitSession(); flushSave();
  screen = 'online'; clearPause(); clearQueue(); demoMap = null;
  online.begin(msg, state, spBikes, (why) => { quitToMenu(); if (why) showAnnounce(why); });
}
function setLeave(on) { if (screen !== 'online' || online.match.phase === 'matchEnd') on = false; leaveOpen = on; showLeave(on); }
function leaveOnline() { online.leave(); quitToMenu(); }
function playAgainOnline() { const m = online.currentMode(); leaveOnline(); showScreen('scrMulti'); if (m) queueMode(m); }
online.net.on('start', (msg) => startOnline(msg));
online.watchAuth();
initCustomMaps(); // admin-made maps for single-player: cached copy now, fresh one in the background
initCatalog(); // garage catalog: cached copy now, fresh one in the background

initHud(CFG.players.map((p, i) => ({ id: i, name: p.name, color: p.color })), {
  onPause: () => (screen === 'online' ? setLeave(true) : setPaused(true)),
  onLeaveResume: () => setLeave(false),
  onLeaveConfirm: leaveOnline,
  onResume: () => setPaused(false),
  onBoost: () => pushAction('boost'),
  onJump: () => pushAction('jump'),
  onAbility: () => pushAction('ability'),
  onSwap: () => pushAction('swap'),
  onSwapBack: () => pushAction('swapBack'),
  onPlayAgain: () => (screen === 'online' ? playAgainOnline() : startGame()),
  onMenu: () => (screen === 'online' ? leaveOnline() : quitToMenu()),
});
initUpdate();
let previewMap = null; // map-select screen open: 'random' (cycles through the maps) | map id | null
initMenu({ onMapPreview: (id) => { previewMap = id; }, onPlay: (id) => startGame(id), onResume: () => setPaused(false), onRestart: () => startGame(), onQuit: quitToMenu });
initInput();
audio.initAudio();
// Phones: first tap (a user gesture) goes fullscreen and tries to lock landscape; failures are ignored.
if (matchMedia('(pointer: coarse)').matches) {
  const goFull = () => {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) { off(); return; }
    try {
      const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen && el.webkitRequestFullscreen();
      if (r && r.then) r.then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch {} off(); }, () => {});
    } catch {}
    try { screen.orientation.lock('landscape').catch(() => {}); } catch {}
  };
  const off = () => { removeEventListener('pointerup', goFull, true); removeEventListener('touchend', goFull, true); };
  addEventListener('pointerup', goFull, true); addEventListener('touchend', goFull, true);
}
applySettings();
setOnPause(() => {
  if (screen === 'menu') { // Esc backs out of menu screens
    if (inSettings()) closeSettings(); else menuBack();
  } else if (screen === 'online') setLeave(!leaveOpen);
  else if (inSettings()) closeSettings();
  else setPaused(!paused);
});
// Never starts paused: only a visibilitychange to hidden while a round is in progress pauses.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { commitSession(); flushSave(); }
  if (document.hidden && screen === 'game' && (match.phase === 'running' || match.phase === 'countdown')) setPaused(true);
});
addEventListener('pagehide', () => { commitSession(); flushSave(); });
quitToMenu();
audio.startMusic();

function tick() {
  if (match.phase !== 'running') { match.advance(DT); return; }
  const me = state.bikes[state.playerId];
  if (me.alive) {
    const now = performance.now();
    const act = popAction(now);
    if (act === 'boost') { if (startBoost(me)) { audio.boost(); session.boosts++; roundCnt.boosts++; } } else if (act === 'jump') { if (startJump(me)) { audio.jump(); session.jumps++; roundCnt.jumps++; } }
    else if (act === 'ability') { { const def = activeDef(me); if (def && abilityCharges(def.id) >= 1 && useAbility(me, state)) { spendAbility(def.id); audio.boost(); } } } else if (act === 'swap' || act === 'swapBack') cycleAbility(me, act === 'swap' ? 1 : -1);
    if (isAirborne(me) && !me.airTurn) popTurn(now, true); // mid-air: buffered turns are dropped
    else { const t = popTurn(now, canTurn(me)); if (t) { turnBike(me, t); audio.turn(); flashTurn(t); } }
  }
  else { const t = popTurn(performance.now()); if (t) spectateNext(state, t, me.id); } // out: left / right switch the spectated bike
  if (me.alive) session.distance += me.speed * DT;
  updateAIs(state, ais, state.tick++);
  const events = step(state, DT);
  for (const e of events) {
    const b = state.bikes.find((v) => v.id === e.victim);
    burst(b.x, b.z, b.color, b.y + 0.8);
    audio.crash(b.id === state.playerId);
    if (e.killer === state.playerId && e.victim !== state.playerId) session.kills++;
  }
  match.onTick(events, DT);
}

// Audio cues derived from match phase changes + player engine (render-rate, not tick-rate).
let prevPhase = match.phase, prevCd = 0;
function trackAudio(match) {
  const ph = match.phase;
  if (ph === 'countdown') { const c = Math.ceil(match.cd); if (c !== prevCd && c > 0) audio.countdownBeep(); prevCd = c; }
  if (ph !== prevPhase) {
    if (ph === 'running' && prevPhase === 'countdown') audio.goBeep();
    else if (ph === 'roundEnd') (state.bikes[state.playerId].alive ? audio.roundWin : audio.roundLose)();
    else if (ph === 'matchEnd') (match.winner === state.playerId ? audio.roundWin : audio.roundLose)();
    if (ph === 'countdown') prevCd = 0;
    prevPhase = ph;
  }
  const me = state.bikes[state.playerId];
  audio.setEngine(me.alive && ph === 'running' && !paused, me.speed, me.baseSpeed, me.speed > me.baseSpeed * 1.01);
}

// Round end / match end bookkeeping: write tallies; on match end award coins + update stats once.
let lastPhase = match.phase;
function trackMatch() {
  const ph = match.phase;
  if (ph !== lastPhase) {
    if (screen === 'game' && (ph === 'roundEnd' || ph === 'matchEnd')) {
      commitSession();
      if (ph === 'roundEnd' || match.mode.kind === 'deathmatch') { showUnlocks(recordRound(roundCnt)); roundCnt = { boosts: 0, jumps: 0 }; }
    }
    lastPhase = ph;
  }
  if (screen === 'game' && ph === 'matchEnd' && !rewarded) {
    rewarded = true;
    const rank = match.ranks[state.playerId];
    const flawless = match.mode.kind === 'deathmatch' && rank === 1 && match.lives[state.playerId] === CFG.deathMatch.lives;
    const r = recordMatch(rank, match.bonusCoins(state.playerId), { mode: match.mode.id, flawless });
    r.drops = awardDrops({ won: rank === 1, bonus: getSave().settings.aiDifficulty === 2 }); r.total = getSave().coins; // HARD bots = bonus win drops
    setMatchReward(r); showUnlocks(r.unlocked);
  }
}

// Death Match status line: respawn countdown / eliminated (while the spectate camera follows a survivor).
function dmStatus() {
  if (match.phase !== 'running' || state.bikes[state.playerId].alive) return '';
  const t = match.respawnIn[state.playerId];
  return t > 0 ? `RESPAWN IN ${t.toFixed(1)}` : 'ELIMINATED - SPECTATING';
}

let last = performance.now(), acc = 0;
function frameOnline(now, dt) {
  const m = online.match, extra = online.update(now, dt), me = state.bikes[state.playerId];
  trackAudio(m);
  render(state, dt, state.playerId, extra);
  setTimer(m.clock());
  setPing(online.ping());
  setScoreboard(state, m, m.mode.kind === 'deathmatch');
  setStatus(online.status());
  syncOverlays(m);
  drawMinimap(state);
  setAbilityButtons(me);
  setShieldTag(me);
}
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  if (screen === 'online' && online.isActive()) { frameOnline(now, dt); requestAnimationFrame(frame); return; }
  if (screen === 'menu' && previewMap) { // map-select: demo match frozen (not ticked), only the map is drawn
    const ids = Object.keys(MAPS);
    renderMapPreview(MAPS[previewMap === 'random' ? ids[Math.floor(now / 2500) % ids.length] : previewMap] || CUSTOM[previewMap] || MAPS.arena, dt);
    requestAnimationFrame(frame); return;
  }
  if (screen === 'menu') { // background mock match: sim + render only, 30 Hz-safe cap on catch-up
    acc += dt;
    for (let n = 0; acc >= DT && n < 4; n++) { demoTick(); acc -= DT; }
    acc %= DT;
    render(state, dt, -1, match.phase === 'running' ? acc : 0, true); // true = top-down overview, no bike followed
    requestAnimationFrame(frame); return;
  }
  if (screen === 'game' && !paused) {
    acc += dt;
    while (acc >= DT) { tick(); acc -= DT; }
  }
  trackMatch();
  trackAudio(match);
  const running = screen === 'game' && match.phase === 'running' && !paused;
  render(state, dt, state.playerId, running ? acc : 0);
  setTimer(match.clock());
  const dm = match.mode.kind === 'deathmatch' && screen === 'game';
  setScoreboard(state, match, dm);
  setStatus(dm ? dmStatus() : '');
  syncOverlays(match);
  drawMinimap(state);
  setAbilityButtons(state.bikes[state.playerId]);
  setAbilityHud(state.bikes[state.playerId]);
  setShieldTag(state.bikes[state.playerId]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
