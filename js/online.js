// Online (multiplayer) layer: the shared socket + session info (rank, online count, featured mode) and the online MATCH controller.
// The controller drives the same render / HUD / audio as singleplayer from server messages: it owns a match-shaped object for the HUD
// and runs the deterministic sim at the estimated server tick (js/netsim.js does the reconciliation, see NOTES.md "Client netcode").
import { CFG } from './config.js';
import * as auth from './auth.js';
import { createNet, buildHello, serverUrl } from './net.js';
import { TickClock, createSim, resetSim, stepSim, predictInput, prunePending, applyEvent, applySnap, applyCrash, visCapture, visBlend, visDecay } from './netsim.js';
import { MODES } from './modes.js';
import { MAPS } from './maps.js';
import { validateMap } from './mapdef.js';
import { createBike, resetBike, spawnPoints } from './state.js';
import { canTurn, isAirborne } from './physics.js';
import { popTurn, popAction, clearQueue } from './input.js';
import { burst, resetCamera, resetEffects, setBikeStyle, spectateNext } from './render.js';
import * as audio from './audio.js';
import { setHudPlayers, resetHudPlayers, setOnlineResult, flashTurn, showAnnounce, setAbilityHud } from './hud.js';
import { ABILITIES, setLoadout, cycleAbility, activeDef } from './abilities.js';
import { DEFAULT_PARTS, glowHex, colorDist, CLASH_DIST } from './parts.js';
import { awardDrops } from './drops.js';
import { getSave, addCoins, coinsForPlacement, abilityCharges, spendAbility, spendPassives, usableAbilities } from './save.js';
import { social } from './social.js';
import { party } from './party.js';
import { setAdmin, createCaller } from './admin-core.js';
import { resyncCloud } from './cloudsave.js';

// ---------------------------------------------------------------- presence (menus)
export const net = createNet({ url: () => serverUrl(globalThis.location ? globalThis.location.search : ''), getHello: () => buildHello(auth) });
export const mp = { rank: null, online: null, featured: null, nextRotation: 0, manual: false }; // manual: an admin pinned the featured mode (no countdown)
net.on('welcome', (m) => { setAdmin(m.admin === true); party.setMe(m.uid); mp.rank = m.rank || null; mp.online = m.online ?? null; mp.featured = m.featured || null; mp.nextRotation = m.nextRotation || 0; mp.manual = m.manual === true; });
net.on('online', (m) => { mp.online = m.online; });
net.on('rotation', (m) => { mp.featured = m.featured; mp.nextRotation = m.nextRotation; mp.manual = m.manual === true; });
net.on('rank', (m) => { mp.rank = m.rank; });
net.on('announce', (m) => showAnnounce(m.text, m.kind));
net.on('status', (s) => { if (s.state !== 'online') { mp.online = null; } if (s.state === 'idle' || s.state === 'denied') { social.reset(); party.reset(); setAdmin(false); } });
// Admin console (server/admin.js): `adminCall(op, args)` -> Promise<{ok,...}>; the server pushes `adminstate` when our rights change.
const adminCaller = createCaller((m) => net.send(m));
export const adminCall = adminCaller.call;
net.on('ares', (m) => adminCaller.resolve(m));
net.on('adminstate', (m) => setAdmin(m.admin === true));
// An admin edited our account (name / coins / stats): re-read it. A deleted account signs out.
net.on('resync', (m) => { if (m.username) auth.refreshUser().catch(() => {}); resyncCloud(m.force === true).catch(() => {}); });
net.on('error', (m) => { if (m.code === 'deleted') auth.logout().catch(() => {}); });
// Social (friends) mirror: the same persistent socket carries friend lists + presence (server/social.js). Extra listeners: friends-ui.js ('fres', 'fresults', 'fevent').
for (const t of ['friends', 'fpresence', 'frank', 'fname']) net.on(t, (m) => social.apply(m));
// Party mirror (server/party.js): `party` snapshots + `pinvites`; the UI (party-ui.js) also listens for 'pres' / 'pevent'. The server pulls members into the queue / match.
for (const t of ['party', 'pinvites']) net.on(t, (m) => party.apply(m));

/** Keep the socket in step with the account: connect when signed in, drop when signed out / switched user. */
export function watchAuth() {
  let uid = null, name = '';
  auth.onAuthChange((u) => {
    if (u && !u.username) u = null; // signed in but still choosing a username: not online yet
    const id = u ? u.uid : null;
    if (id === uid) { if (u && u.username !== name) { name = u.username; net.send({ t: 'frefresh', username: name }); } return; } // renamed: friends see the new name live
    uid = id; name = u ? u.username : '';
    if (id) net.reconnect(); else net.disconnect();
  });
}

export const MODE_LABEL = { standard: 'STANDARD', deathmatch: 'DEATH MATCH', hyper: 'HYPER', '3d': '3D', multimap: 'MULTIMAP' };

// ---------------------------------------------------------------- online match
const DT = 1 / CFG.tickHz;
let active = false, state = null, spBikes = null, sim = null, onExit = () => {};
let youId = 0, startMsg = null, mode = null, saved = [];
const tc = new TickClock(CFG.tickHz);
let tb = { v: 0, tick: 0 };          // match clock base: server roundTime at server tick
let cdBase = { cd: 0, tick: 0 }, runStart = 0;
export const match = {                // match-shaped object read by hud.js / the audio tracker
  mode: MODES.standard, phase: 'idle', cd: 0, timeLeft: 0, elapsed: 0, runTime: 0, round: 0,
  scores: {}, lives: {}, kills: {}, respawnIn: {}, lastResult: null, placements: null, ranks: null, winner: null,
  clock() { return match.mode.countUp ? match.elapsed : match.timeLeft; },
};
export const isActive = () => active;
export const dbg = { snaps: 0, corrected: 0, revived: 0, events: 0, maxErr: 0, ownEvents: 0, ownErr: 0, ownErrMax: 0, remoteErrMax: 0, smoothed: 0, snapped: 0 }; // counters for tests / tuning (netcode health)
export const currentMode = () => (startMsg ? startMsg.mode : null);

// Temporarily apply server config overrides (only keys that already exist, plain numbers / nested objects).
function applyOverrides(o) {
  saved = [];
  const walk = (dst, src, path) => {
    for (const k of Object.keys(src || {})) {
      if (k === '__proto__' || k === 'constructor' || !(k in dst)) continue;
      if (src[k] && typeof src[k] === 'object' && dst[k] && typeof dst[k] === 'object') walk(dst[k], src[k], path + k + '.');
      else if (typeof src[k] === typeof dst[k]) { saved.push([dst, k, dst[k]]); dst[k] = src[k]; }
    }
  };
  walk(CFG, o, '');
}
function restoreOverrides() { for (const [d, k, v] of saved.reverse()) d[k] = v; saved = []; }

const colorOf = (p) => CFG.players[(p.colorIdx | 0) % CFG.players.length].color;

/** Begin an online match from a `start` message. `st` = main's shared state object, `bikes0` = its singleplayer bikes (restored on stop). */
export function begin(msg, st, bikes0, exitCb) {
  stop();
  state = st; spBikes = bikes0; onExit = exitCb || (() => {}); startMsg = msg; youId = msg.you | 0;
  restoreOverrides(); applyOverrides(msg.cfgOverrides);
  mode = MODES[msg.mode] || MODES.standard;
  const players = (msg.players || []).slice().sort((a, b) => a.id - b.id);
  state.map = mapOfMsg(msg);
  // colours: everyone gets their lobby colour; we use our own glow colour unless it clashes with another bike
  const mine = glowHex(getSave().equipped.parts.glow);
  const others = players.filter((p) => p.id !== youId).map(colorOf);
  const useGlow = others.every((c) => colorDist(c, mine) >= CLASH_DIST);
  state.bikes = players.map((p) => {
    const b = createBike(p.id, p.id === youId && useGlow ? mine : colorOf(p), 0, 0, 0, -1);
    b.name = p.username; b.rank = p.rank; b.uid = p.uid; b.bot = !!p.bot; b.admin = !!p.admin && !p.bot;
    setLoadout(b, p.loadout || []);   // provisional (queue time); everybody's final list follows as `loadout` messages during the countdown
    return b;
  });
  state.playerId = youId; state.tick = 0; state.time = 0;
  for (const b of state.bikes) setBikeStyle(b, DEFAULT_PARTS); // default parts for everybody (known limitation: garage parts are not synced)
  setHudPlayers(state.bikes.map((b) => ({ id: b.id, name: b.name, color: b.color, rank: b.rank, uid: b.uid, admin: b.admin })), youId);
  sim = createSim(state, 0); tc.reset();
  Object.assign(match, {
    mode, phase: 'countdown', cd: CFG.match.countdown, timeLeft: mode.roundTime, elapsed: 0, runTime: 0, round: 0,
    scores: {}, lives: {}, kills: {}, respawnIn: {}, lastResult: null, placements: null, ranks: null, winner: null,
  });
  for (const b of state.bikes) { match.scores[b.id] = 0; if (mode.kind === 'deathmatch') match.lives[b.id] = CFG.deathMatch.lives; }
  if (mode.kind === 'deathmatch') match.kills = match.scores;
  tb = { v: mode.roundTime, tick: 0 }; cdBase = { cd: CFG.match.countdown, tick: 0 }; runStart = 0;
  placeBikes(); resetCamera(); resetEffects(); clearQueue(); setOnlineResult(null);
  announceLoadout();
  document.body.classList.add('online');
  net.lock(true);
  active = true;
}

/** Our loadout for this match: equipped actives that still have charges + the passives whose charge is spent now (one per match).
 *  Sent to the server during the first countdown; it relays it to every client. */
export function matchLoadout() {
  const eq = getSave().equipped.abilities, usable = new Set(usableAbilities()), passives = new Set(spendPassives(eq));
  return eq.filter((id) => (ABILITIES[id].type === 'passive' ? passives.has(id) : usable.has(id)));
}
function announceLoadout() {
  const ids = matchLoadout(), me = bikeById(youId);
  if (me) setLoadout(me, ids);
  net.send({ t: 'loadout', abilities: ids });
}

// sb = the server's fresh spawns (`round` countdown message, random per round); without them the fixed layout until it arrives
function placeBikes(sb) {
  const pts = spawnPoints(state.bikes.length, state.map);
  state.bikes.forEach((b, i) => { resetBike(b, (sb && sb.find((o) => o.id === b.id)) || pts[i], mode.speed); b.trail[0].ct = -1; b.vox = b.voz = 0; });
}

/** Leave the online view and restore the singleplayer world. quiet = no onExit callback. */
export function stop() {
  if (!active) return;
  active = false;
  restoreOverrides();
  if (state && spBikes) { state.bikes = spBikes; state.playerId = 0; state.map = MAPS.arena; for (const b of state.bikes) { b.alive = false; b.trail.length = 0; } }
  resetHudPlayers(); setOnlineResult(null); resetEffects(); resetCamera();
  document.body.classList.remove('online');
  net.lock(false);
  match.phase = 'idle'; sim = null; startMsg = null;
}

/** Player chose Leave match (or dropped out): tell the server (counts as a loss) unless the match is already over. */
export function leave() {
  if (active && match.phase !== 'matchEnd') net.send({ t: 'leave' });
  stop();
}

// ---------------------------------------------------------------- server messages (only while a match is active)
const fx = (b) => { burst(b.x, b.z, b.color, b.y + 0.8); audio.crash(b.id === youId); };
const bikeById = (id) => (state ? state.bikes.find((b) => b.id === id) : null);
// Show a bike's pre-correction position and glide it to the corrected one (render-only offset, see netsim.js visBlend).
function smooth(b, cap) {
  if (!b || !cap) return 0;
  const own = b.id === youId, e = visBlend(b, cap, own ? { maxDist: CFG.net.blendOwnMax } : { maxDist: CFG.net.blendRemoteMax, allowTurn: true });
  if (e >= 0.02) { if (b.vox || b.voz) dbg.smoothed++; else dbg.snapped++; }
  return e;
}
// start / round message -> map. Custom maps: the server sends the whole definition (id = mapId)
function mapOfMsg(msg) {
  const cm = msg.map && !MAPS[msg.mapId] && validateMap(msg.map);
  return cm && cm.ok ? { id: msg.mapId, ...cm.map } : MAPS[msg.mapId] || MAPS.arena;
}
const on = (type, fn) => net.on(type, (m) => { if (active && sim) fn(m); });

on('round', (m) => {
  tc.sample(m.tick, performance.now());
  match.round = m.round; match.scores = m.scores || match.scores; match.lastResult = m.lastResult || null;
  if (m.lives) match.lives = m.lives;
  if (mode.kind === 'deathmatch') match.kills = match.scores;
  if (m.phase === 'countdown') {
    if (m.mapId && m.mapId !== state.map.id) state.map = mapOfMsg(m); // multimap: new map each round
    placeBikes(m.bikes); resetSim(sim, m.tick); resetCamera(); resetEffects(); clearQueue();
    match.respawnIn = {}; match.lastResult = null;
    match.phase = 'countdown'; cdBase = { cd: m.cd, tick: m.tick }; tb = { v: m.roundTime, tick: m.tick };
    match.timeLeft = mode.roundTime; match.elapsed = 0; match.runTime = 0;
  } else if (m.phase === 'running') {
    match.phase = 'running'; sim.tick = m.tick; sim.hist.clear(); runStart = m.tick; tb = { v: m.roundTime, tick: m.tick };
  } else if (m.phase === 'roundEnd' || m.phase === 'matchEnd') {
    if (match.phase !== 'matchEnd') match.phase = 'roundEnd'; // matchEnd panel waits for the `end` message (ranks)
  }
});
on('snap', (m) => {
  tc.sample(m.tick, performance.now());
  if (match.phase !== 'running') return;
  advance(performance.now());
  if (typeof m.roundTime === 'number') tb = { v: m.roundTime, tick: m.tick };
  const caps = new Map(state.bikes.map((b) => [b.id, visCapture(b)]));
  const r = applySnap(sim, m, sim.tick, { spawnProt: mode.kind === 'deathmatch' ? CFG.deathMatch.spawnProtect : 0 });
  for (const id of r.revived) { const b = bikeById(id); if (b) b.vox = b.voz = 0; }
  for (const id of r.corrected) smooth(bikeById(id), caps.get(id));
  dbg.snaps++; (dbg.log = dbg.log || []).push([sim.tick - m.tick, JSON.stringify(r.err)]); if (dbg.log.length > 30) dbg.log.shift(); dbg.corrected += r.corrected.length; dbg.revived += r.revived.length;
  for (const sb of m.bikes || []) if (typeof sb.lives === 'number') match.lives[sb.id] = sb.lives;
});
on('ev', (m) => {
  tc.sample(m.tick, performance.now());
  if (match.phase !== 'running') return;
  advance(performance.now());
  const was = bikeById(m.id), wasAlive = was && was.alive, cap = was && visCapture(was);
  const r = applyEvent(sim, m, sim.tick);
  dbg.events++;
  if (was && r.applied && !r.respawned) { const e = smooth(was, cap); if (m.id === youId) { dbg.ownEvents++; dbg.ownErr = e; if (e > dbg.ownErrMax) dbg.ownErrMax = e; } else if (e > dbg.remoteErrMax) dbg.remoteErrMax = e; }
  else if (was && r.respawned) was.vox = was.voz = 0;
  if (r.respawned) delete match.respawnIn[m.id];
  if (m.kind === 'ability' && m.id === youId && r.applied) { // the server confirmed the activation: now it costs a charge (turbo: free)
    spendAbility(m.ability);
    const me = bikeById(youId); if (me && abilityCharges(m.ability) < 1 && activeDef(me)?.id === m.ability) cycleAbility(me, 1, (id) => abilityCharges(id) >= 1); // last charge: show one that still has charges
  }
  if (r.died && wasAlive) fx(was);
});
on('loadout', (m) => { const b = bikeById(m.id); if (b && m.id !== youId && Array.isArray(m.abilities)) setLoadout(b, m.abilities); });
on('crash', (m) => {
  tc.sample(m.tick, performance.now());
  if (match.phase === 'running') advance(performance.now());
  const b = bikeById(m.victim);
  if (applyCrash(sim, m) && b) fx(b);
  if (typeof m.lives === 'number') {
    match.lives[m.victim] = m.lives;
    if (m.lives > 0) match.respawnIn[m.victim] = CFG.deathMatch.respawnDelay; else delete match.respawnIn[m.victim];
  }
});
on('end', (m) => {
  const rows = (m.ranks || []).map((r) => ({ ...r }));
  const ord = rows.slice().sort((a, b) => a.place - b.place || a.id - b.id);
  match.placements = ord.map((r) => r.id);
  match.ranks = Object.fromEntries(rows.map((r) => [r.id, r.place]));
  for (const r of rows) match.scores[r.id] = r.scores ?? match.scores[r.id] ?? 0;
  match.winner = match.placements[0];
  match.phase = 'matchEnd'; match.respawnIn = {};
  const me = rows.find((r) => r.id === youId);
  if (me && me.rankAfter) mp.rank = me.rankAfter;
  let reward = null;
  if (me && !me.left && m.reason !== 'stopped') { // (an admin-stopped match pays nothing) 2x the offline coins: placement + Death Match kill coins
    const kills = MODES[m.mode]?.kind === 'deathmatch' ? (me.scores || 0) : 0;
    const earned = CFG.rewards.onlineMult * (coinsForPlacement(me.place) + kills * CFG.deathMatch.coinsPerKill);
    reward = { earned, total: addCoins(earned) };
    reward.drops = awardDrops({ won: me.place === 1, bonus: true }); reward.total = getSave().coins;
  }
  setOnlineResult({ meId: youId, rows, mode: m.mode, reward, stopped: m.reason === 'stopped' });
  net.lock(false);
});
net.on('close', () => { if (active && match.phase !== 'matchEnd') { const cb = onExit; stop(); cb('CONNECTION LOST'); } });

// ---------------------------------------------------------------- per-frame update
function localInputs(me, nowMs) {
  const act = popAction(nowMs);
  if ((act === 'boost' || act === 'jump') && predictInput(sim, me.id, { kind: act })) {
    net.send({ t: 'in', kind: act, ctick: sim.tick });
    if (act === 'boost') audio.boost(); else audio.jump();
  } else if (act === 'swap' || act === 'swapBack') cycleAbility(me, act === 'swap' ? 1 : -1); // which ability the hexagon fires is local; the activation names the ability
  else if (act === 'ability') {
    const def = activeDef(me);
    if (def && abilityCharges(def.id) >= 1 && predictInput(sim, me.id, { kind: 'ability', ability: def.id })) {
      net.send({ t: 'in', kind: 'ability', ability: def.id, ctick: sim.tick });
      audio.boost();
    }
  }
  if (isAirborne(me) && !me.airTurn) popTurn(nowMs, true); // mid-air: buffered turns are dropped
  else {
    const side = popTurn(nowMs, canTurn(me));
    if (side && predictInput(sim, me.id, { kind: 'turn', side })) { net.send({ t: 'in', kind: 'turn', side, ctick: sim.tick }); audio.turn(); flashTurn(side); }
  }
}

// Bring the sim up to the estimated server tick (running phase: steps the world with our buffered inputs; other phases: just the
// counter). Message handlers call this first so a snap / event is compared with a world that is "now", not one frame old.
function advance(nowMs) {
  const m = match, est = tc.estimate(nowMs, net.rtt / 2);
  if (est === null) return null;
  const target = Math.floor(est);
  if (m.phase === 'running') {
    let n = target - sim.tick;
    if (n > CFG.net.maxCatchup) { sim.tick = target - CFG.net.maxCatchup; n = CFG.net.maxCatchup; } // tab was hidden / long stall: snaps resync
    const me = state.bikes.find((b) => b.id === youId);
    while (n-- > 0) {
      if (me && me.alive) localInputs(me, nowMs);
      else if (me) { const side = popTurn(nowMs); if (side) spectateNext(state, side, me.id); } // out: left / right switch the spectated bike
      for (const e of stepSim(sim)) { const b = bikeById(e.victim); if (b) fx(b); }
    }
  } else if (target > sim.tick) sim.tick = target;
  return est;
}

/** Advance the online world to the estimated server tick. Returns the render extrapolation (seconds past the last tick). */
export function update(nowMs, dt) {
  const m = match, est = advance(nowMs);
  let extra = 0;
  if (est !== null) {
    if (m.phase === 'running') {
      extra = (est - Math.floor(est)) * DT;
      m.runTime = (sim.tick - runStart) * DT;
      const dtk = (sim.tick - tb.tick) * DT;
      if (m.mode.countUp) m.elapsed = tb.v + dtk; else m.timeLeft = Math.max(0, tb.v - dtk);
    } else if (m.phase === 'countdown') m.cd = Math.max(0.001, cdBase.cd - (sim.tick - cdBase.tick) * DT);
  }
  prunePending(sim);
  visDecay(state.bikes, dt);
  const me = bikeById(youId); if (me) setAbilityHud(me);
  for (const id of Object.keys(m.respawnIn)) { m.respawnIn[id] -= dt; if (m.respawnIn[id] <= 0) delete m.respawnIn[id]; }
  return extra;
}

/** Round-trip time of the latest ping in ms (null until the first pong): the HUD latency readout. */
export function ping() { const v = net.clock.last; return v === null || v === undefined ? null : Math.round(v); }

// Death Match status line (respawn countdown / eliminated), like singleplayer.
export function status() {
  const me = state && state.bikes.find((b) => b.id === youId);
  if (!active || !me || match.mode.kind !== 'deathmatch' || match.phase !== 'running' || me.alive) return '';
  const t = match.respawnIn[youId];
  return t > 0 ? `RESPAWN IN ${t.toFixed(1)}` : match.lives[youId] > 0 ? 'RESPAWNING' : 'ELIMINATED - SPECTATING';
}
