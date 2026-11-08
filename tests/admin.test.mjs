// Client admin plumbing (js/admin-core.js): admin flag, tab registry order, request/response caller, ban text; plus: an admin edit (newer updatedAt) wins coins in mergeProgress.
import assert from 'node:assert/strict';
import { isAdmin, setAdmin, onAdminChange, registerAdminTab, hasAdminTab, adminTabs, createCaller, banMessage } from '../js/admin-core.js';
import { mergeProgress } from '../js/cloudsave.js';
import { parseSave, progressOf } from '../js/save.js';

let seen = []; onAdminChange((v) => seen.push(v));
assert.equal(isAdmin(), false);
setAdmin('yes'); assert.equal(isAdmin(), false, 'only a real true counts');
setAdmin(true); setAdmin(true); setAdmin(false);
assert.deepEqual(seen, [true, false], 'listeners fire on change only');

const mount = () => {};
registerAdminTab('garage', 'GARAGE', mount); registerAdminTab('extra', 'EXTRA', mount); registerAdminTab('players', 'PLAYERS', mount); registerAdminTab('maps', 'MAPS', mount);
assert.deepEqual(adminTabs().map((t) => t.id), ['players', 'maps', 'garage', 'extra']);
const real = () => 'real'; registerAdminTab('maps', 'MAPS', real);
assert.equal(adminTabs()[1].mount, real, 'registering an existing id replaces the placeholder'); assert.equal(hasAdminTab('maps'), true);

{ // caller: answers match by id; timeouts and offline resolve (never reject)
  const sent = []; let ok = true; const timers = [];
  const c = createCaller((m) => { sent.push(m); return ok; }, { setT: (f) => { timers.push(f); return timers.length; }, clearT: () => {} });
  const p1 = c.call('psearch', { q: 'ab' }), p2 = c.call('pget', { uid: 'u' });
  assert.deepEqual(sent.map((m) => [m.t, m.op, m.id]), [['admin', 'psearch', 1], ['admin', 'pget', 2]]);
  c.resolve({ t: 'ares', id: 2, ok: true, player: 1 }); c.resolve({ t: 'ares', id: 1, ok: false, code: 'forbidden' }); c.resolve({ id: 99 });
  assert.equal((await p2).player, 1); assert.equal((await p1).code, 'forbidden');
  const p3 = c.call('x'); timers[2](); assert.equal((await p3).code, 'timeout');
  ok = false; assert.equal((await c.call('x')).code, 'offline');
}

assert.equal(banMessage({ permanent: true, until: null }), 'You are banned permanently');
assert.match(banMessage({ permanent: false, until: Date.now() + 60000, reason: 'rude' }), /^You are banned until \d{4}-\d\d-\d\d \d\d:\d\d \(rude\)$/);

{ // admin edit: coins follow the newer updatedAt, stats are max()'d (lowering stats needs the forced resync)
  const local = progressOf(parseSave(null)); local.coins = 500; local.updatedAt = 1000; local.stats.wins = 9;
  const cloud = progressOf(parseSave(null)); cloud.coins = 100; cloud.updatedAt = 2000; cloud.stats.wins = 3;
  const m = mergeProgress(local, cloud);
  assert.equal(m.coins, 100); assert.equal(m.stats.wins, 9);
}
console.log('admin tests passed');
