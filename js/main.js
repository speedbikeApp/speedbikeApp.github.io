import { CFG } from './config.js';
import { createState, createBike } from './state.js';
import { step, turnBike, canTurn, isAirborne, startBoost, startJump } from './physics.js';
import { initInput, popTurn, popAction, pushAction, clearQueue, setOnPause } from './input.js';
import { render, burst, resetCamera, resetEffects, setBikeStyle } from './render.js';
import * as audio from './audio.js';
import { initHud, setTimer, setScoreboard, setStatus, showPause, showLeave, syncOverlays, drawMinimap, setAbilityButtons, setMatchReward, setAbilityHud, setShieldTag, flashTurn, setBikeInfo, showUnlocks, showAnnounce } from './hud.js';
import { createAI, updateAIs } from './ai.js';
import { useAbility, cycleAbility, setLoadout } from './abilities.js';
import { createMatch, MODES } from './modes.js';
import { getSave, addSessionStats, recordMatch, recordRound, flushSave } from './save.js';
import { glowHex, DEFAULT_PARTS, resolveAiColors } from './parts.js';
import { initMenu, showScreen, applySettings, closeSettings, inSettings, currentScreen, menuBack } from './menu.js';
import * as online from './online.js';
import { queueMode } from './multi-ui.js';

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
  match.setMode(MODES[modeId]);
  commitSession();
  const diff = getSave().settings.aiDifficulty;
  ais.clear();
  for (let i = 1; i < state.bikes.length; i++) ais.set(i, createAI(diff, i * 2)); // staggered thinking
  // loadouts (kept across rounds; resetBike only clears timers): player's equipped slots, AI per difficulty (Hard only)
  setLoadout(state.bikes[state.playerId], getSave().equipped.abilities);
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
function quitToMenu() {
  commitSession(); flushSave();
  screen = 'menu'; clearPause();
  for (const b of state.bikes) { b.alive = false; b.trail.length = 0; } // empty arena behind the menu (camera orbits)
  match.phase = 'idle'; resetEffects();
  showScreen('scrMain');
}

// ---- online match glue (the sim / HUD feed lives in online.js) ----
function startOnline(msg) {
  commitSession(); flushSave();
  screen = 'online'; clearPause(); clearQueue();
  online.begin(msg, state, spBikes, (why) => { quitToMenu(); if (why) showAnnounce(why); });
}
function setLeave(on) { if (screen !== 'online' || online.match.phase === 'matchEnd') on = false; leaveOpen = on; showLeave(on); }
function leaveOnline() { online.leave(); quitToMenu(); }
function playAgainOnline() { const m = online.currentMode(); leaveOnline(); showScreen('scrMulti'); if (m) queueMode(m); }
online.net.on('start', (msg) => startOnline(msg));
online.watchAuth();

initHud(CFG.players.map((p, i) => ({ id: i, name: p.name, color: p.color })), {
  onPause: () => (screen === 'online' ? setLeave(true) : setPaused(true)),
  onLeaveResume: () => setLeave(false),
  onLeaveConfirm: leaveOnline,
  onResume: () => setPaused(false),
  onBoost: () => pushAction('boost'),
  onJump: () => pushAction('jump'),
  onAbility: () => pushAction('ability'),
  onSwap: () => pushAction('swap'),
  onPlayAgain: () => (screen === 'online' ? playAgainOnline() : startGame()),
  onMenu: () => (screen === 'online' ? leaveOnline() : quitToMenu()),
});
initMenu({ onPlay: (id) => startGame(id), onResume: () => setPaused(false), onRestart: () => startGame(), onQuit: quitToMenu });
initInput();
audio.initAudio();
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
    else if (act === 'ability') { if (useAbility(me, state)) audio.boost(); } else if (act === 'swap') cycleAbility(me);
    if (isAirborne(me) && !me.airTurn) popTurn(now, true); // mid-air: buffered turns are dropped
    else { const t = popTurn(now, canTurn(me)); if (t) { turnBike(me, t); audio.turn(); flashTurn(t); } }
  }
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
