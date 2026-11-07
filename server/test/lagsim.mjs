// Virtual-time latency simulator: the REAL server Room + four client sims (js/netsim.js, driven like js/online.js) connected through
// delayed, ordered "sockets". Used by lag.test.mjs. No sockets, no wall clock: a 20 s match runs in well under a second.
import { CFG } from '../../js/config.js';
import { Room } from '../room.js';
import { defaultRank } from '../../js/ranks.js';
import { createState, createBike, resetBike, spawnPoints } from '../../js/state.js';
import { MAPS } from '../../js/maps.js';
import { MODES } from '../../js/modes.js';
import * as NS from '../../js/netsim.js';
import { ClockSync } from '../../js/net.js';

export const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * opts: { rttMs, jitterMs (+- per direction), seed, seconds (sim length after the round starts), loopMs (server wake-up, default 16),
 *         presses: [{ at (ms after run start), who, kind, side }], frameMs (client frame, default 16.67), maxRewindMs, hooks }
 * Returns { room, clients, log, runAt }.  client = { id, state, sim, tc, clock, phase, ownEv:[{kind, landing, corr}], snapErr:[], remoteCorr:[], crashes:[] }
 */
export function runLag(opts) {
  const { rttMs = 0, jitterMs = 0, seconds = 8, loopMs = 16, frameMs = 1000 / 60, presses = [], seed = 1, maxRewindMs } = opts;
  const rnd = mulberry(seed), ow = rttMs / 2;
  let now = 0;
  const queue = []; // {at, seq, fn}
  let seq = 0;
  const post = (at, fn) => { const e = { at, seq: seq++, fn }; let i = queue.length; while (i > 0 && (queue[i - 1].at > at || 0)) i--; queue.splice(i, 0, e); };
  const lastAt = new Map();
  const link = (key, fn) => { // ordered link with jitter: never delivers earlier than the previous message on the same link
    const at = Math.max(lastAt.get(key) || 0, now + Math.max(0, ow + (rnd() * 2 - 1) * jitterMs));
    lastAt.set(key, at); post(at, fn);
  };

  const clients = [0, 1, 2, 3].map((id) => ({ id, phase: 'idle', ownEv: [], snapErr: [], remoteCorr: [], crashes: [], clock: new ClockSync(), tc: new NS.TickClock(CFG.tickHz), state: null, sim: null, pings: new Map(), pingSeq: 0 }));
  const log = [];
  const room = new Room({
    id: 1, mode: 'standard', seed: 7, maxRewindMs, onEnd: () => {}, onLeave: () => {},
    players: clients.map((c) => ({ uid: 'u' + c.id, username: 'P' + c.id, rank: defaultRank(), colorIdx: c.id, send: (m) => link('s2c' + c.id, () => onServerMsg(c, m)) })),
  });
  const toServer = (c, msg) => link('c2s' + c.id, () => {
    if (msg.t === 'in') room.input(c.id, msg);
    else if (msg.t === 'ping') link('s2c' + c.id, () => { const sent = c.pings.get(msg.c); if (sent !== undefined) c.clock.addPong(sent, now, now); });
  });

  // ---- client side (mirrors js/online.js) ----
  for (const c of clients) {
    const st = createState(); st.playerId = c.id; st.map = MAPS.arena;
    st.bikes = clients.map((p) => createBike(p.id, 0xffffff, 0, 0, 0, -1));
    const pts = spawnPoints(4, st.map); st.bikes.forEach((b, i) => resetBike(b, pts[i], MODES.standard.speed));
    c.state = st; c.sim = NS.createSim(st, 0);
  }
  const bike = (c, id) => c.state.bikes.find((b) => b.id === id);
  function advance(c) {
    const est = c.tc.estimate(now, c.clock.rtt / 2);
    if (est === null) return;
    const target = Math.floor(est);
    if (c.phase === 'running') { let n = target - c.sim.tick; if (n > CFG.net.maxCatchup) { c.sim.tick = target - CFG.net.maxCatchup; n = CFG.net.maxCatchup; } while (n-- > 0) NS.stepSim(c.sim); }
    else if (target > c.sim.tick) c.sim.tick = target;
  }
  function onServerMsg(c, m) {
    if (m.t === 'start' || m.t === 'lobby') return;
    if (typeof m.tick === 'number') c.tc.sample(m.tick, now);
    const sim = c.sim;
    if (m.t === 'round') {
      if (m.phase === 'countdown') { const pts = spawnPoints(4, c.state.map); c.state.bikes.forEach((b, i) => { resetBike(b, pts[i], MODES.standard.speed); b.trail[0].ct = -1; b.vox = b.voz = 0; }); NS.resetSim(sim, m.tick); c.phase = 'countdown'; }
      else if (m.phase === 'running') { c.phase = 'running'; sim.tick = m.tick; sim.hist.clear(); c.runTick = m.tick; }
      else c.phase = m.phase;
    } else if (m.t === 'snap') {
      if (c.phase !== 'running') return;
      advance(c);
      const r = NS.applySnap(sim, m, sim.tick);
      for (const [id, e] of Object.entries(r.err)) c.snapErr.push({ id: +id, err: Math.abs(e), own: +id === c.id });
    } else if (m.t === 'ev') {
      if (c.phase !== 'running') return;
      advance(c);
      const b = bike(c, m.id), cap = b && NS.visCapture(b);
      const pend = m.id === c.id ? sim.pending.find((p) => p.kind === m.kind && (m.kind !== 'turn' || p.side === m.side)) : null;
      const r = NS.applyEvent(sim, m, sim.tick);
      if (b && r.applied) {
        const own = m.id === c.id;
        const corr = NS.visBlend(b, cap, own ? { maxDist: CFG.net.blendOwnMax } : { maxDist: CFG.net.blendRemoteMax, allowTurn: true });
        if (own) c.ownEv.push({ died: r.died, pendLeft: sim.pending.length, before: { x: cap.x, z: cap.z, dx: cap.dx, dz: cap.dz }, after: { x: b.x, z: b.z, dx: b.dx, dz: b.dz }, evPos: { x: m.x, z: m.z }, kind: m.kind, tick: m.tick, ctick: pend ? pend.ctick : null, corr, shown: Math.hypot(b.vox || 0, b.voz || 0), landing: pend && pend.pos ? Math.hypot(m.x - pend.pos.x, m.z - pend.pos.z) : null });
        else c.remoteCorr.push({ id: m.id, corr });
      }
    } else if (m.t === 'crash') {
      if (c.phase === 'running') advance(c);
      NS.applyCrash(sim, m); c.crashes.push({ victim: m.victim, tick: m.tick });
    }
  }
  function press(c, p) {
    if (c.phase !== 'running') return;
    advance(c);
    const me = bike(c, c.id), sim = c.sim;
    if (!me.alive) return;
    if (NS.predictInput(sim, c.id, { kind: p.kind, side: p.side })) {
      const pend = sim.pending[sim.pending.length - 1];
      pend.pos = { x: me.x, z: me.z }; // where the player's own screen turned
      toServer(c, { t: 'in', kind: p.kind, ...(p.kind === 'turn' ? { side: p.side } : {}), ctick: sim.tick, ...(p.ctickOverride !== undefined ? { ctick: p.ctickOverride(sim.tick) } : {}) });
    }
  }

  // ---- main loop (1 ms resolution) ----
  const runAt = 3300; // first press time base: well after the 3 s countdown
  const end = runAt + seconds * 1000;
  const todo = presses.map((p) => ({ ...p, t: runAt + p.at })).sort((a, b) => a.t - b.t);
  let nextServer = 0, nextFrame = 0, nextPing = 0, pi = 0;
  for (now = 0; now <= end; now += 1) {
    while (queue.length && queue[0].at <= now) queue.shift().fn();
    while (pi < todo.length && todo[pi].t <= now) { const p = todo[pi++]; press(clients[p.who], p); if (opts.hooks && opts.hooks.afterPress) opts.hooks.afterPress({ room, clients, now, p }); }
    if (now >= nextServer) { room.update(now); nextServer = now + loopMs; }
    if (now >= nextFrame) { for (const c of clients) if (c.phase !== 'idle') { advance(c); NS.prunePending(c.sim); NS.visDecay(c.state.bikes, frameMs / 1000); } nextFrame = now + frameMs; }
    if (now >= nextPing) { for (const c of clients) { const n = ++c.pingSeq; c.pings.set(n, now); toServer(c, { t: 'ping', c: n }); } nextPing = now + 500; }
    if (opts.hooks && opts.hooks.each) opts.hooks.each({ room, clients, now });
  }
  return { room, clients, log, runAt, now: () => now };
}

/**
 * Freeze the world and compare: advances the room and the clients to one common tick (no inputs in flight), then returns a list of
 * differences (empty = identical worlds incl. trails). tol = position tolerance in units (server rounds event coordinates to 1e-3).
 */
export function diffWorlds({ room, clients }, tol = 2e-3) {
  const target = Math.max(room.tick, ...clients.map((c) => c.sim.tick));
  const diffs = [];
  while (room.tick < target) room.update(room.t0 + (room.done + 1) * 1000 / (room.hz * room.scale) + 0.01);
  for (const c of clients) { c.phase = 'running'; while (c.sim.tick < target) NS.stepSim(c.sim); }
  const segs = (b) => b.trail.map((s) => [s.x1, s.z1, s.x2, s.z2, s.y0 || 0]);
  for (const c of clients) {
    for (const sb of room.state.bikes) {
      const cb = c.state.bikes.find((b) => b.id === sb.id), tag = `client ${c.id} bike ${sb.id}`;
      if (cb.alive !== sb.alive) { diffs.push(`${tag}: alive ${cb.alive} vs server ${sb.alive}`); continue; }
      if (!sb.alive) continue;
      for (const k of ['x', 'z', 'y']) if (Math.abs(cb[k] - sb[k]) > tol) diffs.push(`${tag}: ${k} ${cb[k]} vs ${sb[k]}`);
      if (cb.dx !== sb.dx || cb.dz !== sb.dz) diffs.push(`${tag}: heading`);
      const a = segs(cb), s = segs(sb);
      if (a.length !== s.length) { diffs.push(`${tag}: ${a.length} trail segments vs server ${s.length}`); continue; }
      a.forEach((row, i) => row.forEach((v, j) => { if (Math.abs(v - s[i][j]) > tol) diffs.push(`${tag}: segment ${i}[${j}] ${v} vs ${s[i][j]}`); }));
    }
  }
  return diffs;
}
