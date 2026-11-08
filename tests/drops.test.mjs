import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const S = await import('../js/save.js');
const { dropsEarned, rollDrop, applyDrop, awardDrops } = await import('../js/drops.js');
const { DEFAULT_DROPS: T } = await import('../js/dropdef.js');
const { ABILITIES, ABILITY_IDS } = await import('../js/abilities.js');
const paid = ABILITY_IDS.filter((id) => ABILITIES[id].price > 0);
const seeded = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); // LCG
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
const fresh = () => { store.clear(); S.loadSave(); return S.getSave(); };

{ // earning: win 1, bonus win 2, lose streak 3, extra chance
  const no = () => 0.99, yes = () => 0;
  assert.deepEqual(dropsEarned({ won: true, bonus: false, streak: 2 }, T, no), { count: 1, streak: 0 });
  assert.deepEqual(dropsEarned({ won: true, bonus: true, streak: 0 }, T, no), { count: 2, streak: 0 });
  assert.deepEqual(dropsEarned({ won: false, bonus: true, streak: 0 }, T, no), { count: 0, streak: 1 });
  assert.deepEqual(dropsEarned({ won: false, bonus: false, streak: 1 }, T, no), { count: 0, streak: 2 });
  assert.deepEqual(dropsEarned({ won: false, bonus: false, streak: 2 }, T, no), { count: 1, streak: 0 });
  assert.deepEqual(dropsEarned({ won: false, bonus: false, streak: 0 }, T, yes), { count: 1, streak: 1 }); // extra only
  assert.deepEqual(dropsEarned({ won: true, bonus: true, streak: 0 }, T, yes), { count: 3, streak: 0 });
}
{ // tier distribution follows weights (no unlimited: odds huge)
  const t = { ...T, unlimitedOdds: 1e7 }, d = fresh(), rng = seeded(7), n = 20000, c = { common: 0, rare: 0, epic: 0 };
  for (let i = 0; i < n; i++) c[rollDrop(d, t, rng).tier]++;
  const sum = 98;
  for (const [k, w] of [['common', 70], ['rare', 20], ['epic', 8]]) assert.ok(Math.abs(c[k] / n - w / sum) < 0.015, k);
}
{ // unlimited: random not-yet-unlimited paid ability; applying removes charges and keeps it owned
  const d = fresh(), t = { ...T, unlimitedOdds: 2 };
  d.unlocks.abilityInf = paid.slice(1); d.unlocks.abilityCount[paid[0]] = 5;
  const x = rollDrop(d, t, seq(0, 0));
  assert.deepEqual([x.tier, x.id, x.inf], ['unlimited', paid[0], true]);
  applyDrop(d, x);
  assert.ok(S.isInfinite(paid[0]) && !d.unlocks.abilityCount[paid[0]] && d.unlocks.abilities.includes(paid[0]));
  const y = rollDrop(d, t, seq(0, 0)); // owns all -> half of the infinite price
  assert.equal(y.inf, undefined); assert.equal(y.coins, Math.floor(ABILITIES[paid[0]].price * S.INFINITE_MULT / 2));
}
{ // charges: normal, unlimited owner gets half value, 99 cap overflow -> coins
  const d = fresh();
  const t = { ...T, unlimitedOdds: 1e7, tiers: { ...T.tiers, common: { weight: 70, rewards: [{ kind: 'ability', pool: 'normal', count: 5 }] } } };
  const pick = seq(0.99, 0, 0, 0); // not unlimited, common tier, only reward, pool index 0
  let x = rollDrop(d, t, pick);
  assert.equal(x.tier, 'common'); assert.equal(x.n, 5); assert.ok(ABILITIES[x.id].price <= T.normalMax);
  applyDrop(d, x); assert.equal(d.unlocks.abilityCount[x.id], 5); assert.ok(d.unlocks.abilities.includes(x.id));
  d.unlocks.abilityCount[x.id] = 97; x = rollDrop(d, t, seq(0.99, 0, 0, 0));
  assert.equal(x.n, 2); assert.equal(x.coins, Math.floor(3 * ABILITIES[x.id].price / 2));
  applyDrop(d, x); assert.equal(d.unlocks.abilityCount[x.id], S.STACK_MAX); assert.equal(d.coins, x.coins);
  d.unlocks.abilityInf = [x.id]; delete d.unlocks.abilityCount[x.id];
  const z = rollDrop(d, t, seq(0.99, 0, 0, 0)); // same pool index 0 -> same ability, now unlimited
  assert.equal(z.id, x.id); assert.equal(z.n, 0); assert.equal(z.coins, Math.floor(5 * ABILITIES[x.id].price / 2));
}
{ // awardDrops: streak kept in the save, win resets it, result is saved and survives a reload
  const d = fresh();
  for (let i = 0; i < 2; i++) assert.equal(awardDrops({ won: false, bonus: false }, () => 0.99).length, 0);
  assert.equal(d.stats.dropLose, 2);
  assert.equal(awardDrops({ won: false, bonus: false }, () => 0.99).length, 1); assert.equal(d.stats.dropLose, 0);
  awardDrops({ won: false, bonus: false }, () => 0.99); awardDrops({ won: true, bonus: false }, () => 0.99); assert.equal(d.stats.dropLose, 0);
  const total = d.coins + Object.values(d.unlocks.abilityCount).length;
  assert.ok(total > 0); assert.equal(S.loadSave().stats.dropLose, 0); assert.equal(S.getSave().coins, d.coins);
}
console.log('drops tests passed');
