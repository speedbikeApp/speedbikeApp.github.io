import assert from 'node:assert/strict';

// Fake localStorage
const store = new Map();
let throwing = false;
globalThis.localStorage = {
  getItem: (k) => { if (throwing) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (throwing) throw new Error('denied'); store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
};
const S = await import('../js/save.js');
const { CFG } = await import('../js/config.js');

{ // empty -> defaults
  store.clear();
  const d = S.loadSave();
  assert.deepEqual(d, S.defaults());
  assert.equal(d.coins, 0); assert.equal(d.profile.username, 'PLAYER');
}
{ // corrupt JSON / wrong top-level types recover
  for (const bad of ['{not json', 'null', '[1,2]', '"str"', '42', '{"settings":5,"stats":"x","coins":"lots"}']) {
    store.set(S.KEY, bad);
    assert.deepEqual(S.loadSave(), S.defaults(), bad);
  }
}
{ // missing fields merged, existing kept, unknown dropped, bad values clamped
  store.set(S.KEY, JSON.stringify({ settings: { bloom: 0, muted: true, masterVol: 5, aiDifficulty: 9, quality: 'ultra', junk: 1 },
    coins: 150.7, stats: { wins: 3, kills: -4 }, unlocks: { abilities: ['turbo'], parts: { wheel1: true, body: ['sleek', 'nope', 'apex'] } }, extra: 1 }));
  const d = S.loadSave();
  assert.equal(d.settings.bloom, 0); assert.equal(d.settings.muted, true);
  assert.equal(d.settings.masterVol, 1); assert.equal(d.settings.aiDifficulty, 2); assert.equal(d.settings.quality, 'high');
  assert.equal(d.settings.musicVol, CFG.audio.music); assert.ok(!('junk' in d.settings)); assert.ok(!('extra' in d));
  assert.equal(d.coins, 150); assert.equal(d.stats.wins, 3); assert.equal(d.stats.kills, 0); assert.equal(d.stats.matches, 0);
  assert.deepEqual(d.unlocks.abilities, ['turbo']); assert.deepEqual(d.unlocks.parts.body, ['sleek', 'apex']); assert.ok(!('wheel1' in d.unlocks.parts));
}
{ // single-player map choice: default random, valid id kept, junk -> random; mode validity + fallback
  const { modeWithMap, MODES } = await import('../js/modes.js');
  assert.equal(S.defaults().settings.spMap, 'random');
  for (const [v, want] of [['crater', 'crater'], ['nope', 'random'], ['constructor', 'random'], [5, 'random']]) {
    store.set(S.KEY, JSON.stringify({ settings: { spMap: v } })); assert.equal(S.loadSave().settings.spMap, want, String(v));
  }
  assert.deepEqual([].concat(modeWithMap('standard', 'tiers').map), ['tiers']);
  assert.equal(modeWithMap('3d', 'arena'), MODES['3d']); assert.equal(modeWithMap('hyper', 'random'), MODES.hyper);
  assert.deepEqual([].concat(modeWithMap('3d', 'stairs').map), ['stairs']); assert.equal(modeWithMap('3d', 'stairs').speed, MODES['3d'].speed);
}
{ // storage that throws never breaks anything
  throwing = true;
  const d = S.loadSave(); assert.deepEqual(d, S.defaults());
  S.flushSave(); S.setUsername('x'); S.flushSave();
  throwing = false;
}
{ // username sanitizing
  assert.equal(S.sanitizeName('  Bob  '), 'Bob');
  assert.equal(S.sanitizeName('<img src=x onerror=1>'), 'img srcx one');
  assert.equal(S.sanitizeName('ABCDEFGHIJKLMNOPQRS'), 'ABCDEFGHIJKL');
  assert.equal(S.sanitizeName('a   b'), 'a b');
  assert.equal(S.sanitizeName('<>"\'&;'), 'PLAYER');
  assert.equal(S.sanitizeName(''), 'PLAYER'); assert.equal(S.sanitizeName(null), 'PLAYER'); assert.equal(S.sanitizeName({}), 'PLAYER');
  assert.equal(S.sanitizeName('Ünï_cöde-1'), 'n_cde-1');
  assert.ok(!/[^A-Za-z0-9 _-]/.test(S.sanitizeName('Ünï<script>')));
  store.clear(); S.loadSave();
  assert.equal(S.setUsername('  Neo<b> '), 'Neob');
  S.flushSave(); assert.equal(JSON.parse(store.get(S.KEY)).profile.username, 'Neob');
  store.set(S.KEY, JSON.stringify({ profile: { username: '<script>alert(1)</script>' } }));
  assert.equal(S.loadSave().profile.username, 'scriptalert1script'.slice(0, 12));
}
{ // coins by placement
  assert.deepEqual([1, 2, 3, 4, 5].map(S.coinsForPlacement), [100, 50, 25, 10, 0]);
}
{ // stats update + persistence + streaks
  store.clear(); S.loadSave();
  S.addSessionStats({ kills: 2, distance: 123.5, boosts: 3, jumps: 4 });
  let r = S.recordMatch(1);
  assert.deepEqual(r, { placement: 1, earned: 100, total: 100, won: true, unlocked: [] });
  r = S.recordMatch(1); assert.equal(r.total, 200);
  r = S.recordMatch(3); assert.equal(r.earned, 25); assert.equal(r.won, false);
  const st = S.getSave().stats;
  assert.equal(st.matches, 3); assert.equal(st.wins, 2); assert.equal(st.winStreak, 0); assert.equal(st.bestStreak, 2);
  assert.equal(st.kills, 2); assert.equal(st.distance, 123.5); assert.equal(st.boosts, 3); assert.equal(st.jumps, 4);
  S.recordMatch(1); assert.equal(S.getSave().stats.winStreak, 1); assert.equal(S.getSave().stats.bestStreak, 2);
  // persisted immediately by recordMatch; reload sees it
  const again = S.loadSave();
  assert.equal(again.coins, 100 + 100 + 25 + 100); assert.equal(again.stats.matches, 4);
}
{ // debounced write lands
  store.clear(); S.loadSave(); S.setSetting('bloom', 0.5);
  assert.ok(!store.has(S.KEY));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(JSON.parse(store.get(S.KEY)).settings.bloom, 0.5);
  S.setSetting('bloom', 99); assert.equal(S.getSave().settings.bloom, 3); S.flushSave();
}
console.log('save tests ok');
