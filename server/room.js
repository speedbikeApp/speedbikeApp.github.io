// One authoritative match. Runs the shared game modules (state/physics/modes/rules) with 4 human bikes and no AI.
// Tick numbering: `tick` = iterations completed so far. Every message carries the tick counter at the moment it is produced:
//   ev    -> state right BEFORE iteration `tick` runs (client applies it when its own sim reaches that tick)
//   crash -> produced by the iteration that just finished (tick = counter after it)
//   snap/round -> state after `tick` iterations.
import { CFG } from '../js/config.js';
import { createState, createBike } from '../js/state.js';
import { step, turnBike, canTurn, isAirborne, startBoost, startJump } from '../js/physics.js';
import { createMatch, MODES } from '../js/modes.js';
import { rankings } from '../js/rules.js';
import { makeRng } from '../js/ai.js';

const SNAP_HZ = 10;
const TURN_BUFFER_MS = CFG.inputBufferMs;   // a turn blocked by minTurnGap is retried for this long (same as the offline input buffer)
const r3 = (v) => Math.round(v * 1000) / 1000;

export class Room {
  // players: [{uid, username, rank, colorIdx, send(msg)}]  (bike id = index)
  constructor({ id, mode, players, seed, timeScale = 1, onEnd, onLeave }) {
    this.id = id; this.mode = mode; this.scale = timeScale; this.onEnd = onEnd || (() => {}); this.onLeave = onLeave || (() => {});
    this.hz = CFG.tickHz; this.tick = 0; this.over = false;
    this.seed = seed ?? (Math.random() * 2 ** 32) >>> 0;
    this.players = players.map((p, i) => ({ ...p, id: i, left: false, handled: false }));
    this.inbox = []; this.pend = this.players.map(() => []);
    this.t0 = null; this.done = 0; this.snapEvery = Math.round(this.hz / SNAP_HZ);
    this.sent = { phase: null, round: -1 };

    this.state = createState();
    this.state.playerId = -1; // nobody is "the player": round modes then use resolveTick, never resolvePlayerOut
    this.players.forEach((p, i) => this.state.bikes.push(createBike(i, CFG.players[p.colorIdx % CFG.players.length].color, 0, 0, 0, -1)));
    this.match = createMatch(this.state, MODES[mode], makeRng(this.seed), {
      onRoundStart: () => this.#killLeavers(),
      onRespawn: (b) => this.#ev(b, 'respawn'),
    });
    this.match.startMatch();

    this.broadcast({
      t: 'start', mode, mapId: this.state.map.id, seed: this.seed, tick0: 0, cfgOverrides: {},
      players: this.players.map((p) => ({ id: p.id, uid: p.uid, username: p.username, rank: p.rank, colorIdx: p.colorIdx, loadout: null })),
    }, (p) => ({ you: p.id }));
    this.#syncPhase();
  }

  broadcast(msg, extra) { for (const p of this.players) if (!p.left) p.send(extra ? { ...msg, ...extra(p) } : msg); }

  // Feed from the connection layer (already validated). Applied at the room's current tick, never in the past.
  input(id, msg) {
    const p = this.players[id];
    if (!p || p.left || this.over) return;
    if (this.inbox.length < 64) this.inbox.push({ id, kind: msg.kind, side: msg.side });
  }

  // Socket dropped / player quit: bike crashes at once and the player is charged a loss (via onLeave).
  leave(id) {
    const p = this.players[id];
    if (!p || p.left || this.over) return;
    p.left = true; p.send = () => {};
    this.onLeave(p, this);
    if (this.players.filter((q) => !q.left).length < 2) this.#finish('forfeit');
  }

  // Catch up to wall-clock time. `now` = monotonic ms. Drift-free: the target tick count comes from the absolute start time,
  // so a late timer just runs a few ticks in one go. A stall longer than ~2 s of sim time is skipped instead of replayed.
  update(now) {
    if (this.over) return;
    if (this.t0 === null) this.t0 = now;
    const perMs = this.hz * this.scale / 1000, maxLag = 2 * this.hz * this.scale;
    let due = Math.floor((now - this.t0) * perMs) - this.done;
    if (due > maxLag) { this.t0 += (due - maxLag) / perMs; due = maxLag; }
    while (due-- > 0 && !this.over) { this.#tick(); this.done++; }
  }

  #tick() {
    const m = this.match, dt = 1 / this.hz;
    const events = m.phase === 'running' ? this.#applyLeaves() : [];
    if (m.phase === 'running') this.#applyInputs();
    else { this.inbox.length = 0; for (const q of this.pend) q.length = 0; }
    if (m.phase === 'running') {
      events.push(...step(this.state, dt));
      this.tick++;
      for (const e of events) this.broadcast({ t: 'crash', tick: this.tick, victim: e.victim, killer: e.killer, cause: e.cause || (e.killer === null ? 'wall' : 'trail'), ...(m.lives[e.victim] !== undefined ? { lives: Math.max(0, m.lives[e.victim] - 1) } : {}) });
      m.onTick(events, dt);
    } else { m.advance(dt); this.tick++; }
    this.#syncPhase();
    if (this.over) return;
    if (m.phase === 'matchEnd') return this.#finish('normal');
    if (this.tick % this.snapEvery === 0 && m.phase !== 'countdown') this.broadcast({ t: 'snap', tick: this.tick, phase: m.phase, roundTime: r3(m.clock()), bikes: this.state.bikes.map((b) => this.#snapBike(b)) });
  }

  #snapBike(b) {
    const o = { id: b.id, x: r3(b.x), z: r3(b.z), y: r3(b.y), dx: b.dx, dz: b.dz, speed: r3(b.speed), alive: b.alive, boostMeter: r3(b.boostMeter), jumpMeter: r3(b.jumpMeter), boosting: b.boosting, jumpT: r3(b.jumpT), falling: b.falling, vy: r3(b.vy) };
    if (this.match.lives[b.id] !== undefined) o.lives = this.match.lives[b.id];
    return o;
  }

  #ev(b, kind, side) {
    this.broadcast({ t: 'ev', tick: this.tick, id: b.id, kind, ...(side ? { side } : {}), x: r3(b.x), z: r3(b.z), y: r3(b.y), dx: b.dx, dz: b.dz });
  }

  #applyInputs() {
    const bikes = this.state.bikes, expire = this.tick + Math.ceil(TURN_BUFFER_MS * this.hz / 1000);
    for (const i of this.inbox) {
      const b = bikes[i.id];
      if (!b.alive) continue;
      if (i.kind === 'turn') { const q = this.pend[i.id]; if (q.length < 2) q.push({ side: i.side, expire }); }
      else if (i.kind === 'boost') { if (startBoost(b)) this.#ev(b, 'boost'); }
      else if (i.kind === 'jump') { if (startJump(b)) this.#ev(b, 'jump'); }
      // 'ability' / 'swap': abilities are disabled online for now
    }
    this.inbox.length = 0;
    for (const b of bikes) { // turns wait (briefly) for the min turn gap, like the offline input buffer
      const q = this.pend[b.id];
      while (q.length) {
        if (!b.alive || (isAirborne(b) && !b.airTurn) || q[0].expire < this.tick) { q.shift(); continue; }
        if (!canTurn(b)) break;
        const { side } = q.shift(); turnBike(b, side); this.#ev(b, 'turn', side);
        break;
      }
    }
  }

  // Leavers are crashed once the round is running (countdown / round-end pauses wait; new rounds start them dead).
  #applyLeaves() {
    const m = this.match, events = [];
    for (const p of this.players) {
      if (!p.left || p.handled) continue;
      p.handled = true;
      const b = this.state.bikes[p.id];
      if (m.mode.kind === 'deathmatch') {
        if (!(m.lives[p.id] > 0)) continue;
        m.lives[p.id] = 1; delete m.respawnIn[p.id]; // the crash below takes the last life: out for good, no respawn
        events.push({ victim: p.id, killer: null, cause: 'leave' });
        b.alive = false; b.trail.length = 0;
      } else if (b.alive) {
        b.alive = false; b.trail.length = 0;
        events.push({ victim: p.id, killer: null, cause: 'leave' });
      }
    }
    return events;
  }

  #killLeavers() {
    for (const p of this.players) if (p.left) { const b = this.state.bikes[p.id]; b.alive = false; b.trail.length = 0; p.handled = true; }
  }

  #syncPhase() {
    const m = this.match;
    if (m.phase === this.sent.phase && m.round === this.sent.round) return;
    this.sent = { phase: m.phase, round: m.round };
    const msg = { t: 'round', tick: this.tick, phase: m.phase, round: m.round, scores: { ...m.scores }, lastResult: m.lastResult, roundTime: r3(m.clock()), cd: r3(m.cd) };
    if (m.mode.kind === 'deathmatch') msg.lives = { ...m.lives };
    if (m.phase === 'countdown') msg.bikes = this.state.bikes.map((b) => this.#snapBike(b)); // fresh spawns
    this.broadcast(msg);
  }

  #results(reason) {
    const m = this.match, ids = this.players.map((p) => p.id);
    const base = m.ranks || rankings(m.scores);
    const stay = this.players.filter((p) => !p.left), gone = this.players.filter((p) => p.left);
    const place = {};
    if (reason === 'forfeit' && stay.length === 1) place[stay[0].id] = 1;
    else for (const p of stay) place[p.id] = 1 + stay.filter((q) => base[q.id] < base[p.id]).length; // competition rank among who stayed
    gone.sort((a, b) => base[a.id] - base[b.id] || a.id - b.id).forEach((p, i) => { place[p.id] = stay.length + 1 + i; });
    return ids.map((id) => {
      const p = this.players[id];
      const won = !p.left && place[id] === 1 && ids.filter((q) => place[q] === 1).length === 1;
      return { id, uid: p.uid, username: p.username, place: place[id], won, left: p.left, scores: m.scores[id] || 0 };
    });
  }

  #finish(reason) {
    if (this.over) return;
    this.over = true;
    this.onEnd(this, { reason, results: this.#results(reason) });
  }
}
