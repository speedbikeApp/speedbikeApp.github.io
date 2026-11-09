// Client-side online simulation sync (pure: physics + state only, no DOM / three / socket). See NOTES.md "Client netcode".
//
// The client runs the SAME deterministic sim as the server for all bikes at the estimated server tick. The server broadcasts
// every input as an authoritative event {tick,id,kind,x,z,y,dx,dz} (state right after applying it). To apply one:
//   rewind that bike to the event tick (drop trail segments created after it, move the head to the event state),
//   re-apply the local player's still-unconfirmed inputs (own bike only: server reconciliation), then re-simulate that single
//   bike forward to the current tick. Trails stay consistent because every segment is tagged with the tick that created it (`ct`).
// 10 Hz `snap`s only correct drift (position beyond an epsilon / wrong heading / bike alive on the server but dead here).
import { CFG } from './config.js';
import { step, turnBike, canTurn, startBoost, startJump } from './physics.js';
import { newSegment, resetBike } from './state.js';
import { ABILITIES, useAbilityId } from './abilities.js';

// Abilities are replayed on a bike alone: allBoost / allJump hit the others, and those arrive as their own boost / jump events from the server.
const NO_OTHERS = { bikes: [] };

export const MAX_RESIM = 90; // ticks (0.75 s): never replay more than this for one correction
const dtOf = () => 1 / CFG.tickHz;

// ---- server tick estimate -------------------------------------------------------------------------------------------------
// Every ev / snap / round message carries a server tick. offset = tick - recvMs*hz/1000 is lower than the true value by that
// message's latency, so the MAX over a short window is the least-delayed sample. Estimate(now) adds the one-way latency back.
export class TickClock {
  constructor(hz = CFG.tickHz, keep = 24) { this.hz = hz; this.keep = keep; this.samples = []; this.best = null; }
  reset() { this.samples = []; this.best = null; }
  sample(tick, recvMs) {
    if (typeof tick !== 'number' || !isFinite(tick)) return;
    this.samples.push(tick - recvMs * this.hz / 1000);
    if (this.samples.length > this.keep) this.samples.shift();
    this.best = Math.max(...this.samples);
  }
  get ready() { return this.best !== null; }
  /** Estimated current server tick (float), or null before the first sample. halfRttMs = one-way latency. */
  estimate(nowMs, halfRttMs = 0) { return this.best === null ? null : this.best + (nowMs + halfRttMs) * this.hz / 1000; }
}

// ---- sim container --------------------------------------------------------------------------------------------------------
/** sim = {state, tick, pending:[{kind,side,ctick}], tmp}. tick = completed steps = the server tick we are simulating. */
export function createSim(state, tick = 0) { return { state, tick, pending: [], hist: new Map(), tmp: { bikes: [], time: 0, tick: 0, playerId: state.playerId, map: state.map } }; }
/** New round / fresh start: forget history and unconfirmed inputs. */
export function resetSim(sim, tick = sim.tick) { sim.tick = tick; sim.pending.length = 0; sim.hist.clear(); }

// Per-bike scalar history (jump / boost timers, height, speed ...) so a rewind restores the ability state of that tick too
// (plus the nested ability timers cd / active / used of bikes with a loadout).
const HIST = MAX_RESIM + 40;
// predDead is not history: restoring a stale `true` left alive bikes with an empty trail (exception every frame)
function scalars(b) { const o = {}; for (const k in b) { if (k === 'predDead') continue; const v = b[k]; if (typeof v === 'number' || typeof v === 'boolean') o[k] = v; } return o; }
function record(sim) {
  for (const b of sim.state.bikes) {
    let h = sim.hist.get(b.id); if (!h) sim.hist.set(b.id, h = []);
    h.push({ tick: sim.tick, s: scalars(b), ab: b.abilities && b.abilities.length ? { cd: { ...b.cd }, active: { ...b.active }, used: { ...b.used } } : null });
    if (h.length > HIST) h.shift();
  }
}
// After a bike was re-simulated (event / correction), its recorded history for the replayed ticks must say what the replay computed, or
// the next snapshot would be projected from the stale pre-correction state.
function patchHist(sim, b, tick) {
  const h = sim.hist.get(b.id); if (!h || !h.length) return;
  const i = tick - h[0].tick, e = i >= 0 && i < h.length ? h[i] : null;
  if (!e || e.tick !== tick) return;
  e.s = scalars(b);
  e.ab = b.abilities && b.abilities.length ? { cd: { ...b.cd }, active: { ...b.active }, used: { ...b.used } } : null;
}
const histAt = (sim, id, tick) => {
  const h = sim.hist.get(id); if (!h || !h.length) return null;
  const e = h.find((x) => x.tick === tick); if (!e) return null;
  return e.ab ? { ...e.s, cd: { ...e.ab.cd }, active: { ...e.ab.active }, used: { ...e.ab.used } } : e.s; // fresh nested copies: the bike must never alias the history
};

export function tagSegs(b, tick) { for (const s of b.trail) if (s.ct === undefined) s.ct = tick; }
const bikeOf = (sim, id) => sim.state.bikes.find((v) => v.id === id);

/** One tick of the whole world. Returns crash events [{victim,killer,cause?}]. */
export function stepSim(sim) {
  record(sim);
  for (const b of sim.state.bikes) tagSegs(b, sim.tick);
  const keep = new Map(); for (const b of sim.state.bikes) if (b.alive && b.id !== sim.state.playerId) keep.set(b.id, b.trail.slice());
  const events = step(sim.state, dtOf());
  sim.tick++;
  for (const e of events) { const v = bikeOf(sim, e.victim); if (v) v.deadTick = sim.tick; } // lets a snapshot older than this death be recognised as stale
  // Another bike crashing HERE is only a guess (its turn may still be on the way): it stops but keeps its trail (shown, still solid) until
  // the server's crash message (applyCrash) or an event / snapshot says it lives. Erasing it hid trails that still kill on the server.
  for (const e of events) { const v = bikeOf(sim, e.victim); if (v && keep.has(v.id)) { v.trail = keep.get(v.id); v.predDead = true; } }
  for (const b of sim.state.bikes) tagSegs(b, sim.tick);
  return events.filter((e) => !keep.has(e.victim)); // only confirmed-here deaths (our own) get the crash effect now
}

// ---- inputs ---------------------------------------------------------------------------------------------------------------
/** Apply a local/pending input to a bike now. Returns true if it took effect. Marks turn segments `pred`. */
export function applyInput(b, p) {
  if (!b.alive) return false;
  if (p.kind === 'turn') {
    if (!canTurn(b)) return false;
    turnBike(b, p.side);
    const s = b.trail[b.trail.length - 1]; if (s) s.pred = true;
    return true;
  }
  if (p.kind === 'boost') return startBoost(b);
  if (p.kind === 'jump') return startJump(b);
  if (p.kind === 'ability') return useAbilityId(b, p.ability, NO_OTHERS);
  return false;
}

/** Local player pressed something: predict it now and remember it until the server confirms (or it times out). */
export function predictInput(sim, bikeId, p) {
  const b = bikeOf(sim, bikeId);
  if (!b || !applyInput(b, p)) return false;
  tagSegs(b, sim.tick);
  sim.pending.push({ ...p, ctick: sim.tick });
  return true;
}
export function prunePending(sim, maxAge = 180) { sim.pending = sim.pending.filter((p) => sim.tick - p.ctick <= maxAge); }

// Re-simulate ONE bike from fromTick to toTick (collides with its own trail only: other bikes' trails at "now" would give false
// hits in the past). pend = pending inputs to replay at their ticks (own bike). Returns true if the bike died.
export function advanceBike(sim, b, fromTick, toTick, pend = null) {
  const tmp = sim.tmp; tmp.bikes.length = 0; tmp.bikes.push(b); tmp.map = sim.state.map; tmp.time = sim.state.time;
  const todo = pend ? pend.map((p) => ({ ...p, done: false })) : [];
  const dt = dtOf();
  let died = false;
  const to = Math.min(toTick, fromTick + MAX_RESIM);
  for (let k = fromTick; k < to; k++) {
    for (const p of todo) if (!p.done && p.ctick <= k) { p.done = true; applyInput(b, p); }
    patchHist(sim, b, k);
    tagSegs(b, k);
    if (step(tmp, dt).length) { died = true; break; }
    tagSegs(b, k + 1);
  }
  // inputs pressed at exactly the tick we replayed up to (their step has not run yet) still have to be re-applied, or the rewind would drop them
  if (!died) { for (const p of todo) if (!p.done && p.ctick <= to) { p.done = true; applyInput(b, p); } tagSegs(b, to); }
  tmp.bikes.length = 0;
  return died;
}

// Drop trail segments created after `tick` (keeps at least the first).
function rewindTrail(b, tick) {
  let n = b.trail.length;
  while (n > 1 && b.trail[n - 1].ct !== undefined && b.trail[n - 1].ct > tick) n--;
  b.trail.length = n;
}
function dropPredicted(b) {
  const i = b.trail.findIndex((s) => s.pred);
  if (i > 0) b.trail.length = i;
}
// Move the newest segment's far end to (x,z) along its own axis (axis = axis of heading dx,dz).
function endSegment(b, x, z, dx, dz) {
  const s = b.trail[b.trail.length - 1]; if (!s) return;
  if (dx !== 0) { s.x2 = x; s.z2 = s.z1; } else { s.z2 = z; s.x2 = s.x1; }
  s.y0 = s.y0 || 0;
}

/**
 * Apply an authoritative event. nowTick = estimated current server tick. Returns {applied, died}.
 * Own bike (id === sim.state.playerId): the matching pending input is consumed and the rest replayed.
 */
export function applyEvent(sim, ev, nowTick = sim.tick) {
  const b = bikeOf(sim, ev.id);
  if (b && ev.kind === 'respawn' && typeof ev.tick === 'number') { // Death Match: fresh bike + trail at the authoritative spawn
    resetBike(b, { x: ev.x, z: ev.z, y: ev.y || 0, dx: ev.dx, dz: ev.dz }, b.baseSpeed);
    b.spawnProt = CFG.deathMatch.spawnProtect; b.trail[0].ct = ev.tick;
    return { applied: true, died: advanceBike(sim, b, ev.tick, nowTick), respawned: true };
  }
  if (!b || (!b.alive && !b.predDead) || typeof ev.tick !== 'number') return { applied: false, died: false };
  if (b.predDead) { b.alive = true; b.predDead = false; } // the crash we guessed did not happen: this event rewinds the bike before it
  if (ev.kind !== 'turn' && ev.kind !== 'boost' && ev.kind !== 'jump' && ev.kind !== 'ability') return { applied: false, died: false };
  if (ev.kind === 'ability' && !(ABILITIES[ev.ability] && ABILITIES[ev.ability].type === 'active')) return { applied: false, died: false };
  const own = ev.id === sim.state.playerId;
  let resimmed = false;
  if (own) { // consume the matching prediction
    const i = sim.pending.findIndex((p) => p.kind === ev.kind && (ev.kind !== 'turn' || ev.side === undefined || p.side === ev.side) && (ev.kind !== 'ability' || p.ability === ev.ability));
    const pr = i >= 0 ? sim.pending.splice(i, 1)[0] : null;
    dropPredicted(b);
    // The server applied it LATER than we predicted (stale / future ctick, or beyond the server's rewind cap): the prediction's effects between
    // its tick and the event tick (jump arc trail steps, boost speed) must go too. Undo from just before the press and replay without it.
    if (pr && pr.ctick < ev.tick && ev.tick - pr.ctick <= MAX_RESIM) {
      const before = histAt(sim, b.id, pr.ctick - 1);
      if (before) {
        rewindTrail(b, pr.ctick - 1); Object.assign(b, before, { alive: true });
        const s = b.trail[b.trail.length - 1]; if (s) { s.x2 = b.x; s.z2 = b.z; }
        resimmed = true;
        if (advanceBike(sim, b, pr.ctick - 1, ev.tick)) return { applied: true, died: true };
      }
    }
  }
  rewindTrail(b, ev.tick);
  const past = resimmed ? null : histAt(sim, b.id, ev.tick); if (past) Object.assign(b, past, { alive: true });
  const ndx = ev.dx, ndz = ev.dz;
  if (ev.kind === 'turn') {
    // the segment being left runs along the axis perpendicular to the new heading
    endSegment(b, ev.x, ev.z, ndx !== 0 ? 0 : 1, ndz !== 0 ? 0 : 1);
    b.x = ev.x; b.z = ev.z; if (typeof ev.y === 'number') b.y = ev.y; b.dx = ndx; b.dz = ndz;
    const seg = newSegment(b); seg.ct = ev.tick; b.trail.push(seg);
  } else {
    b.x = ev.x; b.z = ev.z; if (typeof ev.y === 'number') b.y = ev.y; b.dx = ndx; b.dz = ndz;
    endSegment(b, ev.x, ev.z, ndx, ndz);
    if (ev.kind === 'boost') { b.boosting = false; b.boostMeter = 1; startBoost(b); }
    else if (ev.kind === 'jump') applyJump(b, ev.dj);
    else applyAbilityEv(b, ev.ability, ev.dj);
  }
  const keepTrail = own ? null : b.trail.slice();
  const died = advanceBike(sim, b, ev.tick, nowTick, own ? sim.pending : null);
  // a remote bike replayed without its NEXT events (still on the way) may crash only here: a guess, like stepSim's (keeps its trail)
  if (died && !own) { b.trail = keepTrail; b.predDead = true; return { applied: true, died: false }; }
  return { applied: true, died };
}

// Jump event. dj = the server made it a double jump (airborne, Double Jump equipped): continue the arc from the current height instead
// of starting a fresh one. A prediction of the same press may already have been applied on this bike: both paths start from a clean slate.
function applyJump(b, dj) {
  if (dj && b.jumpT >= 0) { b.djUsed = false; startJump(b); return; }
  b.jumpT = -1; b.falling = false; b.djUsed = false; b.jumpMeter = 1; startJump(b);
}
// Active ability event: clear whatever a prediction of the same press set (cooldown / duration / once flag), then run the real thing.
function applyAbilityEv(b, id, dj) {
  b.cd[id] = 0; b.active[id] = 0; if (ABILITIES[id].once) b.used[id] = false;
  if (id === 'rocketJump') { if (dj && b.jumpT >= 0) b.djUsed = false; else { b.jumpT = -1; b.falling = false; b.djUsed = false; b.jumpMeter = 1; } }
  useAbilityId(b, id, NO_OTHERS);
}

/** Server says this bike crashed. Returns true if it was still alive here (caller shows the burst). */
export function applyCrash(sim, msg) {
  const b = bikeOf(sim, msg.victim);
  if (!b || (!b.alive && !b.predDead)) return false;
  b.alive = false; b.predDead = false; b.trail.length = 0;
  return true;
}

// Ability timers of a snapshot (seconds left AT the snapshot tick, n ticks ago): fix cooldowns / shield / turbo / stealth that drifted
// (a prediction the server refused, a late event). Small differences are ignored so a healthy bike never jitters.
function syncAbilities(b, ab, n) {
  const age = n * dtOf(), TOL = 0.12;
  for (const id of b.abilities) {
    for (const [dst, src] of [[b.active, ab.ac || {}], [b.cd, ab.cd || {}]]) {
      const want = Math.max(0, (src[id] || 0) - age), have = dst[id] || 0;
      if (Math.abs(want - have) > TOL) dst[id] = want;
    }
    if (ABILITIES[id].once) b.used[id] = !!(ab.us && ab.us.includes(id));
  }
  if (typeof ab.sl === 'number') { const want = Math.max(0, ab.sl - age); if (Math.abs(want - b.slowLeft) > TOL) b.slowLeft = want; }
}

// Copy of a bike without its trail (deep enough that stepping the copy never touches the original's nested ability state).
function cloneBike(b) { const { trail, ...rest } = b; const c = structuredClone(rest); c.trail = []; return c; }

/**
 * Apply a 10 Hz snapshot (drift correction). opts.eps = position tolerance (units). Returns {corrected:[ids], revived:[ids]}.
 * Crashes are NOT taken from snaps (the `crash` message does that); a bike alive on the server but dead here is put back.
 */
export function applySnap(sim, snap, nowTick = sim.tick, opts = {}) {
  const eps = opts.eps ?? CFG.net.snapEps, out = { corrected: [], revived: [], err: {} };
  const n = Math.max(0, Math.min(nowTick - snap.tick, MAX_RESIM));
  const tmp = sim.tmp;
  for (const sb of snap.bikes || []) {
    const b = bikeOf(sim, sb.id);
    if (!b || !sb.alive) continue;
    if (typeof sb.lives === 'number') b.lives = sb.lives;
    if (!b.alive && b.predDead) { b.alive = true; b.predDead = false; if (!b.trail.length) b.trail.push(newSegment(b)); } // guessed crash, server says alive: correct it like a drifted bike (keeps its trail)
    const revive = !b.alive;
    if (b.alive && sb.ab && b.abilities && b.abilities.length && !(sb.id === sim.state.playerId && sim.pending.length)) syncAbilities(b, sb.ab, n);
    // Our own bike crashed locally while an input of ours is still in flight: the server may not know that input yet (it will replay it
    // at its tick and may well crash us), so this snap is not evidence of a false crash. Wait for the ev / crash message.
    if (revive && sb.id === sim.state.playerId && sim.pending.length) continue;
    // This bike died here AFTER the snapshot was taken (the snapshot is older than the crash, the `crash` message is still on its way): not a false crash.
    if (revive && b.deadTick !== undefined && b.deadTick > snap.tick) continue;
    // server state projected forward to now, on a scratch copy
    const c = cloneBike(b);
    const past = histAt(sim, b.id, snap.tick); if (past && b.alive) Object.assign(c, past);
    c.x = sb.x; c.z = sb.z; c.y = typeof sb.y === 'number' ? sb.y : b.y; c.dx = sb.dx; c.dz = sb.dz; c.alive = true;
    if (typeof sb.speed === 'number') c.speed = sb.speed;
    if (typeof sb.boostMeter === 'number') c.boostMeter = sb.boostMeter;
    if (typeof sb.jumpMeter === 'number') c.jumpMeter = sb.jumpMeter;
    c.trail = [newSegment(c)];
    tmp.bikes.length = 0; tmp.bikes.push(c); tmp.map = sim.state.map; tmp.time = sim.state.time;
    for (let k = 0; k < n; k++) { if (step(tmp, dtOf()).length) break; }
    tmp.bikes.length = 0;
    if (!c.alive) continue;
    const own = sb.id === sim.state.playerId;
    if (revive) {
      b.alive = true; b.x = c.x; b.z = c.z; b.y = c.y; b.dx = c.dx; b.dz = c.dz; b.speed = c.speed;
      b.jumpT = -1; b.falling = !!c.falling; b.vy = c.vy || 0; b.boosting = false;
      if (typeof sb.boostMeter === 'number') b.boostMeter = sb.boostMeter;
      if (typeof sb.jumpMeter === 'number') b.jumpMeter = sb.jumpMeter;
      if (opts.spawnProt) b.spawnProt = opts.spawnProt;
      b.trail = [newSegment(b)]; b.trail[0].ct = nowTick;
      out.revived.push(b.id);
      continue;
    }
    if (own && sim.pending.length) continue; // an input of ours is still in flight: the snap would be older than the prediction
    const dist = Math.hypot(c.x - b.x, c.z - b.z), dirOff = c.dx !== b.dx || c.dz !== b.dz;
    out.err[b.id] = dirOff ? -dist : dist; // for diagnostics (negative = heading differs)
    if (dist <= eps && !dirOff) {
      if (typeof sb.boostMeter === 'number' && !own) b.boostMeter = c.boostMeter;
      if (typeof sb.jumpMeter === 'number' && !own) b.jumpMeter = c.jumpMeter;
      continue;
    }
    // correct: same axis -> slide the head along it; else restart the trail from the authoritative head
    const last = b.trail[b.trail.length - 1];
    const sameAxis = !dirOff && last && (c.dx !== 0 ? Math.abs(c.z - b.z) < 0.05 : Math.abs(c.x - b.x) < 0.05);
    b.x = c.x; b.z = c.z; b.dx = c.dx; b.dz = c.dz; if (Math.abs(c.y - b.y) > 0.5) b.y = c.y; b.speed = c.speed;
    if (sameAxis) endSegment(b, c.x, c.z, c.dx, c.dz);
    else { const seg = newSegment(b); seg.ct = nowTick; b.trail.push(seg); }
    out.corrected.push(b.id);
  }
  return out;
}

// ---- visual error smoothing (render-only) ---------------------------------------------------------------------------------
// The sim (and every trail) is always exact. When a correction moves a bike, the bike MESH / camera keep showing the old position
// and glide to the new one: b.vox / b.voz = (displayed - simulated) position, decayed to 0 each frame by visDecay.
/** Where the bike is currently displayed (sim position + leftover offset) and its heading. Call BEFORE a correction. */
export function visCapture(b) { return { x: b.x + (b.vox || 0), z: b.z + (b.voz || 0), dx: b.dx, dz: b.dz }; }
/**
 * Call AFTER the correction: keep showing the captured position. Errors beyond opts.maxDist are snapped (offset cleared); a heading
 * change also snaps unless opts.allowTurn (remote bikes: their turn event legitimately arrives late). Returns the error shown (units).
 */
export function visBlend(b, was, opts = {}) {
  const ex = was.x - b.x, ez = was.z - b.z, d = Math.hypot(ex, ez);
  const turned = was.dx !== b.dx || was.dz !== b.dz;
  if (!b.alive || d < 0.02 || d > (opts.maxDist ?? 3) || (turned && !opts.allowTurn)) { b.vox = 0; b.voz = 0; return d; }
  b.vox = ex; b.voz = ez;
  return d;
}
/** Per-frame decay of every bike's offset (exponential; tau = blendMs / 3 so ~95% is gone after blendMs). */
export function visDecay(bikes, dt, blendMs = CFG.net.blendMs) {
  const k = Math.exp(-dt / Math.max(0.001, blendMs / 3000));
  for (const b of bikes) {
    if (!b.vox && !b.voz) continue;
    b.vox *= k; b.voz *= k;
    if (Math.abs(b.vox) < 0.005 && Math.abs(b.voz) < 0.005) { b.vox = 0; b.voz = 0; }
  }
}
