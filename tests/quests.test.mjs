// Quests: requirement / reward parsers, period keys, seeded picks, tracking, claims, rollover, cloud merge, events, match glue (questtrack).
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const S = await import('../js/save.js');
const D = await import('../js/questdef.js');
const Q = await import('../js/quests.js');
const T = await import('../js/questtrack.js');
const { mergeProgress } = await import('../js/cloudsave.js');
const { ABILITIES, ABILITY_IDS } = await import('../js/abilities.js');
const paid = ABILITY_IDS.filter((id) => ABILITIES[id].price > 0), pid = paid[0];
const fresh = () => { store.clear(); S.loadSave(); return S.getSave(); };
const rng = () => 0.99;
const utc = (...a) => Date.UTC(...a);

{ // requirement parser
  assert.deepEqual(D.parseRequirement('kill:10'), { id: 'kill', param: null, count: 10 });
  assert.deepEqual(D.parseRequirement('early_kill(30):1'), { id: 'early_kill', param: 30, count: 1 });
  for (const bad of ['', 'kill', 'kill:0', 'kill:100001', 'kill:1.5', 'nope:1', 'kill(5):1', 'early_kill:1', 'early_kill(0):1', 'early_kill(3601):1', 'early_death(x):1', 'kill:-1', null, 5, 'kill:1 extra', '__proto__:1', 'constructor:1']) assert.equal(D.parseRequirement(bad), null, String(bad));
  assert.equal(D.parseRequirement('kill:100000').count, 100000);
  for (const id of Object.keys(D.REQUIREMENTS)) assert.ok(D.parseRequirement(D.REQUIREMENTS[id].param ? `${id}(5):1` : `${id}:1`), id);
}
{ // reward parser
  assert.deepEqual(D.parseReward('coins:500'), [{ type: 'coins', amount: 500 }]);
  assert.deepEqual(D.parseReward('coins:500, rare_drop:2'), [{ type: 'coins', amount: 500 }, { type: 'rare_drop', amount: 2 }]);
  assert.deepEqual(D.parseReward(`powerup(${pid}):5`), [{ type: 'powerup', amount: 5, id: pid }]);
  for (const t of ['common_drop', 'rare_drop', 'epic_drop', 'legendary_drop', 'xp']) assert.ok(D.parseReward(`${t}:1`), t);
  for (const bad of ['', 'coins', 'coins:0', 'coins:1000001', 'gold:5', 'powerup:5', 'powerup(nope):5', `powerup(${pid}):100`, 'coins(x):5', 'rare_drop:11', 'coins:1,coins:1,coins:1,coins:1,coins:1', null, 3, 'coins:5;xp:5']) assert.equal(D.parseReward(bad), null, String(bad));
  const free = ABILITY_IDS.find((id) => ABILITIES[id].price === 0); if (free) assert.equal(D.parseReward(`powerup(${free}):5`), null, 'free ability');
}
{ // quest / config / event validation
  const q = { id: 'a1', title: 'T', body: 'b', requirement: 'kill:1', reward: 'coins:1' };
  assert.equal(D.validateQuest(q).ok, true);
  for (const f of [(x) => { x.id = 'bad id'; }, (x) => { x.id = ''; }, (x) => { x.title = ''; }, (x) => { x.title = 'x'.repeat(41); }, (x) => { x.body = 'x'.repeat(121); }, (x) => { x.requirement = 'zzz:1'; }, (x) => { x.reward = 'coins:0'; }]) { const x = { ...q }; f(x); assert.equal(D.validateQuest(x).ok, false); }
  assert.deepEqual(D.validateQuest({ ...q, junk: 1 }).quest, q, 'clean copy');
  assert.equal(D.validateQuestConfig(D.DEFAULT_QUESTS).ok, true);
  assert.equal(D.DEFAULT_QUESTS.season.length, 10); assert.ok(D.DEFAULT_QUESTS.daily.length >= 12 && D.DEFAULT_QUESTS.weekly.length >= 8);
  let v = D.validateQuestConfig({ ...D.DEFAULT_QUESTS, season: D.DEFAULT_QUESTS.season.slice(1) }); assert.equal(v.ok, false); assert.match(v.why, /season/);
  const dup = structuredClone(D.DEFAULT_QUESTS); dup.weekly[0].id = dup.daily[0].id; v = D.validateQuestConfig(dup); assert.equal(v.ok, false); assert.match(v.why, /duplicate/);
  const badq = structuredClone(D.DEFAULT_QUESTS); badq.daily[3].requirement = 'wat:1'; v = D.validateQuestConfig(badq); assert.match(v.why, /daily\[3\] "d_win".*requirement/);
  assert.equal(D.validateQuestConfig({ ...D.DEFAULT_QUESTS, dailyCount: 99 }).ok, false); assert.equal(D.setQuestConfig({ junk: 1 }), false);
  const ev = { id: 'ev1', title: 'EV', start: 1000, end: 2000, html: '<b>x</b>', quests: [q] };
  assert.equal(D.validateEvent(ev).ok, true); assert.equal(D.validateEvent({ ...ev, end: 1000 }).ok, false); assert.equal(D.validateEvent({ ...ev, html: 'x'.repeat(20001) }).ok, false);
  assert.equal(D.validateEvent({ ...ev, quests: new Array(21).fill(q) }).ok, false); assert.equal(D.validateEvent({ ...ev, quests: [q, q] }).ok, false, 'duplicate quest id');
  assert.equal(D.validateEvent({ ...ev, id: 'bad id' }).ok, false); assert.equal(D.setEvent({ id: 1 }), false); assert.equal(D.getEvent(), null);
  assert.equal(D.eventActive(ev, 1000), true); assert.equal(D.eventActive(ev, 2000), false); assert.equal(D.eventActive(ev, 999), false); assert.equal(D.eventActive(null, 1), false);
}
{ // periods (UTC)
  assert.equal(D.dailyKey(utc(2026, 10, 17, 23, 59)), '2026-11-17'); assert.equal(D.dailyKey(utc(2026, 10, 18)), '2026-11-18');
  assert.equal(D.nextDailyReset(utc(2026, 10, 17, 5)), utc(2026, 10, 18));
  assert.equal(D.weeklyKey(utc(2026, 0, 1)), '2026-W01'); assert.equal(D.weeklyKey(utc(2025, 11, 29)), '2026-W01', 'Monday of week 1 (in Dec)'); assert.equal(D.weeklyKey(utc(2025, 11, 28)), '2025-W52');
  assert.equal(D.weeklyKey(utc(2026, 11, 31)), '2026-W53'); assert.equal(D.weeklyKey(utc(2027, 0, 3, 23)), '2026-W53'); assert.equal(D.weeklyKey(utc(2027, 0, 4)), '2027-W01');
  assert.equal(D.weeklyKey(utc(2026, 10, 15, 23, 59)), '2026-W46'); assert.equal(D.weeklyKey(utc(2026, 10, 16)), '2026-W47'); // Monday 16 Nov 2026
  assert.equal(D.nextWeeklyReset(utc(2026, 10, 17)), utc(2026, 10, 23)); assert.equal(D.nextWeeklyReset(utc(2026, 10, 22, 23)), utc(2026, 10, 23));
  assert.equal(D.seasonKey(utc(2026, 0, 1), 2), 1); assert.equal(D.seasonKey(utc(2026, 1, 28, 23), 2), 1); assert.equal(D.seasonKey(utc(2026, 2, 1), 2), 2);
  assert.equal(D.seasonKey(utc(2026, 3, 30), 2), 2); assert.equal(D.seasonKey(utc(2026, 10, 17), 2), 6); assert.equal(D.seasonKey(utc(2027, 0, 1), 2), 7);
  assert.equal(D.seasonStart(utc(2026, 10, 17), 2), utc(2026, 10, 1)); assert.equal(D.seasonEnd(utc(2026, 10, 17), 2), utc(2027, 0, 1)); assert.equal(D.nextSeasonReset(utc(2026, 1, 1), 2), utc(2026, 2, 1));
  assert.ok(D.periodKey('daily', utc(2026, 10, 17)) < D.periodKey('daily', utc(2026, 10, 18))); assert.ok(D.periodKey('season', utc(2026, 10, 1)) < D.periodKey('season', utc(2027, 0, 1)));
}
{ // seeded picks: same for everybody, varying by day, unique
  const a = D.dailyQuests(utc(2026, 10, 17, 1)), b = D.dailyQuests(utc(2026, 10, 17, 22));
  assert.deepEqual(a.map((q) => q.id), b.map((q) => q.id)); assert.equal(a.length, 3); assert.equal(new Set(a.map((q) => q.id)).size, 3);
  const sets = new Set(); for (let i = 0; i < 10; i++) sets.add(D.dailyQuests(utc(2026, 10, 1 + i)).map((q) => q.id).join());
  assert.ok(sets.size > 3, 'different days pick differently'); assert.equal(D.weeklyQuests(utc(2026, 10, 17)).length, 2);
}

// ---- save: sanitized
{
  store.clear(); store.set(S.KEY, JSON.stringify({ quests: { daily: { key: '2026-11-17', p: { ok1: 5, 'bad id!': 3, big: 1e12, neg: -4, str: 'x' }, c: ['ok1', 'ok1', 5, 'bad id!'] }, event: { id: 7, p: [] }, junk: 1 } }));
  const d = S.loadSave();
  assert.deepEqual(d.quests.daily, { key: '2026-11-17', p: { ok1: 5, big: 100000, neg: 0 }, c: ['ok1'] }); assert.deepEqual(d.quests.event, { id: '', p: {}, c: [] }); assert.deepEqual(d.quests.season, { key: '', p: {}, c: [] });
  assert.equal(d.quests.junk, undefined);
}

// ---- tracking / claiming with a small controlled config
const NOW = utc(2026, 10, 17, 12);
const mk = (id, requirement, reward) => ({ id, title: id.toUpperCase(), body: '', requirement, reward });
const cfg = { ...structuredClone(D.DEFAULT_QUESTS), dailyCount: 3, weeklyCount: 2,
  daily: [mk('dk', 'kill:3', 'coins:100'), mk('de', 'early_kill(30):1', 'xp:500'), mk('dd', 'early_death(10):2', 'rare_drop:1,common_drop:1')],
  weekly: [mk('ww', 'win:1', `powerup(${pid}):5`), mk('wk', 'kill:5', 'epic_drop:1')] };
assert.equal(D.setQuestConfig(cfg), true);
{
  const d = fresh(); let v = Q.questsView(NOW);
  assert.deepEqual([v.daily.length, v.weekly.length, v.season.length, v.event], [3, 2, 10, null]);
  assert.deepEqual(v.resets, { daily: utc(2026, 10, 18), weekly: utc(2026, 10, 23), season: utc(2027, 0, 1) });
  assert.equal(v.daily.find((x) => x.quest.id === 'dk').key, 'd:2026-11-17:dk'); assert.ok(v.weekly[0].key.startsWith('w:2026-W47:')); assert.ok(v.season[0].key.startsWith('s:006:'));
  assert.deepEqual(Q.track('kill', 1, null, NOW), []);
  let done = Q.track('kill', 2, null, NOW);
  assert.deepEqual(done.map((x) => x.quest.id), ['dk']); assert.equal(done[0].done, true);
  assert.equal(Q.track('kill', 1, null, NOW).length, 0, 'no second completion'); v = Q.questsView(NOW);
  assert.equal(v.daily.find((x) => x.quest.id === 'dk').progress, 3, 'capped at count');
  assert.equal(v.weekly.find((x) => x.quest.id === 'wk').progress, 4, 'weekly kill quest counts too');
  // early_kill(30): counts when seconds <= 30
  assert.deepEqual(Q.track('early_kill', 1, 31, NOW), []); assert.deepEqual(Q.track('early_kill', 1, null, NOW), []);
  assert.deepEqual(Q.track('early_kill', 1, 30, NOW).map((x) => x.quest.id), ['de']);
  // early_death(10):2
  Q.track('early_death', 1, 11, NOW); Q.track('early_death', 1, 3, NOW); assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 'dd').progress, 1);
  assert.deepEqual(Q.track('early_death', 1, 10, NOW).map((x) => x.quest.id), ['dd']);
  assert.deepEqual(Q.track('kill', 0, null, NOW), []); assert.deepEqual(Q.track('kill', -3, null, NOW), []); assert.deepEqual(Q.track('nope', 1, null, NOW), []);

  // claim: coins
  const c0 = d.coins;
  assert.deepEqual(Q.claim('d:2026-11-17:nope', { now: NOW }), { ok: false, reason: 'unknown', rewards: [] });
  assert.equal(Q.claim('w:2026-W47:ww', { now: NOW }).reason, 'notDone');
  let r = Q.claim('d:2026-11-17:dk', { rng, now: NOW });
  assert.deepEqual([r.ok, r.rewards, d.coins], [true, [{ type: 'coins', amount: 100 }], c0 + 100]);
  r = Q.claim('d:2026-11-17:dk', { rng, now: NOW }); assert.deepEqual([r.ok, r.reason], [false, 'claimed']); assert.equal(d.coins, c0 + 100, 'no double pay');
  assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 'dk').claimed, true);
  // claim: xp (+ level up path)
  const x0 = d.xp; r = Q.claim('d:2026-11-17:de', { rng, now: NOW }); assert.equal(r.rewards[0].type, 'xp'); assert.equal(d.xp, x0 + 500);
  d.xp = 9900; const lv = d.level; r = Q.claim('d:2026-11-17:de', { rng, now: NOW }); assert.equal(r.ok, false);
  // claim: two drops of forced tiers
  const before = d.coins; r = Q.claim('d:2026-11-17:dd', { rng, now: NOW });
  assert.deepEqual(r.rewards.map((x) => [x.type, x.drop.tier]), [['rare_drop', 'rare'], ['common_drop', 'common']]);
  assert.ok(d.coins > before || Object.keys(d.unlocks.abilityCount).length > 0, 'drops were applied');
  // claim: power-up charges, capped at STACK_MAX with half-price coins for the rest
  Q.track('win', 1, null, NOW); d.unlocks.abilityCount[pid] = 97; d.unlocks.abilities.includes(pid) || d.unlocks.abilities.push(pid); const c1 = d.coins;
  r = Q.claim('w:2026-W47:ww', { rng, now: NOW });
  assert.deepEqual([r.ok, r.rewards[0].id, d.unlocks.abilityCount[pid], d.coins - c1], [true, pid, 99, Math.floor(3 * ABILITIES[pid].price / 2)]);
  // xp reward that levels up pays level coins
  const d2 = fresh(); Q.track('kill', 3, null, NOW); d2.xp = 9900; d2.level = 1;
  D.setQuestConfig({ ...cfg, daily: [mk('dk', 'kill:3', 'xp:500'), cfg.daily[1], cfg.daily[2]] });
  r = Q.claim('d:2026-11-17:dk', { rng, now: NOW }); assert.equal(r.rewards[0].levelsUp.length, 1); assert.equal(d2.level, 2); assert.ok(d2.coins >= 200);
  D.setQuestConfig(cfg);
}
{ // period rollover: a new day resets dailies (not weeklies / season); a new week resets weeklies; a new season resets the season
  const d = fresh(); Q.track('kill', 3, null, NOW);
  const next = NOW + 864e5; // Wed 18 Nov, same week + season
  let v = Q.questsView(next);
  assert.equal(v.daily.find((x) => x.quest.id === 'dk').progress, 0); assert.equal(v.weekly.find((x) => x.quest.id === 'wk').progress, 3, 'week kept'); assert.equal(d.quests.daily.key, '2026-11-18');
  assert.equal(Q.track('kill', 1, null, next).length, 0);
  v = Q.questsView(utc(2026, 10, 24)); assert.equal(v.weekly.find((x) => x.quest.id === 'wk').progress, 0); assert.equal(d.quests.weekly.key, '2026-W48');
  const sq = D.getQuestConfig().season[0], sreq = D.parseRequirement(sq.requirement); // season: track any quest of it
  Q.track(sreq.id, 1, sreq.param === null ? null : 1, NOW); assert.equal(Q.questsView(NOW).season[0].progress, 1);
  assert.equal(Q.questsView(utc(2027, 0, 2)).season[0].progress, 0, 'new season'); assert.equal(d.quests.season.key, '007');
  assert.equal(Q.claim('d:2026-11-17:dk', { now: utc(2026, 10, 18) }).reason, 'unknown', 'yesterday key is gone');
}
{ // cloud merge
  const a = { daily: { key: '2026-11-17', p: { x: 2, y: 5 }, c: ['x'] }, weekly: { key: '2026-W47', p: {}, c: [] }, season: { key: '006', p: { s: 9 }, c: [] }, event: { id: 'e1', p: { q: 1 }, c: [] } };
  const b = { daily: { key: '2026-11-17', p: { x: 4, z: 1 }, c: ['y'] }, weekly: { key: '2026-W46', p: { w: 9 }, c: ['w'] }, season: { key: '005', p: { s: 99 }, c: ['s'] }, event: { id: 'e2', p: { q: 7 }, c: [] } };
  let m = D.mergeQuests(a, b, true);
  assert.deepEqual(m.daily, { key: '2026-11-17', p: { x: 4, y: 5, z: 1 }, c: ['x', 'y'] }); assert.deepEqual(m.weekly, a.weekly, 'newer week wins'); assert.deepEqual(m.season, a.season, 'newer season wins'); assert.deepEqual(m.event, a.event);
  m = D.mergeQuests(a, b, false); assert.deepEqual(m.event, b.event, 'other event: the newer save wins');
  m = D.mergeQuests(b, a, false); assert.deepEqual(m.weekly, a.weekly); assert.deepEqual(m.daily.c.sort(), ['x', 'y']);
  assert.deepEqual(D.mergeQuests(undefined, null), D.emptyQuestsSave());
  const l = S.progressOf(S.parseSave(null)), c = S.progressOf(S.parseSave(null)); l.quests = a; c.quests = b; c.updatedAt = 5;
  assert.deepEqual(mergeProgress(l, c).quests.daily.p, { x: 4, y: 5, z: 1 }); assert.equal(mergeProgress(l, c).quests.event.id, 'e2', 'cloud is newer');
  const d = fresh(); d.quests.daily = { key: '2026-11-17', p: { dk: 2 }, c: [] }; S.flushSave();
  const applied = S.applyProgress({ ...S.progressOf(S.parseSave(null)), quests: a }, 'u1'); assert.equal(applied.quests.season.p.s, 9, 'applyProgress carries quests');
  assert.ok(JSON.stringify(S.progressOf(S.getSave())).includes('"quests"'));
}
{ // events: active only inside the window; their quests track + claim
  const d = fresh(), ev = { id: 'ev1', title: 'EVENT', start: NOW - 1000, end: NOW + 1000, html: '<p>hi</p>', quests: [mk('e_play', 'multiplayer_game_completed:1', 'coins:50'), mk('e_kill', 'kill:2', 'legendary_drop:1')] };
  assert.equal(D.setEvent(ev), true);
  let v = Q.questsView(NOW); assert.deepEqual([v.event.id, v.event.title, v.event.html, v.event.quests.length], ['ev1', 'EVENT', '<p>hi</p>', 2]);
  assert.equal(v.event.quests[0].key, 'e:ev1:e_play');
  assert.deepEqual(Q.track('multiplayer_game_completed', 1, null, NOW).map((x) => x.quest.id), ['e_play']);
  const c0 = d.coins; assert.equal(Q.claim('e:ev1:e_play', { now: NOW }).ok, true); assert.equal(d.coins, c0 + 50);
  Q.track('kill', 2, null, NOW); const r = Q.claim('e:ev1:e_kill', { rng, now: NOW }); assert.equal(r.rewards[0].drop.tier === 'legendary' || r.rewards[0].drop.tier === 'unlimited', true);
  assert.equal(Q.questsView(NOW + 5000).event, null, 'ended'); assert.equal(Q.questsView(NOW - 5000).event, null, 'not started');
  assert.deepEqual(Q.track('multiplayer_game_completed', 1, null, NOW + 5000), []);
  assert.equal(d.quests.event.id, 'ev1', 'progress kept until another event runs');
  D.setEvent({ ...ev, id: 'ev2' }); v = Q.questsView(NOW); assert.equal(v.event.quests[0].progress, 0, 'new event starts empty'); assert.equal(d.quests.event.id, 'ev2');
  D.setEvent(null); assert.equal(Q.questsView(NOW).event, null);
}
{ // questtrack: double / triple kill, early / death, distance, match end
  D.setQuestConfig({ ...cfg, daily: [mk('t_dbl', 'double_kill:1', 'coins:1'), mk('t_tri', 'triple_kill:1', 'coins:1'), mk('t_ek', 'early_kill(5):2', 'coins:1')], weekly: [mk('t_dist', 'distance:100', 'coins:1'), mk('t_mp', 'multiplayer_win:1', 'coins:1')] });
  const real = Date.now; Date.now = () => NOW; // questtrack tracks "now"
  try {
    fresh(); T.begin();
    T.kill(10); T.kill(14); // 4 s apart: neither
    assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 't_dbl').progress, 0);
    T.kill(16); // 14 -> 16 = 2 s: double (kills at 14 and 16; 10 is 6 s back)
    assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 't_dbl').progress, 1);
    assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 't_tri').progress, 0);
    T.kill(17.5); assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 't_tri').progress, 1, 'third kill within 5 s (16-17.5 + 14)');
    T.kill(18); assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 't_tri').progress, 1, 'a 4th kill is not another triple');
    T.begin(); T.kill(2); T.kill(4); // early_kill(5) x2
    assert.equal(Q.questsView(NOW).daily.find((x) => x.quest.id === 't_ek').progress, 2);
    T.kill(1); // runTime restarted (new round): old stamps forgotten
    T.addDistance(60.6); T.addDistance(60); T.roundWon(); T.used('boost_used'); T.death(3);
    const done = T.matchEnd({ online: true, rank: 1, deathmatch: false });
    assert.deepEqual(done.map((x) => x.quest.id).sort(), ['t_dist', 't_ek', 't_mp'], 'completed list holds every quest finished since begin()');
    assert.deepEqual(T.matchEnd({ online: false, rank: 2, deathmatch: false }).map((x) => x.quest.id), [], 'list is consumed');
  } finally { Date.now = real; D.setQuestConfig(cfg); }
}
console.log('quests tests passed');
