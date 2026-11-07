// Phase 8: achievements (exact thresholds, once only), part unlocks (achievement + purchase), save validation, colour clashes.
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const S = await import('../js/save.js');
const P = await import('../js/parts.js');
const A = await import('../js/achievements.js');
const { CFG } = await import('../js/config.js');
const fresh = () => { store.clear(); return S.loadSave(); };

{ // registry sanity: sizes, defaults free, every achievement reward is an ach-locked part pointing back at it
  assert.ok(P.PARTS.body.length >= 3 && P.PARTS.tire.length >= 3 && P.PARTS.rim.length >= 4 && P.PARTS.glow.length >= 8);
  for (const c of P.CATS) {
    assert.ok(P.isFreePart(P.getPart(c, P.DEFAULT_PARTS[c])), `${c} default is free`);
    assert.equal(new Set(P.partList(c).map((p) => p.id)).size, P.partList(c).length, 'unique ids');
    assert.ok(P.partList(c).some((p) => p.price > 0), `${c} has coin parts`);
  }
  for (const a of A.ACHIEVEMENTS) {
    const p = P.getPart(a.reward.cat, a.reward.id);
    assert.ok(p && p.ach === a.id, `${a.id} reward ${a.reward.id}`);
  }
  for (const c of P.CATS) for (const p of P.partList(c)) if (p.ach) assert.ok(A.getAchievement(p.ach).reward.id === p.id);
  assert.ok(A.ACHIEVEMENTS.length >= 8);
}

// each achievement: just under target -> nothing, at target -> exactly that one (plus its part), then never again
const SETUP = {
  boost5: (st, v) => { st.bestRoundBoosts = v; }, jump5: (st, v) => { st.bestRoundJumps = v; },
  kills100: (st, v) => { st.kills = v; }, streak10: (st, v) => { st.bestStreak = v; }, wins100: (st, v) => { st.wins = v; },
  dist50k: (st, v) => { st.distance = v; }, flawless: (st, v) => { st.dmFlawless = v; }, win3d: (st, v) => { st.wins3d = v; },
  hyperWin: (st, v) => { st.winsHyper = v; },
};
for (const a of A.ACHIEVEMENTS) {
  const d = fresh();
  SETUP[a.id](d.stats, a.target - 1);
  assert.deepEqual(S.checkAchievements(), [], `${a.id} below threshold`);
  assert.ok(!S.partOwned(a.reward.cat, a.reward.id));
  SETUP[a.id](d.stats, a.target);
  assert.deepEqual(S.checkAchievements(), [a.id], `${a.id} at threshold`);
  assert.ok(S.partOwned(a.reward.cat, a.reward.id), `${a.id} unlocks ${a.reward.id}`);
  assert.deepEqual(S.checkAchievements(), [], `${a.id} only once`);
  SETUP[a.id](d.stats, a.target * 3);
  assert.deepEqual(S.checkAchievements(), [], `${a.id} not again above`);
  assert.deepEqual(d.unlocks.achievements, [a.id]);
}
assert.deepEqual(A.newlyEarned({ kills: 100 }, []), ['kills100']);
assert.deepEqual(A.newlyEarned({ kills: 100 }, ['kills100']), []);

{ // round counters: 4 boosts nothing, 5th boost in ONE round triggers; best-of is kept
  fresh();
  assert.deepEqual(S.recordRound({ boosts: 4, jumps: 4 }), []);
  assert.deepEqual(S.recordRound({ boosts: 5, jumps: 0 }), ['boost5']);
  assert.deepEqual(S.recordRound({ boosts: 9, jumps: 5 }), ['jump5']);
  assert.deepEqual(S.recordRound({ boosts: 9, jumps: 9 }), []);
  assert.equal(S.getSave().stats.bestRoundBoosts, 9);
  assert.ok(S.partOwned('rim', 'triblade') && S.partOwned('rim', 'ring'));
}
{ // session stats: kills / distance thresholds hit exactly
  const d = fresh();
  assert.deepEqual(S.addSessionStats({ kills: 99, distance: 49999 }), []);
  assert.deepEqual(S.addSessionStats({ kills: 1, distance: 1 }).sort(), ['dist50k', 'kills100']);
  assert.deepEqual(S.addSessionStats({ kills: 50, distance: 5000 }), []);
  assert.ok(d.unlocks.parts.tire.includes('knobby') && d.unlocks.parts.rim.includes('turbine'));
}
{ // matches: win streak 10, wins 100, mode wins, flawless Death Match
  const d = fresh();
  for (let i = 0; i < 9; i++) assert.deepEqual(S.recordMatch(1).unlocked, []);
  assert.deepEqual(S.recordMatch(1).unlocked, ['streak10']); // 10th in a row
  assert.equal(d.stats.bestStreak, 10);
  S.recordMatch(2); for (let i = 0; i < 10; i++) assert.ok(!S.recordMatch(1).unlocked.includes('streak10'));
  d.stats.wins = 98; assert.deepEqual(S.recordMatch(1).unlocked, []); assert.deepEqual(S.recordMatch(1).unlocked, ['wins100']);
  const e = fresh();
  assert.deepEqual(S.recordMatch(2, 0, { mode: '3d' }).unlocked, []);        // a loss does not count
  assert.deepEqual(S.recordMatch(1, 0, { mode: 'standard' }).unlocked, []);
  assert.deepEqual(S.recordMatch(1, 0, { mode: '3d' }).unlocked, ['win3d']);
  assert.deepEqual(S.recordMatch(1, 0, { mode: 'hyper' }).unlocked, ['hyperWin']);
  assert.deepEqual(S.recordMatch(1, 0, { mode: 'deathmatch', flawless: false }).unlocked, []);
  assert.deepEqual(S.recordMatch(2, 0, { mode: 'deathmatch', flawless: true }).unlocked, []);
  assert.deepEqual(S.recordMatch(1, 0, { mode: 'deathmatch', flawless: true }).unlocked, ['flawless']);
  assert.deepEqual(S.recordMatch(1, 0, { mode: '3d' }).unlocked, []); assert.equal(e.stats.wins3d, 2);
}

{ // purchases: insufficient coins rejected, exact coins ok, double buy rejected, achievement parts cannot be bought
  const d = fresh();
  assert.deepEqual(S.buyPart('body', 'armored'), { ok: false, reason: 'coins' });
  assert.ok(!S.partOwned('body', 'armored')); assert.equal(d.coins, 0);
  d.coins = 499; assert.equal(S.buyPart('body', 'armored').reason, 'coins'); assert.equal(d.coins, 499);
  d.coins = 500; assert.deepEqual(S.buyPart('body', 'armored'), { ok: true });
  assert.equal(d.coins, 0); assert.ok(S.partOwned('body', 'armored'));
  d.coins = 9999; assert.equal(S.buyPart('body', 'armored').reason, 'owned'); assert.equal(d.coins, 9999);
  assert.equal(S.buyPart('body', 'apex').reason, 'ach'); assert.equal(S.buyPart('glow', 'gold').reason, 'ach'); assert.equal(d.coins, 9999);
  assert.equal(S.buyPart('body', 'zzz').reason, 'unknown'); assert.equal(S.buyPart('nope', 'x').reason, 'unknown');
  // equip: only owned
  assert.equal(S.equipPart('body', 'frame').reason, 'locked'); assert.equal(d.equipped.parts.body, 'sleek');
  assert.ok(S.equipPart('body', 'armored').ok); assert.equal(d.equipped.parts.body, 'armored');
  assert.equal(S.equipPart('glow', 'gold').reason, 'locked');
  // earning the achievement makes the part equippable
  d.stats.wins = 100; S.checkAchievements();
  assert.ok(S.equipPart('body', 'apex').ok); assert.equal(d.equipped.parts.body, 'apex');
  // persists through save / load
  S.flushSave(); const again = S.loadSave();
  assert.equal(again.equipped.parts.body, 'apex'); assert.ok(again.unlocks.parts.body.includes('armored')); assert.ok(again.unlocks.achievements.includes('wins100'));
}

{ // save validation: unknown ids dropped, defaults restored, unowned equipped parts reset, junk types survive
  store.set(S.KEY, JSON.stringify({
    unlocks: { parts: { body: ['armored', 'bogus', 7], glow: ['gold'], rim: 'x', extra: ['y'] }, achievements: ['wins100', 'fake'] },
    equipped: { parts: { body: 'apex', tire: 'nope', rim: 5, glow: 'gold', junk: 1 } },
  }));
  const d = S.loadSave();
  assert.deepEqual(d.unlocks.parts.body, ['sleek', 'armored']);          // free restored, bogus + non-strings dropped
  assert.deepEqual(d.unlocks.parts.rim, P.freeParts('rim'));
  assert.ok(!('extra' in d.unlocks.parts));
  assert.deepEqual(d.unlocks.achievements, ['wins100']);
  assert.equal(d.equipped.parts.body, 'sleek', 'apex not owned -> default');
  assert.equal(d.equipped.parts.tire, 'slim'); assert.equal(d.equipped.parts.rim, 'spoked');
  assert.equal(d.equipped.parts.glow, 'gold', 'owned valid id is kept');
  assert.ok(!('junk' in d.equipped.parts));
  for (const bad of ['{"equipped":5}', '{"equipped":{"parts":"x"}}', '{"unlocks":{"parts":[]}}', '{"unlocks":null}']) {
    store.set(S.KEY, bad); const q = S.loadSave();
    assert.deepEqual(q.equipped.parts, P.DEFAULT_PARTS, bad); assert.deepEqual(q.unlocks.parts, S.defaults().unlocks.parts, bad);
  }
  // old save (phase 7): has equipped.abilities only -> parts defaulted, abilities untouched
  store.set(S.KEY, JSON.stringify({ coins: 40, equipped: { abilities: ['turbo'] }, unlocks: { abilities: ['turbo'], parts: {} } }));
  const old = S.loadSave(); assert.deepEqual(old.equipped.parts, P.DEFAULT_PARTS); assert.deepEqual(old.equipped.abilities, ['turbo']); assert.equal(old.coins, 40);
  assert.deepEqual(S.defaults().equipped.parts, P.DEFAULT_PARTS);
}

{ // colour clash: AI close to the player's colour gets another palette colour (and its name); others untouched
  const ai = CFG.players.slice(1).map((p) => ({ name: p.name, color: p.color }));
  const orange = P.glowHex('orange');
  assert.deepEqual(P.resolveAiColors(orange, ai), ai, 'default orange clashes with nobody');
  for (const g of P.PARTS.glow) { // every possible player colour: result is clash free
    const out = P.resolveAiColors(g.color, ai);
    out.forEach((o, i) => {
      assert.ok(P.colorDist(g.color, o.color) >= P.CLASH_DIST, `${g.id} vs AI ${i}`);
      for (let j = 0; j < i; j++) assert.ok(P.colorDist(out[j].color, o.color) >= P.CLASH_DIST, `${g.id} AI ${j}/${i}`);
    });
  }
  const same = P.resolveAiColors(ai[0].color, ai);                       // player picks exactly BLUE
  assert.notEqual(same[0].color, ai[0].color); assert.deepEqual(same.slice(1), ai.slice(1)); assert.notEqual(same[0].name, 'BLUE');
  const close = P.resolveAiColors(0xff2fd0 /* magenta */, ai);           // near PURPLE -> reassigned
  assert.ok(P.colorDist(0xff2fd0, ai[2].color) < P.CLASH_DIST); assert.notEqual(close[2].color, ai[2].color);
  const cyan = P.resolveAiColors(P.glowHex('cyan'), ai); assert.notEqual(cyan[0].color, ai[0].color); // cyan ~ blue
  assert.equal(P.colorDist(0, 0), 0); assert.ok(P.colorDist(0xffffff, 0) > 400);
}
console.log('progression tests ok');
