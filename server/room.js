// One authoritative match. Runs the shared game modules (state/physics/modes/rules) with 2-4 human bikes plus server-side bots
// (player entries with bot:true, see server/bots.js) that fill the empty slots. Abilities are server-authoritative: an `ability` input
// runs the shared js/abilities.js on the bike (lag-compensated like turns) and is broadcast as an `ev` {kind:'ability', ability:id}.
// Lag compensation (docs/MULTIPLAYER.md "Lag compensation"): an input carrying a client tick `ctick` in the recent past is applied
// at THAT tick: the bike is rewound to its recorded state, the input applied, and the bike re-simulated alone up to the current tick
// (other bikes' trails are looked up as they were at each replayed tick). Capped by CFG.net.maxRewindMs and, per player, by the server-measured rtt/2 + 30 ms.
// Tick numbering: `tick` = iterations completed so far. Every message carries the tick counter at the moment it is produced:
//   ev    -> state right BEFORE iteration `tick` runs (client applies it when its own sim reaches that tick)
//   crash -> produced by the iteration that just finished (tick = counter after it)
//   snap/round -> state after `tick` iterations.
import { CFG } from '../js/config.js';
import { createState, createBike } from '../js/state.js';
import { performance } from 'node:perf_hooks';
import { step, turnBike, canTurn, isAirborne, startBoost, startJump } from '../js/physics.js';
import { createMatch, MODES } from '../js/modes.js';
import { MAPS } from '../js/maps.js';
import { rankings } from '../js/rules.js';
import { makeRng, createAI, aiThink, aiAbilities, aiUseAbilities } from '../js/ai.js';
import { ABILITIES, isAbilityId, setLoadout, useAbilityId } from '../js/abilities.js';

const STUB = { bikes: [] }; // state for a rewound scratch bike: forced-on-others abilities (allBoost / allJump) are never rewound, see #applyInputs

const SNAP_HZ = 10;
const TURN_BUFFER_MS = CFG.inputBufferMs;   // a turn blocked by minTurnGap is retried for this long (same as the offline input buffer)
const r3 = (v) => Math.round(v * 1000) / 1000;
const RING = 48;            // per-bike state history (ticks); must exceed the rewind cap in ticks (150 ms = 18 ticks at 120 Hz)
const REWIND_SLACK_MS = 30;  // jitter / frame margin on top of rtt/2 when clamping a player's rewind
const STAT_WIN = 10000;     // ms: window of the "max" timing stats

export class Room {
  // players: [{uid, username, rank, colorIdx, send(msg), loadout?:[ability ids], bot?:true, level?:AI level}]  (bike id = index; humans first, then bots)
  constructor({ id, mode, players, seed, mapPool, timeScale = 1, maxRewindMs, onEnd, onLeave }) {
    this.id = id; this.mode = mode; this.scale = timeScale; this.onEnd = onEnd || (() => {}); this.onLeave = onLeave || (() => {});
    this.hz = CFG.tickHz; this.tick = 0; this.over = false;
    this.seed = seed ?? (Math.random() * 2 ** 32) >>> 0;
    this.players = players.map((p, i) => ({ ...p, id: i, left: false, handled: false }));
    this.hasBots = this.players.some((p) => p.bot);
    this.inbox = []; this.pend = this.players.map(() => []);
    this.t0 = null; this.done = 0; this.snapEvery = Math.round(this.hz / SNAP_HZ);
    this.sent = { phase: null, round: -1 };
    this.r1Humans = null;  // humans still in when round 1 ended (null = it never did): a win is ranked only if >= 2, see #results
    this.maxRewind = Math.min(RING - 4, Math.max(0, Math.ceil((maxRewindMs ?? CFG.net.maxRewindMs) * this.hz / 1000)));
    this.hist = this.players.map(() => new Array(RING).fill(null)); // per bike: ring of {tick, epoch, n (trail length), s (scalars)} at the START of that tick
    this.epoch = this.players.map(() => 0);       // bumped on crash / respawn / round start: older history entries are void
    this.deathTick = this.players.map(() => -1);  // tick counter right after the bike's last crash (-1 = none this round)
    this.lastIn = this.players.map(() => -1);     // effective tick of the bike's last input: later ones are never applied before it
    this.tmp = { bikes: [], time: 0, tick: 0, playerId: -1, map: null };
    this.stats = { updates: 0, ticks: 0, avgMs: 0, maxMs: 0, prevMax: 0, winStart: 0, behind: 0, behindMax: 0, prevBehind: 0, skipped: 0,
      inputs: 0, rewound: 0, clamped: 0, future: 0, fallback: 0, ignored: 0, rewindTicks: 0, maxRewindTicks: 0 };

    this.state = createState();
    this.state.playerId = -1; // nobody is "the player": with bots, hooks.humans makes the last human out end the round (js/modes.js)
    this.players.forEach((p, i) => this.state.bikes.push(createBike(i, CFG.players[p.colorIdx % CFG.players.length].color, 0, 0, 0, -1)));
    this.players.forEach((p, i) => setLoadout(this.state.bikes[i], p.loadout || []));
    this.ais = new Map(); // bot id -> AI state (js/ai.js)
    this.botRng = makeRng((this.seed ^ 0x9e3779b9) >>> 0);
    this.players.forEach((p, i) => { if (p.bot) this.ais.set(i, createAI(p.level ?? 1, i * 2)); }); // staggered thinking
    // custom maps (server/admin-maps.js poolFor): same mode with a longer map list; the defs are handed to startMatch
    this.match = createMatch(this.state, mapPool ? Object.create(MODES[mode], { map: { value: mapPool.map } }) : MODES[mode], makeRng(this.seed), {
      maps: mapPool && mapPool.maps,
      ...(this.hasBots ? { humans: () => this.players.filter((p) => !p.bot && !p.left).map((p) => p.id) } : {}), // last human out ends the round (js/modes.js)
      onRoundStart: () => { this.#killLeavers(); this.players.forEach((_, i) => { this.epoch[i]++; this.deathTick[i] = -1; this.lastIn[i] = -1; }); },
      onRespawn: (b) => { this.epoch[b.id]++; this.#ev(b, 'respawn'); },
    });
    this.match.startMatch();

    this.broadcast({
      t: 'start', mode, mapId: this.state.map.id, ...(MAPS[this.state.map.id] ? {} : { map: this.state.map }), seed: this.seed, tick0: 0, cfgOverrides: {},
      players: this.players.map((p) => ({ id: p.id, uid: p.uid, username: p.username, rank: p.rank, colorIdx: p.colorIdx, bot: !!p.bot, loadout: this.state.bikes[p.id].abilities.slice(), ...(p.admin ? { admin: true } : {}) })),
    }, (p) => ({ you: p.id }));
    this.#syncPhase();
  }

  broadcast(msg, extra) { for (const p of this.players) if (!p.left) p.send(extra ? { ...msg, ...extra(p) } : msg); }

  // Feed from the connection layer (already validated). msg.ctick = the client's estimated server tick when it pressed (lag compensation);
  // missing / not a number = apply now. Never trusted beyond the tick itself, see #applyInputs.
  input(id, msg) {
    const p = this.players[id];
    if (!p || p.left || this.over) return;
    if (this.inbox.length < 64) this.inbox.push({ id, kind: msg.kind, side: msg.side, ability: msg.ability, ctick: typeof msg.ctick === 'number' && Number.isFinite(msg.ctick) ? Math.floor(msg.ctick) : null });
  }

  // A player's final loadout for this match (the client has spent its passive charges): only during the very first countdown.
  // Ownership cannot be verified server-side (coins live in the client's save), ids are only validated. Broadcast to everyone.
  setLoadout(id, ids) {
    const p = this.players[id], m = this.match;
    if (!p || p.left || p.bot || this.over || m.phase !== 'countdown' || m.round !== 1) return false;
    const b = this.state.bikes[id];
    setLoadout(b, ids); p.loadout = b.abilities.slice();
    this.broadcast({ t: 'loadout', id, abilities: p.loadout });
    return true;
  }

  // Socket dropped / player quit: bike crashes at once and the player is charged a loss (via onLeave).
  leave(id) {
    const p = this.players[id];
    if (!p || p.left || this.over) return;
    p.left = true; p.send = () => {};
    this.onLeave(p, this);
    const humans = this.#humansIn();
    if (humans === 0 || (humans < 2 && !this.hasBots)) this.#finish('forfeit'); // with bots the last human plays on against them
  }

  #humansIn() { return this.players.filter((q) => !q.left && !q.bot).length; }

  // Catch up to wall-clock time. `now` = monotonic ms. Drift-free: the target tick count comes from the absolute start time,
  // so a late timer just runs a few ticks in one go. A stall longer than ~2 s of sim time is skipped instead of replayed.
  update(now) {
    if (this.over) return;
    if (this.t0 === null) this.t0 = now;
    const st = this.stats, w0 = performance.now();
    const perMs = this.hz * this.scale / 1000, maxLag = 2 * this.hz * this.scale;
    let due = Math.floor((now - this.t0) * perMs) - this.done;
    const behind = due;
    if (due > maxLag) { this.t0 += (due - maxLag) / perMs; due = maxLag; st.skipped++; }
    let ran = 0;
    while (due-- > 0 && !this.over) { this.#tick(); this.done++; ran++; }
    const ms = performance.now() - w0;
    if (w0 - st.winStart > STAT_WIN) { st.prevMax = st.maxMs; st.prevBehind = st.behindMax; st.maxMs = 0; st.behindMax = 0; st.winStart = w0; }
    st.updates++; st.ticks += ran; st.avgMs = st.updates === 1 ? ms : st.avgMs * 0.98 + ms * 0.02; st.behind = behind;
    if (ms > st.maxMs) st.maxMs = ms;
    if (behind > st.behindMax) st.behindMax = behind;
  }

  // Timing + lag-compensation counters for /health. ms values are per update() call (one per loop wake-up, ~16 ms).
  statsView() {
    const s = this.stats, r = (v) => Math.round(v * 1000) / 1000;
    return { id: this.id, mode: this.mode, tick: this.tick, phase: this.match.phase, updates: s.updates, ticks: s.ticks,
      avgMs: r(s.avgMs), maxMs: r(Math.max(s.maxMs, s.prevMax)), behind: s.behind, behindMax: Math.max(s.behindMax, s.prevBehind), skipped: s.skipped,
      bots: this.ais.size, lagComp: { inputs: s.inputs, rewound: s.rewound, avgRewindTicks: s.rewound ? r(s.rewindTicks / s.rewound) : 0, maxRewindTicks: s.maxRewindTicks, clamped: s.clamped, future: s.future, fallback: s.fallback, ignored: s.ignored } };
  }

  #tick() {
    const m = this.match, dt = 1 / this.hz;
    if (m.phase === 'running') this.#record();
    const events = m.phase === 'running' ? this.#applyLeaves() : [];
    if (m.phase === 'running') { this.#botThink(); events.push(...this.#applyInputs()); }
    else { this.inbox.length = 0; for (const q of this.pend) q.length = 0; }
    if (m.phase === 'running') {
      events.push(...step(this.state, dt));
      this.tick++;
      for (const e of events) this.#markDead(e.victim);
      for (const e of events) this.broadcast({ t: 'crash', tick: this.tick, victim: e.victim, killer: e.killer, cause: e.cause || (e.killer === null ? 'wall' : 'trail'), ...(m.lives[e.victim] !== undefined ? { lives: Math.max(0, m.lives[e.victim] - 1) } : {}) });
      m.onTick(events, dt);
    } else { m.advance(dt); this.tick++; }
    this.#syncPhase();
    if (this.r1Humans === null && (m.round > 1 || m.phase === 'roundEnd' || m.phase === 'matchEnd')) this.r1Humans = this.#humansIn();
    if (this.over) return;
    if (m.phase === 'matchEnd') return this.#finish('normal');
    if (this.tick % this.snapEvery === 0 && m.phase !== 'countdown') this.broadcast({ t: 'snap', tick: this.tick, phase: m.phase, roundTime: r3(m.clock()), bikes: this.state.bikes.map((b) => this.#snapBike(b)) });
  }

  #snapBike(b) {
    const o = { id: b.id, x: r3(b.x), z: r3(b.z), y: r3(b.y), dx: b.dx, dz: b.dz, speed: r3(b.speed), alive: b.alive, boostMeter: r3(b.boostMeter), jumpMeter: r3(b.jumpMeter), boosting: b.boosting, jumpT: r3(b.jumpT), falling: b.falling, vy: r3(b.vy) };
    if (this.match.lives[b.id] !== undefined) o.lives = this.match.lives[b.id];
    if (b.abilities.length) { // ability timers (seconds left): lets clients resync cooldowns / shield / turbo / stealth of every bike
      const ac = {}, cd = {}, us = [], t2 = (v) => Math.round(v * 100) / 100;
      for (const k in b.active) if (b.active[k] > 0) ac[k] = t2(b.active[k]);
      for (const k in b.cd) if (b.cd[k] > 0) cd[k] = t2(b.cd[k]);
      for (const k in b.used) if (b.used[k]) us.push(k);
      o.ab = { ac, cd, us, sl: t2(b.slowLeft) };
    }
    return o;
  }

  #ev(b, kind, side, tick = this.tick, extra) {
    this.broadcast({ t: 'ev', tick, id: b.id, kind, ...(side ? { side } : {}), ...(extra || {}), x: r3(b.x), z: r3(b.z), y: r3(b.y), dx: b.dx, dz: b.dz });
  }

  // ---- lag compensation: per-bike state history ----
  // Recorded at the START of every running tick (before leaves / inputs), so entry[T] = the bike's state after T iterations.
  #fill(e, b, id, tick = this.tick) {
    e.tick = tick; e.epoch = this.epoch[id]; e.n = b.trail.length;
    const s = e.s; for (const k in b) { const v = b[k]; if (typeof v === 'number' || typeof v === 'boolean') s[k] = v; }
    e.ab = b.abilities.length ? { cd: { ...b.cd }, active: { ...b.active }, used: { ...b.used } } : null; // nested ability timers (rewound with the scalars)
  }
  #record() {
    for (const b of this.state.bikes) {
      if (!b.alive) continue;
      const ring = this.hist[b.id], i = this.tick % RING;
      this.#fill(ring[i] || (ring[i] = { tick: -1, epoch: 0, n: 0, s: {} }), b, b.id);
    }
  }
  #entry(id, tick) { const e = this.hist[id][((tick % RING) + RING) % RING]; return e && e.tick === tick && e.epoch === this.epoch[id] ? e : null; }
  #markDead(id) { this.epoch[id]++; this.deathTick[id] = this.tick; }

  // The world other bikes' trails had after `tick` iterations, for replaying a rewound bike. Dead / reset bikes are no obstacle.
  #viewAt(o, view, tick) {
    if (!o.alive) { view.trail = []; return; }
    if (tick >= this.tick) { view.trail = o.trail; return; }
    const e = this.#entry(o.id, tick);
    if (!e || o.trail.length < e.n) { view.trail = []; return; }
    const t = o.trail.slice(0, e.n), last = t[e.n - 1];
    if (last) t[e.n - 1] = { ...last, x2: e.s.x, z2: e.s.z };
    view.trail = t;
  }

  // Apply input `i` to bike i.id as of tick T (< this.tick) and replay it up to now. Returns false (bike untouched) when it can't be
  // rewound or the input isn't valid at T; true when applied (the bike may have died on the replayed path: returned in `out`).
  #applyRewound(i, T, out) {
    const real = this.state.bikes[i.id], e = this.#entry(i.id, T);
    if (!e) return false;
    const { trail: _t, ...rest } = real;
    const c = structuredClone(rest); Object.assign(c, e.s);          // scratch copy rewound to T
    if (e.ab) { c.cd = { ...e.ab.cd }; c.active = { ...e.ab.active }; c.used = { ...e.ab.used }; }
    c.trail = real.trail.slice(0, e.n);
    if (c.trail.length) c.trail[c.trail.length - 1] = { ...c.trail[c.trail.length - 1], x2: c.x, z2: c.z };
    let ok = false;
    const air = c.jumpT >= 0; // airborne when pressed: a jump / Rocket Jump then is a double jump (clients continue the arc)
    if (i.kind === 'turn') { if (!(isAirborne(c) && !c.airTurn) && canTurn(c)) { turnBike(c, i.side); ok = true; } }
    else if (i.kind === 'boost') ok = startBoost(c);
    else if (i.kind === 'jump') ok = startJump(c);
    else if (i.kind === 'ability') ok = useAbilityId(c, i.ability, STUB);
    if (!ok) return false;
    this.#ev(c, i.kind, i.kind === 'turn' ? i.side : undefined, T, i.kind === 'ability' ? { ability: i.ability, ...(air ? { dj: true } : {}) } : i.kind === 'jump' && air ? { dj: true } : undefined);   // state right after applying, at tick T
    const ring = this.hist[i.id], put = (tick) => { this.#fill(ring[tick % RING] || (ring[tick % RING] = { tick: -1, epoch: 0, n: 0, s: {} }), c, i.id, tick); };
    put(T);                                                          // same-tick follow-up inputs start from the post-input state
    const others = this.state.bikes.filter((o) => o.id !== i.id), views = others.map((o) => ({ id: o.id, alive: false, trail: [] }));
    const tmp = this.tmp, dt = 1 / this.hz;
    tmp.map = this.state.map; tmp.time = this.state.time; tmp.bikes = [c, ...views];
    for (let k = T; k < this.tick; k++) {
      others.forEach((o, j) => this.#viewAt(o, views[j], k + 1));    // the world after iteration k
      const ev = step(tmp, dt);
      if (ev.length) { out.push(ev[0]); break; }                     // died on the replayed path (c.alive=false, trail cleared by step)
      put(k + 1);
    }
    tmp.bikes = [];
    const { trail, ...now } = c;
    Object.assign(real, now); real.trail = trail;
    return true;
  }

  // Inputs are applied in arrival order. Lag compensation: a past `ctick` (within the cap) is applied at that tick via #applyRewound;
  // a future / missing ctick, one the bike can't take at that tick, or without history (round start, respawn) is applied now.
  // Returns crash events produced by replays.
  #applyInputs() {
    const bikes = this.state.bikes, expire = this.tick + Math.ceil(TURN_BUFFER_MS * this.hz / 1000), out = [], st = this.stats;
    for (const i of this.inbox) {
      const b = bikes[i.id];
      if (!b.alive) continue;                                        // dead bikes are never revived by a claimed tick
      if (i.kind === 'ability') { if (!isAbilityId(i.ability) || ABILITIES[i.ability].type !== 'active' || !b.abilities.includes(i.ability)) continue; } // must be in the bike's loadout
      else if (i.kind !== 'turn' && i.kind !== 'boost' && i.kind !== 'jump') continue; // 'swap' only switches the client's selected slot
      st.inputs++;
      let T = i.ctick === null || (i.kind === 'ability' && ABILITIES[i.ability].once) ? this.tick : i.ctick; // allBoost / allJump hit the others NOW: never rewound
      const rtt = this.players[i.id].session?.rtt, cap = rtt == null ? this.maxRewind : Math.min(this.maxRewind, Math.ceil((rtt / 2 + REWIND_SLACK_MS) * this.hz / 1000)); // an honest input is at most ~one-way delay old
      if (T > this.tick) { T = this.tick; st.future++; }
      else if (T < this.tick - cap) { T = this.tick - cap; st.clamped++; }
      if (T < this.lastIn[i.id]) T = this.lastIn[i.id];              // never before an input already applied (events are already broadcast)
      if (T < this.deathTick[i.id]) { st.ignored++; continue; }      // the bike crashed after the claimed tick: a crash is final
      if (T < this.tick) {
        const n = out.length;
        if (this.#applyRewound(i, T, out)) {
          this.lastIn[i.id] = T; st.rewound++; st.rewindTicks += this.tick - T; if (this.tick - T > st.maxRewindTicks) st.maxRewindTicks = this.tick - T;
          continue;
        }
        st.fallback++;
      }
      this.lastIn[i.id] = this.tick;
      if (i.kind === 'turn') { const q = this.pend[i.id]; if (q.length < 2) q.push({ side: i.side, expire }); }
      else if (i.kind === 'boost') { if (startBoost(b)) this.#ev(b, 'boost'); }
      else if (i.kind === 'jump') { const air = b.jumpT >= 0; if (startJump(b)) this.#ev(b, 'jump', undefined, this.tick, air ? { dj: true } : undefined); }
      else if (i.kind === 'ability') this.#fire(b, i.ability);
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
    return out;
  }

  // Fire ability `id` on bike b now and broadcast it. allBoost / allJump force the other bikes: each one that actually started gets its
  // own boost / jump event, so clients never have to guess who was affected (they apply the ability itself without touching the others).
  #fire(b, id) {
    const hit = ABILITIES[id].once ? this.state.bikes.filter((o) => o !== b && o.alive).map((o) => [o, o.boosting, o.jumpT >= 0]) : [];
    const air = b.jumpT >= 0;
    if (!useAbilityId(b, id, this.state)) return false;
    this.#ev(b, 'ability', undefined, this.tick, { ability: id, ...(air ? { dj: true } : {}) });
    for (const [o, wasBoost, wasJump] of hit) {
      if (!wasBoost && o.boosting) this.#ev(o, 'boost');
      if (!wasJump && o.jumpT >= 0) this.#ev(o, 'jump');
    }
    return true;
  }

  // Bots think on their staggered ticks like singleplayer (js/ai.js updateAIs), but every action goes out as an ev.
  #botThink() {
    if (!this.ais.size) return;
    const rng = this.botRng, tickNo = this.tick, lv = CFG.ai.levels;
    for (const [id, ai] of this.ais) {
      const b = this.state.bikes[id];
      if (!b.alive) continue;
      const every = Math.max(1, Math.round((lv[ai.level] || lv[1]).every / Math.max(1, b.baseSpeed / CFG.baseSpeed)));
      if ((tickNo + ai.offset) % every !== 0) continue;
      const fired = b.abilities.filter((k) => ABILITIES[k].type === 'active' && !(b.cd[k] > 0));
      if (fired.length && aiUseAbilities(this.state, b, ai, rng)) { for (const k of fired) if (b.cd[k] > 0) this.#ev(b, 'ability', undefined, this.tick, { ability: k }); }
      const a = aiAbilities(this.state, b, ai, rng);
      if (a.jump) { if (startJump(b)) this.#ev(b, 'jump'); continue; } // bots never double-jump (AI only jumps grounded)
      if (a.boost && startBoost(b)) this.#ev(b, 'boost');
      const side = aiThink(this.state, b, ai, rng);
      if (side && canTurn(b)) { turnBike(b, side); this.#ev(b, 'turn', side); }
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
    const stay = this.players.filter((p) => !p.left), gone = this.players.filter((p) => p.left); // stay includes bots: they are opponents
    const place = {};
    if (reason === 'forfeit' && stay.length === 1) place[stay[0].id] = 1;
    else for (const p of stay) place[p.id] = 1 + stay.filter((q) => base[q.id] < base[p.id]).length; // competition rank among who stayed
    gone.sort((a, b) => base[a.id] - base[b.id] || a.id - b.id).forEach((p, i) => { place[p.id] = stay.length + 1 + i; });
    return ids.map((id) => {
      const p = this.players[id];
      const won = !p.left && place[id] === 1 && ids.filter((q) => place[q] === 1).length === 1;
      // Rank farming guard: a win only ranks if another human was still playing when round 1 ended (a lone survivor of early leavers / a bots-only win gives no rank).
      return { id, uid: p.uid, username: p.username, place: place[id], won, left: p.left, scores: m.scores[id] || 0, ...(p.bot ? { bot: true } : {}), ...(won && !p.bot && !((this.r1Humans ?? 0) >= 2) ? { unranked: true } : {}) };
    });
  }

  #finish(reason) {
    if (this.over) return;
    this.over = true;
    this.onEnd(this, { reason, results: this.#results(reason) });
  }
}
