// Server-authoritative abilities + bots: Room unit tests (fake clock) and a client-sim convergence check (js/netsim.js against the Room).
import assert from 'node:assert/strict';
import { Room } from '../room.js';
import { createAI, aiThink, makeRng } from '../../js/ai.js';
import { canTurn } from '../../js/physics.js';
import { defaultRank } from '../../js/ranks.js';
import { CFG } from '../../js/config.js';
import { sanitizeLoadout, parseClientMessage } from '../protocol.js';
import { makeBots, botLevel, BOT_NAMES } from '../bots.js';
import { createState, createBike, resetBike, spawnPoints } from '../../js/state.js';
import { setLoadout, ABILITIES } from '../../js/abilities.js';
import { createSim, resetSim, stepSim, predictInput, prunePending, applyEvent, applySnap, applyCrash } from '../../js/netsim.js';
import { MAPS } from '../../js/maps.js';

const HZ = CFG.tickHz, DT = 1 / HZ;
function harness(mode = 'standard', loadouts = [], opts = {}) {
  const msgs = [[], [], [], []], h = { msgs, ended: null, left: [], t: 0 };
  const players = [0, 1, 2, 3].map((i) => ({ uid: 'u' + i, username: 'P' + i, rank: defaultRank(), colorIdx: i, loadout: loadouts[i] || [], send: (m) => msgs[i].push(m) }));
  h.room = new Room({ id: 1, mode, players: opts.players || players, seed: 7, onEnd: (r, info) => { h.ended = info; }, onLeave: (p) => h.left.push(p.id), ...opts.room });
  h.advance = (sec) => { for (let s = 0; s < sec; s += 0.25) { h.t += Math.min(0.25, sec - s) * 1000; h.room.update(h.t); } };
  h.of = (i, t) => msgs[i].filter((m) => m.t === t);
  h.bike = (i) => h.room.state.bikes[i];
  h.run = () => { h.advance(0.001); h.advance(3.2); assert.equal(h.room.match.phase, 'running'); };
  h.abilityEvs = (id) => h.of(0, 'ev').filter((e) => e.kind === 'ability' && (id === undefined || e.id === id));
  return h;
}

// ---- protocol: loadouts + ability inputs are validated ----
{
  assert.deepEqual(sanitizeLoadout(['turbo', 'turbo', 'nope', 7, 'protector', 'stealth', 'slowDown']), ['turbo', 'protector', 'stealth'], 'known + unique + <= maxSlots');
  assert.deepEqual(sanitizeLoadout('x'), []); assert.deepEqual(sanitizeLoadout(null), []);
  assert.equal(CFG.abilities.maxSlots, 3);
  const q = parseClientMessage(JSON.stringify({ t: 'queue', mode: 'standard', loadout: ['turbo', 'zzz'] }));
  assert.deepEqual(q.msg, { t: 'queue', mode: 'standard', loadout: ['turbo'] });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'queue', mode: 'standard' })).msg, { t: 'queue', mode: 'standard' });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'loadout', abilities: ['protector', 'protector'] })).msg, { t: 'loadout', abilities: ['protector'] });
  assert.equal(parseClientMessage(JSON.stringify({ t: 'in', kind: 'ability' })).ok, false, 'ability input needs an id');
  assert.equal(parseClientMessage(JSON.stringify({ t: 'in', kind: 'ability', ability: 'hax' })).ok, false);
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'in', kind: 'ability', ability: 'turbo', ctick: 5 })).msg, { t: 'in', kind: 'ability', ability: 'turbo', ctick: 5 });
}

// ---- loadouts: start message, countdown-only changes, broadcast ----
{
  const h = harness('standard', [['turbo', 'fastCharge'], ['protector'], [], ['stealth']]); h.advance(0.001);
  const start = h.msgs[1][0];
  assert.deepEqual(start.players.map((p) => p.loadout), [['turbo', 'fastCharge'], ['protector'], [], ['stealth']]);
  assert.equal(h.room.setLoadout(1, ['protector', 'slowDown', 'bogus', 'protector']), true);
  assert.deepEqual(h.of(0, 'loadout').at(-1), { t: 'loadout', id: 1, abilities: ['protector', 'slowDown'] });
  assert.deepEqual(h.bike(1).abilities, ['protector', 'slowDown']);
  h.advance(3.2);
  assert.equal(h.room.setLoadout(1, ['stealth']), false, 'locked once the round runs');
  assert.deepEqual(h.bike(1).abilities, ['protector', 'slowDown']);
}

// ---- activation: turbo is server-authoritative, replicated, cooldown-limited; unequipped / passive ids are ignored ----
{
  const h = harness('standard', [['turbo', 'fastCharge'], ['protector', 'stealth', 'slowDown'], ['allBoost', 'allJump'], []]); h.run();
  const baseSpeed = h.bike(0).baseSpeed;
  h.room.input(0, { kind: 'ability', ability: 'turbo' }); h.advance(0.03);
  const ev = h.abilityEvs(0)[0];
  assert.ok(ev); assert.equal(ev.ability, 'turbo'); assert.equal(typeof ev.x, 'number');
  assert.ok(h.bike(0).active.turbo > 3 && h.bike(0).speed > baseSpeed * 2.4, 'turbo speeds the bike up on the server');
  assert.ok(h.bike(0).cd.turbo > 14);
  assert.equal(h.of(2, 'ev').filter((e) => e.kind === 'ability').length, 1, 'everyone gets the event');
  const n = h.of(0, 'ev').length;
  h.room.input(0, { kind: 'ability', ability: 'turbo' }); h.advance(0.03);
  assert.equal(h.of(0, 'ev').length, n, 'cooldown: second activation refused, no event');
  h.room.input(0, { kind: 'ability', ability: 'protector' }); h.room.input(0, { kind: 'ability', ability: 'fastCharge' }); h.room.input(0, { kind: 'ability', ability: 'nope' }); h.room.input(0, { kind: 'swap' }); h.advance(0.03);
  assert.equal(h.of(0, 'ev').length, n, 'not equipped / passive / unknown / swap: ignored');
  // protector: shield on, trail-proof
  h.room.input(1, { kind: 'ability', ability: 'protector' }); h.advance(0.03);
  assert.ok(h.bike(1).active.protector > 0); const sn = h.of(0, 'snap').at(-1);
  h.advance(0.2); const snap = h.of(0, 'snap').at(-1).bikes[1];
  assert.ok(snap.ab.ac.protector > 0 && snap.ab.cd.protector > 0, 'snapshots carry the ability timers'); assert.equal(h.of(0, 'snap').at(-1).bikes[3].ab, undefined, 'no loadout -> no ab');
  void sn;
  // stealth flag follows the active timer on the server too
  h.room.input(1, { kind: 'swap' }); h.room.input(1, { kind: 'ability', ability: 'stealth' }); h.advance(0.03); assert.equal(h.bike(1).stealth, true);
  // allBoost: boosts every other bike; each gets its own boost event; once per round
  h.room.input(2, { kind: 'ability', ability: 'allBoost' }); h.advance(0.03);
  assert.ok(h.bike(2).used.allBoost); assert.ok([0, 1, 3].every((i) => h.bike(i).boosting), 'others forced to boost');
  assert.deepEqual(h.of(0, 'ev').filter((e) => e.kind === 'boost' && e.tick >= ev.tick).map((e) => e.id).sort(), [0, 1, 3].filter((i) => i !== 0 || true).sort().filter((i) => h.of(0, 'ev').some((e) => e.kind === 'boost' && e.id === i)));
  assert.ok([1, 3].every((i) => h.of(0, 'ev').some((e) => e.kind === 'boost' && e.id === i)), 'a boost event per affected bike');
  const nb = h.of(0, 'ev').length; h.room.input(2, { kind: 'ability', ability: 'allBoost' }); h.advance(0.03); assert.equal(h.of(0, 'ev').length, nb, 'allBoost is once per round');
  h.room.input(2, { kind: 'ability', ability: 'allJump' }); h.advance(0.03);
  assert.ok([0, 1, 3].every((i) => h.bike(i).jumpT >= 0), 'allJump makes the others jump');
}

// ---- lag compensation: an ability pressed 8 ticks ago is applied at that tick ----
{
  const h = harness('standard', [['turbo'], [], [], []]); h.run();
  const T = h.room.tick - 8;
  h.room.input(0, { kind: 'ability', ability: 'turbo', ctick: T }); h.advance(0.02);
  const ev = h.abilityEvs(0)[0];
  assert.equal(ev.tick, T, 'event stamped with the rewound tick');
  const ran = h.room.tick - T; const left = ABILITIES.turbo.duration - ran * DT;
  assert.ok(Math.abs(h.bike(0).active.turbo - left) < 2 * DT, `turbo timer replayed from T (${h.bike(0).active.turbo.toFixed(3)} vs ${left.toFixed(3)})`);
  // the bike travelled further than an un-boosted one by the replayed turbo stretch
  const ref = harness('standard', [[], [], [], []]); ref.run();
  while (ref.room.tick < h.room.tick) ref.advance(0.01);
  const d = (b) => Math.hypot(b.x - b.trail[0].x1, b.z - b.trail[0].z1);
  assert.ok(d(h.bike(0)) > d(ref.bike(0)) + 0.5 * (ran * DT) * ref.bike(0).baseSpeed * 1.4, 'replay includes the turbo stretch');
  // the cooldown history is rewound too: a second press (same tick) is refused
  const n = h.of(0, 'ev').length; h.room.input(0, { kind: 'ability', ability: 'turbo', ctick: T + 2 }); h.advance(0.02); assert.equal(h.of(0, 'ev').length, n);
}

// ---- passives work in the shared sim: Air Turn lets a bike turn in the air; Double Jump gives a second jump (dj flag) ----
{
  const h = harness('standard', [['airTurn', 'doubleJump'], [], [], []]); h.run();
  h.room.input(0, { kind: 'jump' }); h.advance(0.42);
  assert.ok(h.bike(0).jumpT >= 0); h.room.input(0, { kind: 'turn', side: 1 }); h.advance(0.1);
  assert.equal(h.of(0, 'ev').filter((e) => e.id === 0 && e.kind === 'turn').length, 1, 'air turn accepted mid-air');
  h.room.input(0, { kind: 'jump' }); h.advance(0.05);
  const js = h.of(0, 'ev').filter((e) => e.id === 0 && e.kind === 'jump');
  assert.equal(js.length, 2); assert.equal(js[0].dj, undefined); assert.equal(js[1].dj, true, 'second jump flagged as a double jump');
}

// ---- bots: fill, names, AI actions broadcast, never ranked ----
{
  const bots = makeBots([{ colorIdx: 1, rank: defaultRank() }, { colorIdx: 3, rank: defaultRank() }], 4, 99);
  assert.equal(bots.length, 2); assert.deepEqual(bots.map((b) => b.colorIdx), [0, 2]);
  assert.ok(bots.every((b) => b.bot && b.uid === null && b.rank === null && b.username.startsWith('BOT ') && BOT_NAMES.includes(b.username.slice(4))));
  assert.notEqual(bots[0].username, bots[1].username);
  assert.equal(makeBots([1, 2, 3, 4].map((c) => ({ colorIdx: c % 4 })), 4).length, 0, 'full lobby: no bots');
  assert.equal(makeBots([{ colorIdx: 0 }, { colorIdx: 1 }, { colorIdx: 2 }], 4).length, 1);
  const rk = (tier, div) => ({ ...defaultRank(), tier, div });
  assert.equal(botLevel([{ rank: rk('He', 1) }, { rank: rk('He', 3) }]), 1, 'Helium: medium'); assert.equal(botLevel([{ rank: rk('Ne', 1) }, { rank: rk('Xe', 2) }]), 2, 'Neon+: hard');
  assert.deepEqual(makeBots([{ colorIdx: 0, rank: rk('Xe', 3) }, { colorIdx: 1, rank: rk('Xe', 3) }], 4)[0].loadout, CFG.ai.loadouts[2], 'hard bots carry the singleplayer hard loadout');

  const msgs = [[], []], humans = [0, 1].map((i) => ({ uid: 'u' + i, username: 'H' + i, rank: defaultRank(), colorIdx: i, send: (m) => msgs[i].push(m) }));
  const players = [...humans, ...makeBots(humans, 4, 5)];
  let ended = null; const left = [];
  const room = new Room({ id: 9, mode: 'standard', players, seed: 3, onEnd: (r, i) => { ended = i; }, onLeave: (p) => left.push(p.id) });
  let t = 0; const adv = (sec) => { for (let s = 0; s < sec; s += 0.25) { t += 250; room.update(t); } };
  const start = msgs[0][0];
  assert.equal(start.players.length, 4); assert.deepEqual(start.players.map((p) => p.bot), [false, false, true, true]); assert.equal(start.players[2].uid, null);
  adv(3.3); adv(5);
  const evs = msgs[0].filter((m) => m.t === 'ev');
  assert.ok(evs.filter((e) => e.id >= 2 && e.kind === 'turn').length > 0, 'bots steer (events for bot bikes)');
  assert.equal(room.statsView().bots, 2);
  // a human leaving: the other human plays on against the bots (no forfeit)
  room.leave(1); assert.deepEqual(left, [1]); assert.equal(ended, null);
  adv(2); assert.equal(ended, null);
  room.leave(0); assert.ok(ended && ended.reason === 'forfeit', 'no human left: the room closes');
  const by = Object.fromEntries(ended.results.map((r) => [r.id, r]));
  assert.ok(by[2].bot && by[3].bot && !by[0].bot); assert.ok(by[0].left && by[1].left && !by[2].left);
}
{ // human vs bots result: a sole winner among humans + bots is a win for the human; bots never "left"
  const msgs = [[], []], humans = [0, 1].map((i) => ({ uid: 'u' + i, username: 'H' + i, rank: defaultRank(), colorIdx: i, send: (m) => msgs[i].push(m) }));
  let ended = null;
  const room = new Room({ id: 9, mode: 'standard', players: [...humans, ...makeBots(humans, 4, 5)], seed: 3, timeScale: 1, onEnd: (r, i) => { ended = i; } });
  let t = 0; const adv = (sec) => { for (let s = 0; s < sec; s += 0.25) { t += 250; room.update(t); } };
  adv(3.3);
  const drop = (i) => { const b = room.state.bikes[i], seg = b.trail.at(-1); if (!seg) return; b.x = seg.x1 = seg.x2 = seg.z1 = seg.z2 = 500; b.z = 500; };
  for (let r = 0; r < 12 && !ended; r++) { while (!ended && room.match.phase !== 'running') adv(0.25); drop(1); drop(2); drop(3); adv(1.5); } // H0 outlives everyone every round
  assert.ok(ended, 'match ended'); const w = ended.results.find((r) => r.id === 0);
  assert.equal(w.place, 1); assert.equal(w.won, true, 'a human who beats the bots still wins');
  assert.ok(ended.results.filter((r) => r.bot).every((r) => !r.won && r.place > 1 && !r.left));
}
{ // without bots the old forfeit rule stands
  const h = harness(); h.run(); h.room.leave(0); h.room.leave(1); h.room.leave(2); assert.equal(h.ended.reason, 'forfeit'); assert.equal(h.ended.results.find((r) => r.id === 3).place, 1);
}

// ---- client sim (js/netsim.js) follows the server with abilities: prediction + latency, every ability, (almost) no corrections ----
// Bike 0 is the "local" client: AI-driven turns + scripted ability presses are predicted and sent L ticks late with their ctick; the other
// bikes are driven on the server directly (AI turns + scripted abilities). Messages reach the client L ticks after they were produced.
{
  const L = 6;                                      // one-way latency in ticks (50 ms)
  const loads = process.env.NOAB ? [[], [], [], []] : [['turbo', 'rocketJump', 'doubleJump'], ['protector', 'stealth', 'slowDown'], ['allBoost', 'allJump', 'fastCharge'], ['airTurn']];
  const msgs = [[], [], [], []];
  const players = [0, 1, 2, 3].map((i) => ({ uid: 'u' + i, username: 'P' + i, rank: defaultRank(), colorIdx: i, loadout: loads[i], send: (m) => msgs[i].push(m) }));
  const room = new Room({ id: 1, mode: 'deathmatch', players, seed: 11 });
  const st = createState(); st.playerId = 0; st.map = room.state.map; // the real client takes start.mapId
  for (let i = 0; i < 4; i++) { const b = createBike(i, '#fff', 0, 0, 0, -1); setLoadout(b, loads[i]); st.bikes.push(b); }
  const sim = createSim(st, 0), pts = spawnPoints(4, st.map);
  st.bikes.forEach((b, i) => resetBike(b, pts[i], CFG.baseSpeed));
  const ais = [0, 1, 2, 3].map((i) => createAI(1, i * 2)), rng = makeRng(5);
  const down = [], up = [];
  const press = [ // [ticks since GO, input] for the local bike
    [50, { kind: 'ability', ability: 'turbo' }], [300, { kind: 'jump' }], [330, { kind: 'jump' }], [900, { kind: 'ability', ability: 'rocketJump' }],
    [1300, { kind: 'ability', ability: 'turbo' }], [1700, { kind: 'ability', ability: 'rocketJump' }], // the cooldowns of 15 s / 8 s are over by then
  ];
  const others = [ // [ticks since GO, bike, input]: remote bikes act directly on the server
    [160, 1, { kind: 'ability', ability: 'protector' }], [200, 1, { kind: 'ability', ability: 'stealth' }], [260, 1, { kind: 'ability', ability: 'slowDown' }],
    [500, 2, { kind: 'ability', ability: 'allBoost' }], [700, 2, { kind: 'ability', ability: 'allJump' }], [190, 3, { kind: 'jump' }], [800, 3, { kind: 'jump' }],
  ];
  const stats = { snaps: 0, corrected: 0, revived: 0, abilityEvs: 0, maxErr: 0, crashes: 0 };
  let running = false, go = 0, now = 0;
  room.update(0);
  const TICKS = 2400;
  for (let i = 1; i <= TICKS; i++) {
    now = (i + 0.5) * 1000 / HZ; room.update(now);
    for (const m of msgs[0].splice(0)) down.push({ at: room.tick + L, m });
    for (const u of up.filter((x) => x.at <= room.tick)) room.input(u.id, u.msg); up.splice(0, up.length, ...up.filter((x) => x.at > room.tick));
    if (room.match.phase === 'running') {
      const k = room.tick - go;
      for (const [ct, id, msg] of others) if (k === ct && go) room.input(id, msg);
      for (let b = 1; b < 4; b++) if ((room.tick + b) % 5 === 0) { const bk = room.state.bikes[b]; if (bk.alive) { const side = aiThink(room.state, bk, ais[b], rng); if (side && canTurn(bk)) room.input(b, { kind: 'turn', side }); } }
    }
    for (const { m } of down.filter((x) => x.at <= room.tick).map((x) => x)) {
      if (m.t === 'round') {
        if (m.phase === 'countdown') { st.bikes.forEach((b, k) => resetBike(b, pts[k], CFG.baseSpeed)); resetSim(sim, m.tick); running = false; }
        else if (m.phase === 'running') { sim.tick = m.tick; sim.hist.clear(); running = true; go = m.tick; }
        else running = false;
      } else if (!running) continue;
      else if (m.t === 'ev') {
        while (sim.tick < room.tick) stepSim(sim);
        const r = applyEvent(sim, m, sim.tick); if (m.kind === 'ability') { stats.abilityEvs++; assert.ok(r.applied || !st.bikes[m.id].alive, 'ability event applied on the client'); }
      } else if (m.t === 'crash') { stats.crashes++; applyCrash(sim, m); }
      else if (m.t === 'snap') {
        while (sim.tick < room.tick) stepSim(sim);
        const pre = process.env.DBG ? JSON.stringify(st.bikes.map((b) => [b.x.toFixed(3), b.z.toFixed(3), b.speed, b.boosting, +b.boostMeter.toFixed(3)])) : '';
        const r = applySnap(sim, m, sim.tick); stats.snaps++; stats.corrected += r.corrected.length; stats.revived += r.revived.length;
        if (process.env.DBG && (r.corrected.length || r.revived.length)) { console.log('snap', m.tick - go, 'corr', r.corrected, 'rev', r.revived, JSON.stringify(r.err), 'simTick', sim.tick - go); console.log(' client', pre); console.log(' server snap', JSON.stringify(m.bikes.map((b) => [b.x, b.z, b.speed, b.boosting, b.boostMeter]))); }
        for (const e of Object.values(r.err)) stats.maxErr = Math.max(stats.maxErr, Math.abs(e));
      }
    }
    down.splice(0, down.length, ...down.filter((x) => x.at > room.tick));
    if (running) {
      while (sim.tick < room.tick) {
        const k = sim.tick - go, me = st.bikes[0];
        for (const [ct, msg] of press) if (ct === k && me.alive && predictInput(sim, 0, msg)) up.push({ at: room.tick + L, id: 0, msg: { ...msg, ctick: sim.tick } });
        if (me.alive && (sim.tick % 5 === 0)) { const side = aiThink(st, me, ais[0], rng); if (side && predictInput(sim, 0, { kind: 'turn', side })) up.push({ at: room.tick + L, id: 0, msg: { kind: 'turn', side, ctick: sim.tick } }); }
        stepSim(sim);
      }
      prunePending(sim);
    }
  }
  console.log('  client sim: ticks', TICKS, 'snaps', stats.snaps, 'corrected', stats.corrected, 'revived', stats.revived, 'crashes', stats.crashes, 'maxErr', stats.maxErr.toFixed(3), 'ability events', stats.abilityEvs);
  assert.ok(stats.snaps > 100, 'ran many snapshots');
  if (!process.env.NOAB) assert.ok(stats.abilityEvs >= 6, 'ability events reached the client: ' + stats.abilityEvs);
  assert.ok(stats.corrected + stats.revived <= 0.06 * stats.snaps * 4, `the client sim tracks the server (${stats.corrected} corrections, ${stats.revived} revivals in ${stats.snaps} snapshots)`);
  const sb = room.state.bikes;
  if (running) for (const k of [0, 1, 2, 3]) if (sb[k].alive && st.bikes[k].alive) assert.ok(Math.hypot(sb[k].x - st.bikes[k].x, sb[k].z - st.bikes[k].z) < 2.5, `bike ${k} position agrees`);
}
console.log('abilities + bots tests ok');
