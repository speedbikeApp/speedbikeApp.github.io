// Game modes + match state machine. Pure logic (no DOM / three) so it is testable.
// Round modes (standard / hyper / 3d): countdown -> running -> roundEnd -> (countdown | matchEnd).
// Death Match: countdown -> running (one continuous match, lives + respawns) -> matchEnd.
// The caller (main.js) runs physics only while phase === 'running' and feeds step() events to match.onTick().
import { CFG } from './config.js';
import { resetBike, spawnPoints } from './state.js';
import { resolveTick, resolvePlayerOut, resolveTimeout, applyAwards, matchWinner, placements, rankings } from './rules.js';
import { MAPS, mapOf, platformArea, toWorld } from './maps.js';
import { probe } from './ai.js';

// A mode is data + crash/timeout policy. kind 'rounds' uses onCrash/onTimeout; kind 'deathmatch' uses CFG.deathMatch.
// `speed` is a getter so CFG tuning (and tests) are read live. map = key into MAPS, or a list to pick one per match.
function roundMode(id, label, speed, map = 'arena') {
  return {
    id, label, kind: 'rounds', map,
    get speed() { return speed(); },
    roundTime: CFG.match.roundTime,
    winPoints: CFG.match.winPoints,
    // The player crashing ends the round at once (random alive bot scores); bot-vs-bot crashes use the normal rules.
    onCrash: (match, crashed, aliveBefore) => (crashed.includes(match.playerId()) ? resolvePlayerOut(aliveBefore, crashed, match.playerId(), match.rng) : resolveTick(aliveBefore, crashed, match.rng)),
    onTimeout: (match, alive) => resolveTimeout(alive),
  };
}
export const MODES = {
  standard: roundMode('standard', 'STANDARD', () => CFG.baseSpeed, ['arena', 'crater', 'stairs']),
  hyper: roundMode('hyper', 'HYPER', () => CFG.hyper.speed),
  '3d': roundMode('3d', '3D', () => CFG.baseSpeed, ['tiers', 'stairs']),
  deathmatch: {
    id: 'deathmatch', label: 'DEATH MATCH', kind: 'deathmatch', map: ['arena', 'crater', 'stairs'], countUp: true,
    get speed() { return CFG.baseSpeed; },
    roundTime: 0, winPoints: 0,
  },
};

// Single-player map choice: Standard / Death Match accept any built-in map, 3D / Hyper only their own pool.
export const modeMaps = (id) => (id === 'standard' || id === 'deathmatch' ? Object.keys(MAPS) : [].concat(MODES[id].map));
// The mode to play for a saved choice ('random' or invalid for this mode -> the mode's own random pool). Prototype keeps the live `speed` getter.
export const modeWithMap = (id, sel) => (modeMaps(id).includes(sel) ? Object.create(MODES[id], { map: { value: [sel] } }) : MODES[id]);

// Distance from a point to an axis-aligned trail segment.
function segDist(px, pz, s) {
  const x0 = Math.min(s.x1, s.x2), x1 = Math.max(s.x1, s.x2), z0 = Math.min(s.z1, s.z2), z1 = Math.max(s.z1, s.z2);
  return Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(z0 - pz, 0, pz - z1));
}

// Death Match respawn: sample candidate points on the platforms (kept `margin` from edges / walls) and take the one whose
// MINIMUM distance to the other bikes and to every trail is largest (ties -> nearer the centre). Faces the axis direction
// with the most open road ahead (probe: walls, edges, trails), slightly preferring the way to the centre.
// Returns a spawn {x,z,dx,dz,y,score,d}. `bike` is only used to skip itself (its trail is already cleared).
export function pickRespawn(state, bike, rng = Math.random) {
  const map = mapOf(state), P = map.platforms, D = CFG.deathMatch;
  const total = P.reduce((a, p) => a + platformArea(p), 0);
  const others = state.bikes.filter((o) => o !== bike && o.alive);
  let best = null;
  for (let i = 0; i < D.samples; i++) {
    let r = rng() * total, p = P[P.length - 1];
    for (const q of P) { r -= platformArea(q); if (r <= 0) { p = q; break; } }
    const mx = Math.min(D.margin, (p.x1 - p.x0) * 0.4), mz = Math.min(D.margin, (p.z1 - p.z0) * 0.4);
    const [x, z] = toWorld(p, p.x0 + mx + rng() * (p.x1 - p.x0 - 2 * mx), p.z0 + mz + rng() * (p.z1 - p.z0 - 2 * mz));
    let d = 1e4;
    for (const o of others) {
      d = Math.min(d, Math.hypot(o.x - x, o.z - z));
      for (const s of o.trail) d = Math.min(d, segDist(x, z, s));
    }
    const score = d - 1e-3 * Math.hypot(x, z);
    if (!best || score > best.score) best = { x, z, y: p.y, score, d };
  }
  const tmp = { id: -1, x: best.x, z: best.z, y: best.y, speed: CFG.baseSpeed, baseSpeed: CFG.baseSpeed, alive: true, trail: [], active: {}, jumpT: -1, falling: false };
  let face = null;
  for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const open = probe(state, tmp, dx, dz, 60).d - 0.02 * (best.x * dx + best.z * dz); // slight pull toward the centre
    if (!face || open > face.open) face = { dx, dz, open };
  }
  return { x: best.x, z: best.z, y: best.y, dx: face.dx, dz: face.dz, score: best.score, d: best.d };
}

export function createMatch(state, mode = MODES.standard, rng = Math.random, hooks = {}) {
  const m = {
    mode, rng, phase: 'countdown', scores: {}, round: 0,
    cd: 0, timeLeft: mode.roundTime, delay: 0,
    elapsed: 0,         // Death Match: seconds since GO (counts up)
    runTime: 0,         // seconds since GO of this round / match (HUD "GO!")
    lives: {}, kills: {}, respawnIn: {}, outAt: {}, // Death Match bookkeeping (by bike id)
    lastResult: null,   // {awards:[ids], ended, reason}
    placements: null, ranks: null, winner: null,

    setMode(md) { m.mode = md; },
    playerId() { return state.playerId; },
    // Seconds to show on the HUD timer.
    clock() { return m.mode.countUp ? m.elapsed : m.timeLeft; },
    // Bonus SBCoins on top of the placement coins (Death Match: per kill).
    bonusCoins(id) { return m.mode.kind === 'deathmatch' ? (m.kills[id] || 0) * CFG.deathMatch.coinsPerKill : 0; },

    startMatch() {
      const pool = [].concat(m.mode.map); // online clients get the server's pick as start.mapId (+ start.map for custom maps)
      const id = pool[pool.length > 1 ? Math.floor(m.rng() * pool.length) : 0];
      state.map = (hooks.maps && hooks.maps[id]) || MAPS[id] || MAPS.arena; // hooks.maps = server's custom maps {id: def}
      m.scores = {}; for (const b of state.bikes) m.scores[b.id] = 0;
      m.round = 0; m.placements = null; m.ranks = null; m.winner = null; m.lastResult = null;
      if (m.mode.kind === 'deathmatch') { // scores = kills
        m.kills = m.scores; m.lives = {}; m.respawnIn = {}; m.outAt = {};
        for (const b of state.bikes) m.lives[b.id] = CFG.deathMatch.lives;
      }
      m.startRound();
    },
    startRound() {
      m.round++;
      const pts = spawnPoints(state.bikes.length, state.map);
      state.bikes.forEach((b, i) => resetBike(b, pts[i], m.mode.speed));
      state.time = 0; m.elapsed = 0; m.runTime = 0;
      m.phase = 'countdown'; m.cd = CFG.match.countdown; m.timeLeft = m.mode.roundTime; m.lastResult = null;
      if (hooks.onRoundStart) hooks.onRoundStart(m);
    },
    // Advance non-running phases (countdown, round-end pause).
    advance(dt) {
      if (m.phase === 'countdown') {
        m.cd -= dt;
        if (m.cd <= 0) { m.cd = 0; m.phase = 'running'; }
      } else if (m.phase === 'roundEnd') {
        m.delay -= dt;
        if (m.delay <= 0) {
          const w = matchWinner(m.scores, m.mode.winPoints);
          if (w === null) m.startRound();
          else { m.winner = w; m.placements = placements(m.scores); m.ranks = rankings(m.scores); m.phase = 'matchEnd'; }
        }
      }
    },
    // Call after each physics step while running. events = step() result.
    onTick(events, dt) {
      if (m.phase !== 'running') return;
      m.runTime += dt;
      if (m.mode.kind === 'deathmatch') { m.tickDeathMatch(events, dt); return; }
      m.timeLeft = Math.max(0, m.timeLeft - dt);
      const alive = state.bikes.filter((b) => b.alive).map((b) => b.id);
      let res = null, reason = '';
      if (events.length) {
        const crashed = events.map((e) => e.victim);
        res = m.mode.onCrash(m, crashed, [...alive, ...crashed]);
        reason = res.playerOut ? (res.survivors.length ? 'out' : 'draw') : res.survivors.length === 1 ? 'last' : res.survivors.length === 0 ? 'draw' : 'crash';
      }
      if ((!res || !res.ended) && m.timeLeft <= 0) { // timeout (also covers crash + timeout same tick)
        const t = m.mode.onTimeout(m, alive);
        res = { awards: [...(res ? res.awards : []), ...t.awards], ended: true, survivors: t.survivors };
        delete res.playerOut;
        reason = 'timeout';
      }
      if (!res) return;
      applyAwards(m.scores, res.awards);
      m.lastResult = { awards: res.awards, ended: res.ended, reason };
      if (res.ended) { m.phase = 'roundEnd'; m.delay = res.playerOut ? CFG.match.playerOutDelay : CFG.match.roundEndDelay; }
    },

    // ---- Death Match ----
    // Crash: lose a life; the kill goes to the trail owner (none for your own trail, walls, falling). With lives left the
    // bike respawns after respawnDelay, otherwise it is out. The match ends when <= 1 bike still has lives.
    tickDeathMatch(events, dt) {
      const D = CFG.deathMatch;
      m.elapsed += dt;
      for (const e of events) {
        m.lives[e.victim] = Math.max(0, m.lives[e.victim] - 1);
        if (e.killer !== null && e.killer !== undefined && e.killer !== e.victim) m.kills[e.killer] = (m.kills[e.killer] || 0) + 1;
        if (m.lives[e.victim] > 0) m.respawnIn[e.victim] = D.respawnDelay;
        else { delete m.respawnIn[e.victim]; m.outAt[e.victim] = m.elapsed; }
      }
      if (m.finishDeathMatch()) return;
      for (const id of Object.keys(m.respawnIn)) {
        if ((m.respawnIn[id] -= dt) > 0) continue;
        delete m.respawnIn[id];
        const b = state.bikes.find((v) => v.id === +id);
        const sp = pickRespawn(state, b, rng);
        resetBike(b, sp, m.mode.speed);           // full boost / jump meters, fresh trail
        b.spawnProt = D.spawnProtect;
        if (hooks.onRespawn) hooks.onRespawn(b, m);
      }
    },
    finishDeathMatch() {
      const ids = state.bikes.map((b) => b.id);
      if (ids.filter((id) => m.lives[id] > 0).length > 1) return false;
      const key = (id) => (m.lives[id] > 0 ? Infinity : m.outAt[id]);
      const order = ids.slice().sort((a, b) => (key(b) - key(a)) || (m.kills[b] || 0) - (m.kills[a] || 0) || a - b);
      const ranks = {};
      order.forEach((id, i) => { ranks[id] = i > 0 && key(id) === key(order[i - 1]) ? ranks[order[i - 1]] : i + 1; });
      m.placements = order; m.ranks = ranks; m.winner = order[0]; // same-tick wipe of the last bikes: tie for 1st, most kills named winner
      m.respawnIn = {}; m.phase = 'matchEnd';
      return true;
    },
  };
  return m;
}
