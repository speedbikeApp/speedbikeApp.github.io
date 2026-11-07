import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const S = await import('../js/save.js');
const { CFG } = await import('../js/config.js');
const C = await import('../js/cloudsave.js');

// ---- migration from a v1 save ----
mem.set(S.KEY, JSON.stringify({ version: 1, coins: 77, unlocks: { abilities: ['turbo', 'stealth', 'airTurn', 'bogus'] }, equipped: { abilities: ['stealth', 'airTurn'] } }));
let d = S.loadSave();
assert.equal(d.version, 2);
assert.equal(S.abilityCharges('stealth'), 5); assert.equal(S.abilityCharges('airTurn'), 5); assert.equal(S.abilityCharges('protector'), 0);
assert.equal(S.abilityCharges('turbo'), Infinity); assert.equal(S.abilityCharges('nope'), 0);
assert.deepEqual(d.equipped.abilities, ['stealth', 'airTurn']); assert.equal(d.coins, 77);
// sanitize new format
d = S.parseSave(JSON.stringify({ unlocks: { abilityCount: { stealth: 500, slowDown: -3, bogus: 4, protector: 2.9, turbo: 7 }, abilityInf: ['allJump', 'nope', 'turbo'] } }));
assert.equal(d.unlocks.abilityCount.stealth, 99); assert.ok(!('slowDown' in d.unlocks.abilityCount)); assert.ok(!('bogus' in d.unlocks.abilityCount));
assert.equal(d.unlocks.abilityCount.protector, 2); assert.ok(!('turbo' in d.unlocks.abilityCount));
assert.deepEqual(d.unlocks.abilityInf, ['allJump']);
assert.ok(d.unlocks.abilities.includes('allJump') && d.unlocks.abilities.includes('stealth'));

// ---- buying ----
S.resetSave();
const price = CFG.abilities.stealth.price, g = S.getSave();
g.coins = price * 99 + price * 100 + 5;
assert.deepEqual(S.buyAbility('turbo'), { ok: false, reason: 'owned' });
assert.equal(S.buyInfinite('stealth').reason, 'need99');
for (let i = 1; i <= 99; i++) { assert.ok(S.buyAbility('stealth').ok); assert.equal(S.abilityCharges('stealth'), i); }
assert.equal(S.buyAbility('stealth').reason, 'max');
assert.equal(g.coins, price * 100 + 5);
assert.ok(S.buyInfinite('stealth').ok); assert.equal(g.coins, 5);
assert.equal(S.abilityCharges('stealth'), Infinity); assert.equal(S.buyAbility('stealth').reason, 'owned'); assert.equal(S.buyInfinite('stealth').reason, 'owned');
assert.equal(S.infinitePrice('stealth'), price * 100);
assert.ok(S.spendAbility('stealth')); assert.equal(S.abilityCharges('stealth'), Infinity);
// not enough coins for infinite
g.unlocks.abilityCount.slowDown = 99; g.coins = 10;
assert.equal(S.buyInfinite('slowDown').reason, 'coins'); assert.equal(S.buyAbility('slowDown').reason, 'max');

// ---- spending ----
g.coins = 10000; S.buyAbility('protector'); S.buyAbility('protector');
assert.ok(S.spendAbility('protector')); assert.ok(S.spendAbility('protector')); assert.equal(S.spendAbility('protector'), false);
assert.equal(S.abilityCharges('protector'), 0); assert.ok(S.getSave().unlocks.abilities.includes('protector'), 'stays owned/equippable');
assert.equal(S.spendAbility('nope'), false); assert.ok(S.spendAbility('turbo'));
// equipped at 0 stays equipped but unusable
S.buyAbility('doubleJump'); S.buyAbility('airTurn'); S.buyAbility('airTurn');
for (const id of ['protector', 'doubleJump', 'airTurn']) S.toggleEquip(id);
assert.deepEqual(g.equipped.abilities.filter((x) => x !== 'turbo'), ['protector', 'doubleJump', 'airTurn'].filter((x) => g.equipped.abilities.includes(x)));
g.equipped.abilities = ['protector', 'doubleJump', 'airTurn'];
assert.deepEqual(S.usableAbilities(), ['doubleJump', 'airTurn']);
// passives: 1 per match, actives untouched
assert.deepEqual(S.spendPassives(['protector', 'doubleJump', 'airTurn']), ['doubleJump', 'airTurn']);
assert.equal(S.abilityCharges('doubleJump'), 0); assert.equal(S.abilityCharges('airTurn'), 1);
assert.deepEqual(S.spendPassives(['doubleJump', 'airTurn']), ['airTurn']);
assert.deepEqual(S.spendPassives(['doubleJump', 'airTurn']), []);
assert.deepEqual(S.usableAbilities(), []);
// persistence
S.flushSave(); const re = S.parseSave(mem.get(S.KEY));
assert.equal(re.unlocks.abilityCount.airTurn, undefined); assert.deepEqual(re.unlocks.abilityInf, ['stealth']);

// ---- cloud merge: counts follow the newer save, infinite unions ----
const mk = (o) => S.progressOf(S.parseSave(JSON.stringify(o)));
const a = mk({ coins: 5, updatedAt: 100, unlocks: { abilityCount: { stealth: 40, protector: 3 }, abilityInf: ['allBoost'] } });
const b = mk({ coins: 9, updatedAt: 200, unlocks: { abilityCount: { stealth: 2 }, abilityInf: ['allJump'] } });
let m = C.mergeProgress(a, b);
assert.deepEqual(m.unlocks.abilityCount, { stealth: 2 }, 'newer (cloud) counts, no max/union');
assert.deepEqual(m.unlocks.abilityInf.sort(), ['allBoost', 'allJump']);
m = C.mergeProgress(b, a); assert.deepEqual(m.unlocks.abilityCount, { stealth: 2 });
assert.equal(C.mergeProgress(a, { ...b, updatedAt: 50 }).unlocks.abilityCount.stealth, 40);
const r = C.resolveProgress(S.parseSave(JSON.stringify(a)), b, 'u');
assert.equal(r.unlocks.abilityCount.stealth, 2); assert.equal(r.unlocks.abilityCount.protector, undefined); assert.ok(r.unlocks.abilityInf.includes('allBoost'));
console.log('consumables ok');
