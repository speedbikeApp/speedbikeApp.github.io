// Multiplayer client: clock sync, tick clock, event/snap reconciliation against a simulated server, rank badges, WebSocket client.
import assert from 'node:assert/strict';

const { CFG } = await import('../js/config.js');
const { createBike, createState, resetBike, spawnPoints } = await import('../js/state.js');
const { turnBike, canTurn, startJump, startBoost } = await import('../js/physics.js');
const { ClockSync, serverUrl, createNet, buildHello } = await import('../js/net.js');
const NS = await import('../js/netsim.js');
const { badgeInfo, badgeHtml, fmtCountdown, rankChange } = await import('../js/rankview.js');
const { applyResult } = await import('../js/ranks.js');

// ---------------- ClockSync ----------------
{
  const c = new ClockSync();
  c.addPong(1000, 1100, 5050);              // rtt 100, server = 5050 at the middle of the trip (local 1050) -> offset 4000
  assert.equal(c.offset, 4000); assert.equal(c.rtt, 100);
  c.addPong(2000, 2400, 6300);              // noisy sample (rtt 400) must not replace the better one
  assert.equal(c.offset, 4000);
  c.addPong(3000, 3040, 7020);              // rtt 40 -> offset 7020+20-3040 = 4000
  assert.equal(c.rtt, 40);
  assert.equal(c.serverNow(10000), 14000); assert.equal(c.last, 40, 'latest sample kept for the HUD readout');
  const s = new ClockSync(); s.seed(500, 9000); assert.equal(s.offset, 8500); s.seed(600, 1); assert.equal(s.offset, 8500, 'seed only once');
}
// ---------------- server url ----------------
{
  assert.equal(serverUrl('', { url: 'ws://localhost:8787' }), 'ws://localhost:8787');
  assert.equal(serverUrl('?server=wss://game.example.com/x', { url: 'ws://a' }), 'wss://game.example.com/x');
  assert.equal(serverUrl('?server=javascript:alert(1)', { url: 'ws://a' }), 'ws://a', 'only ws/wss accepted');
}
// ---------------- TickClock ----------------
{
  const tc = new NS.TickClock(120);
  assert.equal(tc.estimate(100), null);
  // server tick 1200 at local 10 s (sent), arrives 40 ms later; another arrives 5 ms later: the 5 ms one wins
  tc.sample(1200, 10040); tc.sample(1320, 11005); tc.sample(1440, 12030);
  const e = tc.estimate(12000, 0);          // true tick at local 12.000 s (+ lowest latency 5 ms is baked in)
  assert.ok(Math.abs(e - (1320 + (12000 - 11005) * 0.12)) < 1e-6, 'uses the least delayed sample');
  assert.ok(tc.estimate(12000, 25) > e, 'one-way latency added');
}
// ---------------- rank badge helpers ----------------
{
  const b = badgeInfo({ tier: 'Ne', div: 2, wins: 1 });
  assert.equal(b.sym, 'Ne'); assert.equal(b.roman, 'II'); assert.deepEqual(b.pips, [true, false]); assert.equal(b.color, '#ff4d2e'); assert.equal(b.label, 'NEON II');
  assert.equal(badgeInfo(null).label, 'HELIUM I'); assert.equal(badgeInfo({ tier: 'zz', div: 9 }).label, 'HELIUM I', 'garbage -> default');
  const h = badgeHtml({ tier: 'Xe', div: 1, wins: 1 });
  assert.ok(h.includes('--rc:#8f7bff') && h.includes('<b>Xe</b>') && h.includes('<i>I</i>') && h.includes('<u class="on"></u><u></u>'));
  assert.ok(!badgeHtml({ tier: 'He', div: 3, wins: 0 }).includes('class="on"'));
  assert.equal(fmtCountdown(61000), '01:01'); assert.equal(fmtCountdown(59001), '01:00'); assert.equal(fmtCountdown(-5), '00:00');
  const before = { tier: 'He', div: 3, wins: 1 }, r = applyResult(before, true);
  const ch = rankChange(before, r.rank, r.change);
  assert.equal(ch.banner, 'PROMOTED'); assert.equal(ch.pipDelta, 1);
  const r2 = applyResult({ tier: 'He', div: 3, wins: 0 }, true); assert.deepEqual([rankChange({ tier: 'He', div: 3, wins: 0 }, r2.rank, r2.change).banner, rankChange({ tier: 'He', div: 3, wins: 0 }, r2.rank, r2.change).pipDelta], ['', 1]);
  const r3 = applyResult({ tier: 'Ne', div: 3, wins: 0 }, false); const c3 = rankChange({ tier: 'Ne', div: 3, wins: 0 }, r3.rank, r3.change);
  assert.equal(c3.banner, 'DEMOTED'); assert.equal(c3.pipDelta, -1);
  assert.equal(rankChange({ tier: 'He', div: 3, wins: 0 }, { tier: 'He', div: 3, wins: 0 }, 'none').pipDelta, 0);
}

// ---------------- netsim: simulated server + delayed client ----------------
const DT = 1 / CFG.tickHz;
const seg = (s) => [s.x1, s.z1, s.x2, s.z2, s.y0 || 0].map((v) => +v.toFixed(5)).join(',');
function mkSim(playerId) {
  const st = createState(); st.playerId = playerId;
  const pts = spawnPoints(2);
  for (let i = 0; i < 2; i++) { const b = createBike(i, 0xffffff, 0, 0, 0, -1); resetBike(b, pts[i], CFG.baseSpeed); st.bikes.push(b); }
  return NS.createSim(st, 0);
}
function runScenario(L, script, ticks, jitter = 0) {
  const S = mkSim(0), C = mkSim(0);
  const toServer = [], toClient = []; // {at, msg}
  const evs = [];
  for (let t = 0; t < ticks; t++) {
    // inputs the clients press this tick (script: tick -> [{who, kind, side}])
    for (const p of script[t] || []) {
      if (p.who === 0) { if (NS.predictInput(C, 0, { kind: p.kind, side: p.side })) toServer.push({ at: t + L, id: 0, kind: p.kind, side: p.side }); }
      else toServer.push({ at: t + L, id: 1, kind: p.kind, side: p.side }); // other player's input reaches the server L later
    }
    // server receives inputs, applies them at ITS tick, broadcasts events
    for (const m of toServer.filter((x) => x.at === t)) {
      const b = S.state.bikes[m.id];
      if (NS.applyInput(b, m)) {
        const sb = S.state.bikes[m.id];
        toClient.push({ at: t + L + (jitter ? (t % 3) : 0), msg: { t: 'ev', tick: t, id: m.id, kind: m.kind, side: m.side, x: sb.x, z: sb.z, y: sb.y, dx: sb.dx, dz: sb.dz } });
      }
    }
    NS.stepSim(S);
    // client receives events (its tick is the same estimate of the server tick)
    for (const m of toClient.filter((x) => x.at === t)) { const r = NS.applyEvent(C, m.msg, C.tick); evs.push(r); }
    NS.prunePending(C);
    NS.stepSim(C);
  }
  return { S, C, evs };
}
const sameWorld = (S, C, tag) => {
  for (let i = 0; i < 2; i++) {
    const a = S.state.bikes[i], b = C.state.bikes[i];
    assert.equal(b.alive, a.alive, `${tag}: alive ${i}`);
    for (const k of ['x', 'z', 'y', 'dx', 'dz']) assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${tag}: bike ${i} ${k} ${a[k]} vs ${b[k]}`);
    assert.deepEqual(b.trail.map(seg), a.trail.map(seg), `${tag}: trail ${i}`);
  }
};
{
  // own turn (L = 6 ticks one way), remote turn, own double-tap turn while the first is in flight, remote jump, own boost
  const script = {
    30: [{ who: 0, kind: 'turn', side: 1 }],
    55: [{ who: 1, kind: 'turn', side: -1 }],
    100: [{ who: 0, kind: 'turn', side: -1 }],
    104: [{ who: 0, kind: 'turn', side: 1 }],
    140: [{ who: 1, kind: 'jump' }],
    170: [{ who: 0, kind: 'boost' }],
    210: [{ who: 1, kind: 'turn', side: 1 }],
  };
  for (const L of [0, 3, 6, 12]) {
    const { S, C } = runScenario(L, script, 330);
    sameWorld(S, C, `L=${L}`);
    assert.equal(C.pending.length, 0, 'all predictions confirmed');
  }
  const j = runScenario(5, script, 330, 1); // jittery delivery (events can arrive out of phase)
  sameWorld(j.S, j.C, 'jitter');
}
{
  // a prediction the server rejects (turn inside minTurnGap) is eventually pruned and a snap puts the bike back
  const S = mkSim(0), C = mkSim(0);
  for (let t = 0; t < 40; t++) { NS.stepSim(S); NS.stepSim(C); }
  assert.ok(NS.predictInput(C, 0, { kind: 'turn', side: 1 }));   // client believes it turned; server never did
  for (let t = 0; t < 20; t++) { NS.stepSim(S); NS.stepSim(C); }
  const snap = { tick: S.tick, bikes: S.state.bikes.map((b) => ({ id: b.id, x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz, speed: b.speed, alive: b.alive, lives: 3 })) };
  assert.equal(NS.applySnap(C, snap, S.tick).corrected.length, 0, 'pending input in flight: own bike not touched');
  for (let t = 0; t < 200; t++) { NS.stepSim(S); NS.stepSim(C); NS.prunePending(C); }
  assert.equal(C.pending.length, 0);
  const snap2 = { tick: S.tick, bikes: S.state.bikes.map((b) => ({ id: b.id, x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz, speed: b.speed, alive: b.alive })) };
  const r = NS.applySnap(C, snap2, S.tick);
  assert.deepEqual(r.corrected, [0]);
  const a = S.state.bikes[0], b = C.state.bikes[0];
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 1e-6 && a.dx === b.dx && a.dz === b.dz, 'snap restored heading + position');
}
{
  // snap: tolerance, projection forward, revive of a falsely dead bike, crash message
  const S = mkSim(0), C = mkSim(0);
  for (let t = 0; t < 50; t++) { NS.stepSim(S); NS.stepSim(C); }
  const mkSnap = (sim, tick) => ({ tick, bikes: sim.state.bikes.map((b) => ({ id: b.id, x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz, speed: b.speed, alive: b.alive, lives: 2, boostMeter: b.boostMeter, jumpMeter: b.jumpMeter })) });
  const old = mkSnap(S, S.tick);
  for (let t = 0; t < 7; t++) { NS.stepSim(S); NS.stepSim(C); }   // snap is 7 ticks old on arrival
  { const r0 = NS.applySnap(C, old, C.tick); assert.deepEqual([r0.corrected, r0.revived], [[], []], 'in sync after projecting the old snap forward'); assert.ok(Object.values(r0.err).every((e) => Math.abs(e) < 1e-6)); }
  assert.equal(C.state.bikes[1].lives, 2);
  C.state.bikes[1].x += 1;                                          // drift
  assert.deepEqual(NS.applySnap(C, mkSnap(S, S.tick), C.tick).corrected, [1]);
  assert.ok(Math.abs(C.state.bikes[1].x - S.state.bikes[1].x) < 1e-6);
  assert.equal(NS.applyCrash(C, { victim: 1 }), true); assert.equal(C.state.bikes[1].alive, false); assert.equal(C.state.bikes[1].trail.length, 0);
  assert.equal(NS.applyCrash(C, { victim: 1 }), false, 'second crash message ignored');
  const rv = NS.applySnap(C, mkSnap(S, S.tick), C.tick, { spawnProt: 1 });
  assert.deepEqual(rv.revived, [1]); assert.equal(C.state.bikes[1].alive, true); assert.equal(C.state.bikes[1].spawnProt, 1);
  assert.equal(C.state.bikes[1].trail.length, 1);
}
{
  // jump + boost events keep ability timers in step (rewind restores the old timers)
  const S = mkSim(0), C = mkSim(0);
  const L = 8;
  for (let t = 0; t < 300; t++) {
    if (t === 20) { startJump(S.state.bikes[1]); const b = S.state.bikes[1]; var jev = { tick: t, id: 1, kind: 'jump', x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz }; }
    if (t === 25) { startBoost(S.state.bikes[1]); const b = S.state.bikes[1]; var bev = { tick: t, id: 1, kind: 'boost', x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz }; }
    NS.stepSim(S);
    if (t === 20 + L) NS.applyEvent(C, jev, C.tick);
    if (t === 25 + L) NS.applyEvent(C, bev, C.tick);
    NS.stepSim(C);
  }
  sameWorld(S, C, 'jump/boost');
}

{
  // Death Match respawn event revives a dead bike with a fresh trail and spawn protection, then catches up to now
  const C = mkSim(0);
  for (let t = 0; t < 30; t++) NS.stepSim(C);
  assert.equal(NS.applyCrash(C, { victim: 1 }), true);
  const r = NS.applyEvent(C, { tick: 28, id: 1, kind: 'respawn', x: 10, z: 10, y: 0, dx: 1, dz: 0 }, C.tick);
  const b = C.state.bikes[1];
  assert.ok(r.respawned && b.alive && b.trail.length === 1 && b.spawnProt > 0);
  assert.ok(Math.abs(b.x - (10 + 2 * CFG.baseSpeed * DT)) < 1e-6, 'advanced the 2 ticks since the event');
}

{
  // visual smoothing: the sim is exact, the displayed position glides (render-only offset vox/voz)
  const b = { x: 10, z: 5, dx: 1, dz: 0, alive: true };
  const was = NS.visCapture(b);
  b.x = 9; b.z = 5;                                              // correction moved the bike 1 unit back, same heading
  assert.equal(NS.visBlend(b, was, { maxDist: 3 }), 1); assert.deepEqual([b.vox, b.voz], [1, 0], 'shows the old position');
  assert.deepEqual(NS.visCapture(b), was, 'displayed = sim + offset');
  const arr = [b]; NS.visDecay(arr, 0.12 / 3, 120);              // one time constant: 1/e
  assert.ok(Math.abs(b.vox - Math.exp(-1)) < 1e-9);
  for (let i = 0; i < 12; i++) NS.visDecay(arr, 0.01, 120);      // 120 ms more
  assert.ok(Math.abs(b.vox) < 0.02, 'about 95% gone after blendMs'); NS.visDecay(arr, 1, 120); assert.deepEqual([b.vox, b.voz], [0, 0]);
  const far = { x: 0, z: 0, dx: 1, dz: 0, alive: true }, wf = NS.visCapture(far); far.x = -4;
  NS.visBlend(far, wf, { maxDist: 3 }); assert.deepEqual([far.vox, far.voz], [0, 0], 'large error: snap');
  const turned = { x: 0, z: 0, dx: 1, dz: 0, alive: true }, wt = NS.visCapture(turned); turned.x = -1; turned.dx = 0; turned.dz = 1;
  NS.visBlend(turned, wt, { maxDist: 3 }); assert.equal(turned.vox, 0, 'own bike: heading changed -> snap');
  NS.visBlend(turned, wt, { maxDist: 3, allowTurn: true }); assert.equal(turned.vox, 1, 'remote bike: late turn is blended');
  const tiny = { x: 0, z: 0, dx: 1, dz: 0, alive: true }, wy = NS.visCapture(tiny); tiny.x = 0.001; NS.visBlend(tiny, wy); assert.equal(tiny.vox, 0, 'rounding noise ignored');
}
{
  // the server applied our jump LATER than we predicted (beyond its rewind cap): the prediction's trail steps / speed are undone
  const S = mkSim(0), C = mkSim(0);
  for (let t = 0; t < 30; t++) { NS.stepSim(S); NS.stepSim(C); }
  assert.ok(NS.predictInput(C, 0, { kind: 'jump' })); const pc = C.pending[0].ctick;
  for (let t = 0; t < 12; t++) { NS.stepSim(C); NS.stepSim(S); }   // 12 ticks later the server applies it (stamped with its own tick)
  startJump(S.state.bikes[0]); const sb = S.state.bikes[0];
  const ev = { tick: S.tick, id: 0, kind: 'jump', x: sb.x, z: sb.z, y: sb.y, dx: sb.dx, dz: sb.dz };
  assert.equal(ev.tick, pc + 12);
  NS.applyEvent(C, ev, C.tick);
  for (let t = 0; t < 120; t++) { NS.stepSim(S); NS.stepSim(C); }
  sameWorld(S, C, 'late jump');
}
{
  // own bike crashed locally while an input is in flight: a snap showing it alive must not revive it (the server may kill it on replay)
  const S = mkSim(0), C = mkSim(0);
  for (let t = 0; t < 30; t++) { NS.stepSim(S); NS.stepSim(C); }
  assert.ok(NS.predictInput(C, 0, { kind: 'turn', side: 1 })); C.state.bikes[0].alive = false;
  const snap = { tick: S.tick, bikes: S.state.bikes.map((b) => ({ id: b.id, x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz, speed: b.speed, alive: true })) };
  assert.deepEqual(NS.applySnap(C, snap, S.tick).revived, [], 'pending input: no revive');
  C.pending.length = 0; assert.deepEqual(NS.applySnap(C, snap, S.tick).revived, [0], 'revived once nothing is in flight');
}
{
  // a turn pressed on the very tick an earlier event is replayed up to is kept (not lost by the rewind)
  const S = mkSim(0), C = mkSim(0);
  for (let t = 0; t < 30; t++) { NS.stepSim(S); NS.stepSim(C); }
  NS.predictInput(C, 0, { kind: 'turn', side: 1 });
  const ev1 = { tick: C.tick, id: 0, kind: 'turn', side: 1 }; { const b = S.state.bikes[0]; NS.applyInput(b, { kind: 'turn', side: 1 }); Object.assign(ev1, { x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz }); }
  for (let t = 0; t < 40; t++) { NS.stepSim(S); NS.stepSim(C); }
  assert.ok(NS.predictInput(C, 0, { kind: 'turn', side: -1 }), 'second turn pressed');
  const ev2 = { tick: C.tick, id: 0, kind: 'turn', side: -1 }; { const b = S.state.bikes[0]; NS.applyInput(b, { kind: 'turn', side: -1 }); Object.assign(ev2, { x: b.x, z: b.z, y: b.y, dx: b.dx, dz: b.dz }); }
  NS.applyEvent(C, ev1, C.tick);                                // first event arrives while the second turn was pressed on this very tick
  assert.deepEqual([C.state.bikes[0].dx, C.state.bikes[0].dz], [S.state.bikes[0].dx, S.state.bikes[0].dz], 'second turn survived the replay');
  NS.applyEvent(C, ev2, C.tick);
  for (let t = 0; t < 60; t++) { NS.stepSim(S); NS.stepSim(C); }
  sameWorld(S, C, 'same-tick follow-up');
}
{
  // against the REAL server room through a simulated 150 ms RTT link (+-15 ms): the own turn lands where it was pressed, worlds identical
  const { runLag, diffWorlds } = await import('../server/test/lagsim.mjs');
  const presses = [];
  for (let w = 0; w < 4; w++) for (const [at, side] of [[1000, 1], [2500, 1], [3400, 1]]) presses.push({ at: at + w * 7, who: w, kind: 'turn', side });
  presses.push({ at: 1700, who: 2, kind: 'jump' }, { at: 400, who: 3, kind: 'boost' });
  const r = runLag({ rttMs: 150, jitterMs: 15, seconds: 4.2, presses, seed: 3 });
  const own = r.clients.flatMap((c) => c.ownEv);
  assert.ok(own.length >= 12);
  assert.ok(Math.max(...own.map((e) => e.corr)) < 0.01 && Math.max(...own.map((e) => e.landing ?? 0)) < 0.01, 'own turns land exactly');
  assert.deepEqual(diffWorlds(r), [], '150 ms RTT: identical worlds incl. trails');
  const old = runLag({ rttMs: 150, jitterMs: 15, seconds: 4.2, presses, seed: 3, maxRewindMs: 0 });
  assert.ok(Math.max(...old.clients.flatMap((c) => c.ownEv).map((e) => e.corr)) > 1, 'sanity: the old server behaviour pulled the own bike back > 1 unit');
}

// ---------------- WebSocket client ----------------
class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose({}); }
  open() { this.readyState = 1; this.onopen && this.onopen({}); }
  recv(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
}
{
  const timers = []; let clock = 0;
  const fake = { setTimeout: (fn, ms) => { const t = { fn, at: clock + ms, on: true }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; }, now: () => clock };
  const advance = (ms) => { const end = clock + ms; for (;;) { const nx = timers.filter((t) => t.on && t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!nx) break; clock = nx.at; nx.on = false; nx.fn(); } clock = end; };
  const flush = () => new Promise((r) => setImmediate(r));
  const cfg = { ...CFG.net, reconnectMs: [100, 200, 400], pingMs: 1000, helloTimeoutMs: 500 };
  let hello = { t: 'hello', dev: true, uid: 'u1', username: 'Neo' };
  const net = createNet({ url: 'ws://x:1', getHello: async () => hello, WebSocket: FakeWS, cfg, ...fake });
  const states = []; net.on('status', (s) => states.push(s.state));
  const got = []; net.on('announce', (m) => got.push(m.text));
  net.connect(); await flush();
  const ws1 = FakeWS.all[0]; assert.equal(ws1.url, 'ws://x:1');
  ws1.open(); assert.deepEqual(ws1.sent[0], hello);
  ws1.recv({ t: 'welcome', uid: 'u1', username: 'Neo', rank: {}, serverNow: 5000, featured: 'hyper', nextRotation: 9, online: 3 });
  assert.equal(net.state, 'online'); assert.equal(net.welcome.online, 3);
  assert.deepEqual(ws1.sent[1], { t: 'ping', c: 1 });
  advance(40); ws1.recv({ t: 'pong', c: 1, serverNow: 5000 + 20 + 40 });   // sent at 0, received at 40 -> rtt 40
  assert.equal(net.clock.rtt, 40);
  assert.equal(net.serverNow(), 40 + net.clock.offset);
  ws1.recv({ t: 'announce', text: 'X is one win from NEON!', kind: 'tierPoint' }); assert.deepEqual(got, ['X is one win from NEON!']);
  ws1.close();                                                              // server went away -> backoff reconnect
  assert.equal(net.state, 'offline');
  advance(99); assert.equal(FakeWS.all.length, 1); advance(2); await flush(); assert.equal(FakeWS.all.length, 2, 'first retry after 100 ms');
  FakeWS.all[1].close(); advance(150); assert.equal(FakeWS.all.length, 2, 'backoff doubled'); advance(60); await flush(); assert.equal(FakeWS.all.length, 3);
  FakeWS.all[2].open(); advance(600); assert.equal(FakeWS.all[2].readyState, 3, 'no welcome within helloTimeout -> closed');
  net.lock(true); advance(5000); await flush(); assert.equal(FakeWS.all.length, 3, 'locked (in a match): no reconnect');
  net.lock(false); advance(5000); await flush(); assert.equal(FakeWS.all.length, 4, 'unlocked: reconnect resumes');
  net.disconnect(); assert.equal(net.state, 'idle'); advance(99999); await flush(); assert.equal(FakeWS.all.length, 4, 'disconnect stops retries');
  // signed out -> denied, no socket
  hello = null; net.connect(); await flush(); assert.equal(net.state, 'denied'); assert.equal(FakeWS.all.length, 4);
  net.disconnect();
}
{
  const user = { uid: 'abc', username: 'Neo' };
  assert.deepEqual(await buildHello({ currentUser: () => user, status: () => ({ mode: 'mock' }), getIdToken: async () => null }), { t: 'hello', dev: true, uid: 'abc', username: 'Neo' });
  assert.deepEqual(await buildHello({ currentUser: () => user, status: () => ({ mode: 'firebase' }), getIdToken: async () => 'TOK' }), { t: 'hello', token: 'TOK' });
  assert.equal(await buildHello({ currentUser: () => null, status: () => ({ mode: 'mock' }), getIdToken: async () => null }), null);
  assert.equal(await buildHello({ currentUser: () => user, status: () => ({ mode: 'firebase' }), getIdToken: async () => null }), null);
}
console.log('net tests passed');
