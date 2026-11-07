import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const S = await import('../js/save.js');
const A = await import('../js/auth.js');
const C = await import('../js/cloudsave.js');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---- pure merge ----
{
  const a = S.progressOf(S.parseSave(JSON.stringify({ coins: 500, updatedAt: 100, stats: { wins: 5, kills: 10, winStreak: 4, distance: 50 },
    unlocks: { abilities: ['turbo'], parts: { body: ['armored'] }, achievements: [] }, equipped: { abilities: ['turbo'], parts: { body: 'armored' } } })));
  const b = S.progressOf(S.parseSave(JSON.stringify({ coins: 20, updatedAt: 200, stats: { wins: 3, kills: 40, winStreak: 1, distance: 10 },
    unlocks: { abilities: ['stealth'], parts: { body: ['frame'] }, achievements: [] }, equipped: { abilities: ['stealth'], parts: { body: 'frame' } } })));
  const m = C.mergeProgress(a, b);
  assert.equal(m.coins, 20, 'coins from the newer save'); assert.equal(m.updatedAt, 200);
  assert.equal(m.stats.wins, 5); assert.equal(m.stats.kills, 40); assert.equal(m.stats.distance, 50); assert.equal(m.stats.winStreak, 1);
  assert.ok(m.unlocks.abilities.includes('turbo') && m.unlocks.abilities.includes('stealth'));
  assert.ok(m.unlocks.parts.body.includes('armored') && m.unlocks.parts.body.includes('frame'));
  assert.deepEqual(m.equipped.abilities, ['stealth']);
  assert.equal(C.mergeProgress(b, a).coins, 20, 'symmetric');
  // resolveProgress: no cloud -> local; junk cloud values are sanitized
  const loc = S.parseSave(JSON.stringify({ coins: 7, cloudUid: 'u1' }));
  assert.equal(C.resolveProgress(loc, null, 'u1').coins, 7);
  assert.equal(C.resolveProgress(loc, { coins: -5, stats: 'x', unlocks: { abilities: ['nope'] } }, 'u1').coins, 7);
  // other account's local save is replaced by the cloud, never merged
  const cloud = { ...b, stats: { ...b.stats, wins: 1 } };
  const r = C.resolveProgress(S.parseSave(JSON.stringify({ coins: 9999, updatedAt: 999, stats: { wins: 50 }, cloudUid: 'other' })), cloud, 'u1');
  assert.equal(r.coins, 20); assert.equal(r.stats.wins, 1);
  // guest save (no cloudUid) merges
  assert.equal(C.resolveProgress(S.parseSave(JSON.stringify({ coins: 9999, updatedAt: 999, stats: { wins: 50 } })), cloud, 'u1').stats.wins, 50);
  assert.equal(C.resolveProgress(S.parseSave(JSON.stringify({ coins: 9999, updatedAt: 999, stats: { wins: 50 }, cloudUid: 'other' })), null, 'u2').coins, S.defaults().coins); // empty new account never inherits another account's progress
}

// ---- end to end with the mock backend ----
await A.init({ backend: 'mock' });
C.initCloudSave();
let applied = 0; C.setOnApplied(() => applied++);
A.onAuthChange((u) => C.cloudUserChanged(u));
S.loadSave();
{ // guest progress is uploaded when the account has none
  S.getSave().coins = 120; S.getSave().stats.wins = 2; S.flushSave();
  await A.register('a@example.com', 'password1', 'Ann'); await wait();
  assert.equal(S.getSave().cloudUid, A.currentUser().uid);
  assert.equal((await A.loadProgress()).coins, 120);
  // later saves push after a debounce
  S.getSave().coins = 150; S.saveSoon(1); await wait(); assert.equal((await A.loadProgress()).coins, 120, 'debounced');
  await C.flushCloud(); assert.equal((await A.loadProgress()).coins, 150);
  // settings do not sync
  S.getSave().settings.masterVol = 0.1; S.flushSave(); await C.flushCloud();
  assert.ok(!('settings' in (await A.loadProgress())));
}
const uidA = A.currentUser().uid;
{ // sign out keeps the local copy
  await C.flushCloud(); await A.logout(); await wait();
  assert.equal(S.getSave().coins, 150); assert.equal(S.getSave().cloudUid, uidA);
}
{ // different account: cloud of B replaces local, A's progress is not merged into B
  await A.register('b@example.com', 'password1', 'Bob'); await wait();
  const uidB = A.currentUser().uid;
  // B was empty -> local (A's) uploaded per the empty-cloud rule; now make B diverge and come back
  S.getSave().coins = 5; S.getSave().stats.wins = 0; S.flushSave(); await C.flushCloud();
  await A.logout(); await wait();
  await A.login('a@example.com', 'password1'); await wait();
  assert.equal(S.getSave().cloudUid, uidA);
  assert.equal(S.getSave().coins, 150, 'account A gets its own cloud progress back (no mixing with B)');
  assert.equal(S.getSave().stats.wins, 2);
  assert.ok(applied > 0);
  await A.logout(); await wait();
  await A.login('b@example.com', 'password1'); await wait();
  assert.equal(S.getSave().cloudUid, uidB); assert.equal(S.getSave().coins, 5);
  assert.notEqual(uidA, uidB);
}
{ // sign-in as the same account on a 'second device' (fresh local save) gets the cloud progress
  await A.logout(); await wait();
  mem.delete(S.KEY); S.loadSave();
  await A.login('b@example.com', 'password1'); await wait();
  assert.equal(S.getSave().coins, 5);
}
console.log('cloudsave tests passed');
