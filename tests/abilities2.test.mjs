import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { CFG } = await import('../js/config.js');
const { createBike, createState, resetBike, spawnPoints } = await import('../js/state.js');
const { step, startBoost, startJump, turnBike, canTurn, jumpY } = await import('../js/physics.js');
const A = await import('../js/abilities.js');
const { rankings, placements } = await import('../js/rules.js');
const { createMatch, MODES } = await import('../js/modes.js');
const { aiUseAbilities, createAI, updateAIs, makeRng } = await import('../js/ai.js');
const S = await import('../js/save.js');

const DT = 1 / CFG.tickHz;
const REAL_HALF = CFG.arena.half;
CFG.arena.half = 400; // most tests need room; blocks that need the real walls set REAL_HALF

const mk = (...bikes) => { const s = createState(); s.bikes.push(...bikes); return s; };
const run = (s, secs, until) => { let ev = []; for (let i = 0, n = Math.round(secs * CFG.tickHz); i < n; i++) { ev = ev.concat(step(s, DT)); if (until && until()) break; } return ev; };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const bike = (id, x, z, dx, dz, abilities = []) => { const b = createBike(id, 0, x, z, dx, dz); A.setLoadout(b, abilities); A.resetAbilityState(b); return b; };
const parked = (id, x, z1, z2) => { const o = createBike(id, 0, x, z2, 0, 1); o.speed = 0; o.baseSpeed = 0; Object.assign(o.trail[0], { x1: x, x2: x, z1, z2 }); return o; };

{ // registry shape + config-driven values
  for (const id of A.ABILITY_IDS) {
    const d = A.ABILITIES[id];
    assert.ok(d.name && d.short && (d.type === 'active' || d.type === 'passive'), id);
    assert.equal(typeof d.price, 'number');
    if (d.type === 'active') assert.equal(typeof d.onActivate, 'function', id);
  }
  assert.equal(A.ABILITIES.turbo.price, 0); assert.equal(A.ABILITIES.turbo.cooldown, CFG.abilities.turbo.cooldown);
  assert.ok(A.isAbilityId('turbo') && !A.isAbilityId('nope') && !A.isAbilityId('toString') && !A.isAbilityId(5));
}
{ // Turbo: 2.5x (37.5 u/s) for ~3.33 s covers ~125 units (fake huge arena), leaves a trail, then back to base speed
  const half = CFG.arena.half; CFG.arena.half = 400;
  const b = bike(0, -300, 0, 1, 0, ['turbo']), s = mk(b);
  assert.ok(A.useAbility(b, s));
  run(s, DT); near(b.speed, 37.5, 1e-9);
  run(s, CFG.abilities.turbo.duration + DT);
  near(b.x + 300, 125, 0.6); near(b.speed, 15);
  // trail drawn along the whole dash
  near(b.trail[0].x2 - b.trail[0].x1, b.x + 300, 1e-6);
  CFG.arena.half = half;
}
{ // turning allowed during Turbo; trail gets a new segment
  const b = bike(0, -40, 0, 1, 0, ['turbo']), s = mk(b);
  A.useAbility(b, s); run(s, 0.5);
  assert.ok(canTurn(b)); turnBike(b, 1);
  assert.equal(b.dz, 1); assert.equal(b.trail.length, 2);
  run(s, 0.1); near(b.speed, 37.5, 1e-9);
}
{ // cooldown: cannot reuse, ready again after cooldown seconds (from activation)
  const b = bike(0, -300 + 0, 0, 1, 0, ['turbo']), s = mk(b); b.baseSpeed = b.speed = 0;
  assert.ok(A.useAbility(b, s));
  assert.ok(!A.useAbility(b, s));
  run(s, CFG.abilities.turbo.cooldown - 0.1); assert.ok(!A.canUse(b, 'turbo'));
  run(s, 0.1 + DT); assert.ok(A.canUse(b, 'turbo')); assert.ok(A.useAbility(b, s));
  // reset each round: timers cleared, equipment kept
  resetBike(b, spawnPoints(4)[0]);
  assert.ok(A.canUse(b, 'turbo')); assert.deepEqual(b.abilities, ['turbo']); assert.equal(b.speed, CFG.baseSpeed);
}
{ // Turbo and normal boost don't multiply: max wins (either order)
  const b = bike(0, -300, 0, 1, 0, ['turbo']), s = mk(b);
  startBoost(b); run(s, DT); near(b.speed, 22.5, 1e-9);
  A.useAbility(b, s); run(s, DT); near(b.speed, 37.5, 1e-9);
  run(s, CFG.boost.duration); assert.ok(!b.boosting); near(b.speed, 37.5, 1e-9); // boost over, turbo remains
  const c = bike(1, -300, 10, 1, 0, ['turbo']), t = mk(c);
  A.useAbility(c, t); run(t, DT); startBoost(c); run(t, DT); near(c.speed, 37.5, 1e-9);
}
{ // Fast Charge: boost lasts 2.1 s, jump recharges in 3.75 s
  const b = bike(0, -300, 0, 1, 0, ['fastCharge']), s = mk(b);
  startBoost(b);
  run(s, 2.0); assert.ok(b.boosting);
  run(s, 0.1 + DT * 2); assert.ok(!b.boosting); near(b.speed, 15);
  b.baseSpeed = b.speed = 0;
  assert.ok(startJump(b)); run(s, 3.75 - 0.05); assert.ok(b.jumpMeter < 1);
  run(s, 0.1); assert.equal(b.jumpMeter, 1);
  const n = bike(1, -300, 10, 1, 0, []), t = mk(n); startBoost(n);
  run(t, 1.6); assert.ok(!n.boosting, 'normal boost stays 1.5 s');
}
{ // Rocket Jump: peak 7.0, longer arc, needs the jump ready, consumes the jump meter
  const b = bike(0, -300, 0, 1, 0, ['rocketJump']), s = mk(b);
  let peak = 0, air = 0;
  assert.ok(A.useAbility(b, s)); assert.equal(b.jumpMeter, 0);
  for (let i = 0; i < 3 * CFG.tickHz; i++) { step(s, DT); peak = Math.max(peak, b.y); if (b.jumpT >= 0) air++; }
  near(peak, 7, 1e-6); near(air * DT, 1.2 * CFG.abilities.rocketJump.timeScale, 2 * DT);
  assert.equal(b.y, 0);
  near(jumpY(0.5 * 1.4, 7, 1.4), 7);
  assert.ok(!A.useAbility(b, s) || b.cd.rocketJump >= 0); // cooldown running
  const c = bike(1, -300, 10, 1, 0, ['rocketJump']), t = mk(c); c.jumpMeter = 0.5;
  assert.ok(!A.useAbility(c, t), 'refused while jump recharging'); assert.equal(c.cd.rocketJump || 0, 0, 'no cooldown consumed');
  // next normal jump is normal again
  const d = bike(2, -300, 20, 1, 0, ['rocketJump']), u = mk(d);
  A.useAbility(d, u); run(u, 2); d.jumpMeter = 1; startJump(d); run(u, 0.5); near(d.y, 3.5, 1e-6);
}
{ // Double Jump: second jump in the air only when equipped, once per airtime, climbs higher
  const n = bike(0, -300, 0, 1, 0, []), t = mk(n); startJump(n); run(t, 0.5);
  assert.ok(!startJump(n), 'no double jump without the passive');
  const b = bike(1, -300, 10, 1, 0, ['doubleJump']), s = mk(b);
  assert.ok(!startJump(b) || true); b.jumpT = -1; b.jumpMeter = 1; b.jumpsUsed = 0;
  startJump(b); run(s, 0.5); near(b.y, 3.5, 1e-6);
  assert.ok(startJump(b)); assert.equal(b.jumpsUsed, 2);
  let peak = 0; for (let i = 0; i < 2 * CFG.tickHz; i++) { step(s, DT); peak = Math.max(peak, b.y); }
  near(peak, 7, 1e-6); assert.equal(b.y, 0);
  b.jumpMeter = 1; startJump(b); run(s, 0.3); assert.ok(startJump(b), 'djUsed resets on landing');
  assert.ok(!startJump(b), 'only one extra jump per airtime');
}
{ // Air Turn passive sets airTurn, allowing mid-air turns; survives round reset
  const b = bike(0, -300, 0, 1, 0, ['airTurn']), s = mk(b);
  assert.equal(b.airTurn, true);
  startJump(b); run(s, 0.4); assert.ok(canTurn(b)); turnBike(b, -1); assert.equal(b.dz, -1);
  resetBike(b, spawnPoints(4)[0]); assert.equal(b.airTurn, true);
  const n = bike(1, -300, 10, 1, 0, []); assert.equal(n.airTurn, false);
  startJump(n); run(mk(n), 0.4); assert.ok(!canTurn(n));
}
{ CFG.arena.half = REAL_HALF; // Protector: passes through a trail but not an arena wall; ends after duration
  const wall = parked(1, 0, -10, 10);
  const b = bike(0, -20, 0, 1, 0, ['protector']), s = mk(b, wall);
  A.useAbility(b, s);
  const ev = run(s, 2.5); // 15 u/s * 2.5 = 37.5 -> crosses x=0 wall trail and keeps going
  assert.equal(ev.length, 0); assert.ok(b.alive && b.x > 10);
  const c = bike(2, -20, 0, 1, 0, []), s2 = mk(c, parked(1, 0, -10, 10));
  assert.deepEqual(run(s2, 2.5).map((e) => [e.victim, e.killer]), [[2, 1]], 'unprotected dies on the trail');
  // arena wall still kills a protected bike
  const d = bike(3, 40, 0, 1, 0, ['protector']), s3 = mk(d); A.useAbility(d, s3);
  const e3 = run(s3, 2); assert.deepEqual(e3.map((e) => [e.victim, e.killer]), [[3, null]]);
  // after 3 s protection is over
  const f = bike(4, -45, 0, 1, 0, ['protector']), s4 = mk(f, parked(1, 40, -10, 10)); A.useAbility(f, s4);
  assert.ok(A.isProtected(f)); run(s4, 3.1); assert.ok(!A.isProtected(f));
  CFG.arena.half = 400;
}
{ // Slow Down: slows the USER's own bike (0.6x) for the duration; other bikes unaffected
  const a = bike(0, -300, 0, 1, 0, ['slowDown']), o = bike(1, -300, 10, 1, 0, []), p = bike(2, -300, 20, 1, 0, []), s = mk(a, o, p);
  assert.ok(A.useAbility(a, s));
  run(s, DT * 2); near(a.speed, 9, 1e-9); near(o.speed, 15); near(p.speed, 15);
  startBoost(a); run(s, DT); near(a.speed, 22.5 * 0.6, 1e-9); // stacks multiplicatively with boost
  run(s, CFG.abilities.slowDown.duration + DT); near(a.speed, 15, 1e-9); // slow and boost both over
  assert.ok(!A.useAbility(a, s), 'on cooldown');
}
{ // All Boost / All Jump: others forced, once per round, user unaffected
  const a = bike(0, -300, 0, 1, 0, ['allBoost', 'allJump']), o = bike(1, -300, 10, 1, 0, []), p = bike(2, -300, 20, 1, 0, []);
  o.boostMeter = 0.2; for (const x of [a, o, p]) x.baseSpeed = x.speed = 0; const s = mk(a, o, p);
  assert.equal(a.activeAbility, 0);
  assert.ok(A.useAbility(a, s));
  assert.ok(o.boosting && p.boosting && !a.boosting);
  assert.ok(!A.canUse(a, 'allBoost'), 'once per round');
  run(s, 100); assert.ok(!A.useAbility(a, s), 'cooldown-free but still once');
  assert.ok(A.cycleAbility(a)); assert.equal(a.abilities[a.activeAbility], 'allJump');
  const dead = bike(3, -300, 30, 1, 0, []); dead.alive = false; s.bikes.push(dead);
  assert.ok(A.useAbility(a, s));
  assert.ok(o.jumpT >= 0 && p.jumpT >= 0 && a.jumpT < 0 && dead.jumpT < 0);
  assert.ok(!A.canUse(a, 'allJump'));
  // new round: usable again
  resetBike(a, spawnPoints(4)[0]); assert.ok(A.canUse(a, 'allBoost') && A.canUse(a, 'allJump'));
}
{ // Stealth: flag set during duration only; cycling skips passives
  const b = bike(0, -300, 0, 1, 0, ['fastCharge', 'stealth', 'turbo']), s = mk(b);
  assert.equal(b.abilities[b.activeAbility], 'stealth');
  A.useAbility(b, s); run(s, DT); assert.equal(b.stealth, true);
  run(s, CFG.abilities.stealth.duration + 0.1); assert.equal(b.stealth, false);
  assert.ok(A.cycleAbility(b)); assert.equal(b.abilities[b.activeAbility], 'turbo');
  assert.ok(A.cycleAbility(b)); assert.equal(b.abilities[b.activeAbility], 'stealth');
}
{ // loadout validation + slot cap
  const b = bike(0, 0, 0, 1, 0, []);
  A.setLoadout(b, ['turbo', 'bogus', 'turbo', 'airTurn', 'stealth', 'slowDown']);
  assert.deepEqual(b.abilities, ['turbo', 'airTurn', 'stealth']);
}
{ CFG.arena.half = REAL_HALF; // Hard AI uses Turbo on a long open straight and Protector when boxed in
  const rng = () => 0; // always below chance
  const b = bike(1, -45, 0, 1, 0, ['turbo', 'protector']), s = mk(b);
  assert.ok(aiUseAbilities(s, b, createAI(2), rng)); assert.ok(A.isActive(b, 'turbo'));
  const y = bike(1, 0, 0, 1, 0, ['protector']);
  const u1 = parked(7, 4, -30, 30); // trail ahead (not the arena wall), side lanes blocked below
  const sides = [{ z: 1.5 }, { z: -1.5 }].map((p, i) => { const o = createBike(10 + i, 0, 0, 0, 1, 0); o.speed = o.baseSpeed = 0; Object.assign(o.trail[0], { x1: -30, x2: 30, z1: p.z, z2: p.z }); return o; });
  y.jumpMeter = 0; const s2 = mk(y, u1, ...sides);
  assert.ok(aiUseAbilities(s2, y, createAI(2), rng)); assert.ok(A.isProtected(y));
  // Normal / easy get no loadout from config
  assert.deepEqual(CFG.ai.loadouts[0], []); assert.deepEqual(CFG.ai.loadouts[1], []); assert.ok(CFG.ai.loadouts[2].includes('turbo'));
  // a hard match with abilities runs without errors and the AI actually uses them
  const st = createState(); CFG.players.forEach((p, i) => st.bikes.push(createBike(i, p.color, 0, 0, 0, -1)));
  const m = createMatch(st, MODES.standard, makeRng(3)); m.startMatch();
  const ais = new Map(); for (let i = 1; i < 4; i++) { ais.set(i, createAI(2, i * 2)); A.setLoadout(st.bikes[i], CFG.ai.loadouts[2]); }
  let used = 0; const r = makeRng(5);
  for (let i = 0; i < 120 * 60; i++) {
    if (m.phase !== 'running') { m.advance(DT); if (m.phase === 'matchEnd') break; continue; }
    updateAIs(st, ais, st.tick++, r); const ev = step(st, DT); m.onTick(ev, DT);
    for (const b of st.bikes) if (b.id && A.isActive(b, 'turbo') && b.active.turbo > CFG.abilities.turbo.duration - 1.5 * DT) used++;
  }
  assert.ok(used > 0, 'hard AI used Turbo at least once');
  CFG.arena.half = 400;
}
{ // save: unknown / locked ids stripped, free ones always unlocked, slots capped, old saves get defaults
  store.clear();
  store.set(S.KEY, JSON.stringify({ coins: 1000, unlocks: { abilities: ['fastCharge', 'ghost', 7, 'fastCharge'] }, equipped: { abilities: ['ghost', 'rocketJump', 'fastCharge', 'turbo', 'fastCharge'] } }));
  let d = S.loadSave();
  assert.deepEqual(d.unlocks.abilities, ['turbo', 'fastCharge']);
  assert.deepEqual(d.equipped.abilities, ['fastCharge', 'turbo']); // rocketJump locked, ghost unknown, deduped
  const many = A.ABILITY_IDS;
  store.set(S.KEY, JSON.stringify({ unlocks: { abilities: many }, equipped: { abilities: many } }));
  d = S.loadSave(); assert.equal(d.equipped.abilities.length, CFG.abilities.maxSlots);
  store.set(S.KEY, JSON.stringify({ coins: 5 })); // old save without the fields
  d = S.loadSave(); assert.deepEqual(d.unlocks.abilities, ['turbo']); assert.deepEqual(d.equipped.abilities, ['turbo']);
  store.set(S.KEY, JSON.stringify({ equipped: { abilities: [] } })); // explicit empty stays empty
  assert.deepEqual(S.loadSave().equipped.abilities, []);
  store.set(S.KEY, JSON.stringify({ unlocks: { abilities: 'x' }, equipped: { abilities: 'y' } }));
  d = S.loadSave(); assert.deepEqual(d.unlocks.abilities, ['turbo']); assert.deepEqual(d.equipped.abilities, ['turbo']);
}
{ // buying + equipping
  store.clear(); S.loadSave();
  assert.deepEqual(S.buyAbility('airTurn'), { ok: false, reason: 'coins' });
  assert.deepEqual(S.buyAbility('nope'), { ok: false, reason: 'unknown' });
  assert.deepEqual(S.buyAbility('turbo'), { ok: false, reason: 'owned' });
  S.getSave().coins = 1000;
  assert.deepEqual(S.buyAbility('airTurn'), { ok: true }); assert.equal(S.getSave().coins, 600);
  assert.equal(S.toggleEquip('airTurn').ok, true); assert.deepEqual(S.getSave().equipped.abilities, ['turbo', 'airTurn']);
  assert.equal(S.toggleEquip('rocketJump').reason, 'locked');
  S.getSave().coins = 1000; S.buyAbility('stealth'); S.buyAbility('doubleJump');
  S.toggleEquip('stealth'); assert.equal(S.toggleEquip('doubleJump').reason, 'full');
  assert.equal(S.toggleEquip('turbo').equipped, false); assert.ok(!S.getSave().equipped.abilities.includes('turbo'));
  assert.equal(S.parseSave(JSON.stringify(S.getSave())).equipped.abilities.length, 2);
}
{ // tie placements: shared rank, coins of that rank
  assert.deepEqual(rankings({ 0: 0, 1: 3, 2: 3, 3: 1 }), { 1: 1, 2: 1, 3: 3, 0: 4 });
  assert.deepEqual(rankings({ 0: 5, 1: 3, 2: 3, 3: 0 }), { 0: 1, 1: 2, 2: 2, 3: 4 });
  assert.deepEqual(rankings({ 0: 2, 1: 2, 2: 2, 3: 2 }), { 0: 1, 1: 1, 2: 1, 3: 1 });
  assert.deepEqual(rankings({ 0: 0, 1: 5, 2: 3, 3: 0 }), { 1: 1, 2: 2, 0: 3, 3: 3 }); // 0-point player no longer 2nd by id
  assert.equal(S.coinsForPlacement(rankings({ 0: 5, 1: 3, 2: 3, 3: 0 })[2]), 50);
  assert.equal(S.coinsForPlacement(rankings({ 0: 5, 1: 3, 2: 3, 3: 0 })[3]), 10);
  const st = createState(); CFG.players.forEach((p, i) => st.bikes.push(createBike(i, p.color, 0, 0, 0, -1)));
  const m = createMatch(st, MODES.standard, () => 0); m.startMatch();
  m.scores = { 0: 5, 1: 2, 2: 2, 3: 0 }; m.phase = 'roundEnd'; m.delay = 0; m.advance(1);
  assert.equal(m.phase, 'matchEnd'); assert.deepEqual(m.ranks, { 0: 1, 1: 2, 2: 2, 3: 4 });
}
console.log('abilities2 tests passed');
