import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const S = await import('../js/save.js');
const L = await import('../js/levels.js');
const { DEFAULT_LEVELS, validateLevels, setLevelTable, getLevelTable } = await import('../js/leveldef.js');
const { mergeProgress } = await import('../js/cloudsave.js');
const { ABILITIES, ABILITY_IDS } = await import('../js/abilities.js');
const paid = ABILITY_IDS.filter((id) => ABILITIES[id].price > 0);
const dearest = paid.reduce((a, b) => (ABILITIES[b].price > ABILITIES[a].price ? b : a));
const topTied = paid.filter((id) => ABILITIES[id].price === ABILITIES[dearest].price).length; // ties at the top are all excluded
const fresh = () => { store.clear(); S.loadSave(); return S.getSave(); };
const rng = () => 0.99; // no unlimited roll, last reward of the tier
const T = (o) => setLevelTable({ ...DEFAULT_LEVELS, ...o });

{ // xp math
  assert.deepEqual(DEFAULT_LEVELS, getLevelTable());
  assert.equal(L.xpFor({ won: true, online: false }), 3333); assert.equal(L.xpFor({ won: false, online: false }), 1667);
  assert.equal(L.xpFor({ won: true, online: true }), 5000); assert.equal(L.xpFor({ won: false, online: true }), 2500);
  T({ xpPerLevel: 9000 });
  assert.equal(L.xpFor({ won: true, online: false }), 3000); assert.equal(L.xpFor({ won: false, online: false }), 1500);
  T({});
}
{ // validation
  assert.equal(validateLevels(DEFAULT_LEVELS).ok, true);
  for (const k of Object.keys(DEFAULT_LEVELS)) { const l = { ...DEFAULT_LEVELS }; delete l[k]; assert.deepEqual(validateLevels(l), { ok: false, why: k }); }
  assert.equal(validateLevels({ ...DEFAULT_LEVELS, onlineMult: 0.9 }).ok, false); assert.equal(validateLevels({ ...DEFAULT_LEVELS, winsPerLevel: 0 }).ok, false);
  assert.equal(validateLevels(null).ok, false); assert.equal(setLevelTable({ xpPerLevel: 1 }), false); assert.deepEqual(getLevelTable(), DEFAULT_LEVELS);
}
{ // 3 wins or 6 games = exactly one level (xpPerLevel divisible by both, so no rounding drift)
  T({ xpPerLevel: 9000 }); const d = fresh();
  for (let i = 0; i < 2; i++) assert.equal(L.awardXp({ won: true, online: false }, rng).levelsUp.length, 0);
  let r = L.awardXp({ won: true, online: false }, rng); assert.deepEqual([r.levelsUp.length, d.level, d.xp], [1, 2, 0]);
  for (let i = 0; i < 5; i++) assert.equal(L.awardXp({ won: false, online: false }, rng).levelsUp.length, 0);
  r = L.awardXp({ won: false, online: false }, rng); assert.deepEqual([r.levelsUp.length, d.level, d.xp], [1, 3, 0]);
  assert.deepEqual(r.info, L.levelInfo()); assert.equal(r.gained, 1500);
  T({});
}
{ // multi-level gain, coins, best-only milestone drops, persisted right away
  const d = fresh(); T({ xpPerLevel: 1000, winsPerLevel: 1, onlineMult: 10 }); // an online win = 10000 xp = 10 levels
  const r = L.awardXp({ won: true, online: true }, rng);
  assert.deepEqual(r.levelsUp.map((x) => x.level), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(r.levelsUp.map((x) => x.coins), [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
  assert.deepEqual(r.levelsUp.map((x) => x.drop && x.drop.tier), [null, null, null, 'rare', null, null, null, null, 'epic', null], 'level 5 rare, level 10 epic only (not also rare)');
  const dropCoins = r.levelsUp.reduce((a, x) => a + (x.drop ? x.drop.coins || 0 : 0), 0);
  assert.equal(d.coins, 6500 + dropCoins); assert.equal(S.loadSave().level, 11);
  T({});
}
{ // coins cap at 4500 from level 45; level 100 is legendary only; 250 reachable
  const d = fresh(), got = [];
  d.level = 43;
  for (let i = 0; i < 4; i++) { d.xp = 9999; got.push(L.awardXp({ won: false, online: false }, rng).levelsUp[0].coins); }
  assert.deepEqual(got, [4400, 4500, 4500, 4500]); // levels 44 45 46 47
  d.level = 99; d.xp = 9999;
  const r = L.awardXp({ won: false, online: false }, rng); assert.equal(r.levelsUp[0].level, 100); assert.equal(r.levelsUp[0].drop.tier, 'legendary');
  d.level = 199; d.xp = 9999; assert.equal(L.awardXp({ won: false, online: false }, rng).levelsUp[0].drop.tier, 'legendary');
  d.level = 249; d.xp = 9999; assert.deepEqual(L.awardXp({ won: true, online: true }, rng).levelsUp.map((x) => x.level), [250]);
}
{ // max level: xp stops at need-1, no overflow levels or rewards
  const d = fresh(); d.level = 250; d.xp = 9990; const c = d.coins;
  const r = L.awardXp({ won: true, online: true }, rng);
  assert.deepEqual([r.levelsUp.length, d.level, d.xp, d.coins], [0, 250, 9999, c]); assert.equal(r.info.canPrestige, true);
  d.level = 249; d.xp = 9999; L.awardXp({ won: true, online: true }, rng); assert.deepEqual([d.level, d.xp], [250, 9999], 'arriving at max fills the bar');
}
{ // prestige + picks
  const d = fresh();
  assert.deepEqual(L.prestige(), { ok: false, reason: 'notMax' });
  assert.deepEqual(L.pickPrestigeUnlimited(paid[0]), { ok: false, reason: 'noPick' });
  d.level = 250; d.xp = 5;
  assert.deepEqual(L.prestige(), { ok: true });
  assert.deepEqual([d.level, d.xp, d.prestige, d.prestigePicks], [1, 0, 1, 1]);
  const ch = L.prestigeChoices(); assert.ok(!ch.includes(dearest) && !ch.includes('turbo') && ch.length === paid.length - topTied);
  assert.deepEqual(L.pickPrestigeUnlimited(dearest), { ok: false, reason: 'notAllowed' }); assert.equal(d.prestigePicks, 1);
  assert.deepEqual(L.pickPrestigeUnlimited('turbo'), { ok: false, reason: 'notAllowed' });
  d.unlocks.abilityCount[ch[0]] = 7;
  assert.deepEqual(L.pickPrestigeUnlimited(ch[0]), { ok: true });
  assert.ok(S.isInfinite(ch[0]) && !d.unlocks.abilityCount[ch[0]] && d.unlocks.abilities.includes(ch[0]) && d.prestigePicks === 0);
  assert.ok(!L.prestigeChoices().includes(ch[0]));
  assert.deepEqual(L.pickPrestigeUnlimited(ch[1]), { ok: false, reason: 'noPick' });
  assert.equal(S.loadSave().prestige, 1);
}
{ // save sanitizing, old saves, sync
  const old = S.parseSave(JSON.stringify({ coins: 5 })); assert.deepEqual([old.level, old.xp, old.prestige, old.prestigePicks], [1, 0, 0, 0]);
  const big = S.parseSave(JSON.stringify({ level: 999, xp: 99999, prestige: -3, prestigePicks: 2.7 })); assert.deepEqual([big.level, big.xp, big.prestige, big.prestigePicks], [250, 9999, 0, 2]);
  const low = S.parseSave(JSON.stringify({ level: -4, xp: -1, prestige: 'x', prestigePicks: null })); assert.deepEqual([low.level, low.xp, low.prestige, low.prestigePicks], [1, 0, 0, 0]);
  const K = ['level', 'xp', 'prestige', 'prestigePicks'];
  const a = S.progressOf(S.parseSave(JSON.stringify({ level: 12, xp: 3, prestige: 2, prestigePicks: 1, updatedAt: 5 })));
  assert.deepEqual(K.map((k) => a[k]), [12, 3, 2, 1]);
  const b = S.progressOf(S.parseSave(JSON.stringify({ level: 40, xp: 9, prestige: 0, prestigePicks: 0, updatedAt: 9 })));
  assert.deepEqual(K.map((k) => mergeProgress(a, b)[k]), [40, 9, 0, 0], 'newer save wins (cloud)');
  assert.deepEqual(K.map((k) => mergeProgress(b, a)[k]), [40, 9, 0, 0], 'newer save wins (local)');
  fresh(); S.applyProgress(b, 'u1'); assert.deepEqual([S.getSave().level, S.getSave().xp], [40, 9]);
  const d = fresh(); d.updatedAt = 0; d.level = 3; S.flushSave(); assert.ok(d.updatedAt > 0, 'a level change counts as progress (syncs)');
}
console.log('levels tests passed');
