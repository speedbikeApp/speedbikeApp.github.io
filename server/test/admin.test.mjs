// Admin foundation + PLAYERS ops end to end (dev-auth server on a random port, in-memory stores).
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';
import { createJsonAdminStore } from '../admin-store.js';
import { createLoginHandler } from '../login.js';
import { banActive, parseAdminNames } from '../admin.js';

const guard = setTimeout(() => { console.error('admin test timed out'); process.exit(1); }, 60000);
const social = createJsonSocialStore(null), ranks = createJsonStore('/nonexistent-dir-sb/ranks.json'), adminStore = createJsonAdminStore(null, social);
const app = createGameServer({ auth: createDevAuth(), store: ranks, social, admin: adminStore, adminUsernames: ' boss , Other ', log: () => {} });
const port = await app.listen(0);
app.admin.register('echo', async (a) => ({ got: a.x })); // another module plugging in

function client(uid, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, uid, msgs: [], waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.next = (test, ms = 5000) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${uid} timed out waiting for ${test}`)), ms);
    c.waiters.push({ test: typeof test === 'function' ? test : (m) => m.t === test, resolve: (m) => { clearTimeout(to); resolve(m); } });
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.closed = new Promise((r) => ws.on('close', (code) => r(code)));
  c.hello = async () => { await c.open; const w = c.next((m) => m.t === 'welcome' || m.t === 'banned'); c.send({ t: 'hello', dev: true, uid, username }); return w; };
  let n = 0;
  c.op = async (op, a = {}) => { await new Promise((ok) => setTimeout(ok, 60)); const id = ++n, r = c.next((m) => m.t === 'ares' && m.id === id); c.send({ t: 'admin', op, id, a }); return r; };
  return c;
}

const boss = client('uBoss', 'Boss'), alice = client('uAlice', 'Alice'), bob = client('uBob', 'Bobby'), mod = client('uMod', 'Modder');
assert.equal((await boss.hello()).admin, true, 'bootstrap admin via ADMIN_USERNAMES (case-insensitive, trimmed)');
assert.equal((await alice.hello()).admin, false);
assert.equal((await bob.hello()).admin, false, 'welcome carries admin:false');
await mod.hello();
assert.deepEqual([...parseAdminNames('A, b ,,')], ['a', 'b']);

// ---- non-admin is refused every admin action (and nothing changes)
for (const [op, a] of [['psearch', { q: 'bo' }], ['plist', {}], ['pget', { uid: 'uBob' }], ['pban', { uid: 'uBob', permanent: true }], ['punban', { uid: 'uBob' }], ['padmin', { uid: 'uAlice', on: true }],
  ['prename', { uid: 'uBob', username: 'Hacked' }], ['ppassword', { uid: 'uBoss', password: 'takeover123' }], ['pedit', { uid: 'uAlice', coins: 99999 }], ['pdelete', { uid: 'uBob', confirm: 'Bobby' }], ['echo', { x: 1 }], ['nonexistent', {}]]) {
  const r = await alice.op(op, a);
  assert.deepEqual([r.ok, r.code], [false, 'forbidden'], op);
}
assert.equal(await adminStore.isAdmin('uAlice'), false); assert.equal(await adminStore.getBan('uBob'), null); assert.equal(await adminStore.getProgress('uAlice'), null);
assert.equal((await boss.op('nonexistent')).code, 'unknown_op');
assert.equal((await boss.op('echo', { x: 7 })).got, 7, 'registered op runs for admins');
assert.equal((await boss.op('psearch', { q: 'x' })).code, 'bad_query');

// ---- plist: alphabetical, paged, limit-capped
const pl = await boss.op('plist', {});
const all = pl.players.map((p) => p.username); assert.ok(all.length >= 3 && !pl.next);
assert.deepEqual(all, [...all].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), 'sorted by username');
assert.equal(pl.players.find((p) => p.username === 'Boss').admin, true);
const p1 = await boss.op('plist', { limit: 2 }), p2 = await boss.op('plist', { limit: 2, after: p1.next });
assert.equal(p1.players.length, 2); assert.ok(p1.next); assert.deepEqual([...p1.players, ...p2.players].map((p) => p.username).slice(0, all.length), all.slice(0, p1.players.length + p2.players.length));
assert.equal((await boss.op('plist', { limit: 9999 })).players.length, all.length, 'limit capped at 50');
assert.equal((await boss.op('plist', { after: 5 })).code, 'bad_query');

// ---- search + get
const sr = await boss.op('psearch', { q: 'bo' });
assert.deepEqual(sr.results.map((r) => [r.username, r.online, r.admin]).sort(), [['Bobby', true, false], ['Boss', true, true]]);
const g = await boss.op('pget', { uid: 'uBob' });
assert.equal(g.player.username, 'Bobby'); assert.equal(g.player.progress.coins, 0); assert.equal(g.player.rank.tier, 'He'); assert.equal(g.player.ban, null);
assert.equal((await boss.op('pget', { uid: 'nobody' })).code, 'not_found');

// ---- ban: timed. Connected player is kicked with the remaining time; reconnect + queue are refused
const bobClosed = bob.closed, bobBanned = bob.next('banned');
let r = await boss.op('pban', { uid: 'uBob', minutes: 10, reason: 'rude' });
assert.equal(r.ok, true);
const bm = await bobBanned;
assert.ok(bm.until > Date.now() + 9 * 60000 && bm.until < Date.now() + 11 * 60000 && !bm.permanent && bm.reason === 'rude');
assert.equal(await bobClosed, 4003);
let bob2 = client('uBob', 'Bobby'); let m2 = await bob2.hello();
assert.equal(m2.t, 'banned'); assert.equal(m2.permanent, false); await bob2.closed;
assert.equal(banActive(await adminStore.getBan('uBob')), true);
assert.equal((await boss.op('pget', { uid: 'uBob' })).player.ban.permanent, false);
// expiry: a ban in the past no longer refuses
await adminStore.setBan('uBob', { until: Date.now() - 1000, by: 'x' });
bob2 = client('uBob', 'Bobby'); assert.equal((await bob2.hello()).t, 'welcome');
assert.equal((await boss.op('pget', { uid: 'uBob' })).player.ban, null, 'expired ban is not shown');
// queue refusal for an already-connected session whose ban is known
const sess = [...app.sessions].find((s) => s.uid === 'uBob'); sess.ban = { until: null };
const bobBan2 = bob2.next('banned'); bob2.send({ t: 'queue', mode: 'standard' });
assert.equal((await bobBan2).permanent, true); await bob2.closed;
// permanent ban + unban
r = await boss.op('pban', { uid: 'uBob', permanent: true }); assert.equal(r.ok, true);
let bob3 = client('uBob', 'Bobby'); m2 = await bob3.hello(); assert.deepEqual([m2.t, m2.permanent, m2.until], ['banned', true, null]); await bob3.closed;
// login endpoint refuses banned accounts (only after the right password)
{
  const handler = createLoginHandler({ enabled: true, allowedOrigins: [], production: false, minFailMs: 0, sleep: async () => {},
    lookup: async () => ({ uid: 'uBob', email: 'b@x.y' }), verifyPassword: async (e, pw) => (pw === 'right-password' ? { ok: true } : { ok: false, code: 'invalid' }),
    createToken: async (uid) => 'tok-' + uid, banOf: (uid) => app.admin.activeBan(uid) });
  const srv = http.createServer((q, s) => handler(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const post = async (password) => { const x = await fetch(`http://127.0.0.1:${srv.address().port}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '9.9.' + Math.floor(Math.random() * 250) + '.1' }, body: JSON.stringify({ username: 'Bobby', password }) }); return [x.status, await x.json()]; };
  let [st, body] = await post('right-password'); assert.equal(st, 403); assert.deepEqual([body.code, body.permanent], ['banned', true]);
  [st, body] = await post('wrong-password'); assert.equal(st, 401, 'wrong password does not reveal the ban');
  await boss.op('punban', { uid: 'uBob' });
  [st, body] = await post('right-password'); assert.equal(st, 200); assert.equal(body.token, 'tok-uBob');
  await new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); });
}
assert.equal(await adminStore.getBan('uBob'), null, 'unban');
assert.equal((await boss.op('pban', { uid: 'uBoss', permanent: true })).code, 'protected', 'cannot ban yourself / a bootstrap admin');
assert.equal((await boss.op('pban', { uid: 'uAlice', minutes: 0 })).code, 'bad_minutes');
bob3 = client('uBob', 'Bobby'); assert.equal((await bob3.hello()).t, 'welcome');

// ---- make / remove admin
const modAdm = mod.next((m) => m.t === 'adminstate' && m.admin === true);
assert.equal((await boss.op('padmin', { uid: 'uMod', on: true })).ok, true); await modAdm;
assert.equal((await mod.op('psearch', { q: 'al' })).results[0].username, 'Alice', 'new admin can use the panel without reconnecting');
assert.equal((await mod.op('padmin', { uid: 'uMod', on: false })).code, 'protected', 'cannot remove yourself');
assert.equal((await mod.op('padmin', { uid: 'uBoss', on: false })).code, 'protected', 'bootstrap admins cannot be demoted');
assert.equal((await boss.op('padmin', { uid: 'uBoss', on: false })).code, 'protected');
const modGone = mod.next((m) => m.t === 'adminstate' && m.admin === false);
assert.equal((await boss.op('padmin', { uid: 'uMod', on: false })).ok, true); await modGone;
assert.equal((await mod.op('psearch', { q: 'al' })).code, 'forbidden', 'demoted admin is refused at once');
assert.equal((await boss.op('pget', { uid: 'uMod' })).player.admin, false);

// ---- rename keeps the reservation consistent
const hasName = async (n) => (await social.findByPrefix(n.toLowerCase(), 20)).some((u) => u.username.toLowerCase() === n.toLowerCase());
assert.equal((await boss.op('prename', { uid: 'uAlice', username: 'bobby' })).code, 'taken', 'taken names are rejected (case-insensitive)');
assert.equal((await boss.op('prename', { uid: 'uAlice', username: 'x' })).code, 'bad_name');
assert.equal((await boss.op('prename', { uid: 'uAlice', username: 'bad!name' })).code, 'bad_name');
const resync = alice.next('resync');
r = await boss.op('prename', { uid: 'uAlice', username: '  Alicia   B ' });
assert.deepEqual([r.ok, r.username], [true, 'Alicia B']); assert.equal((await resync).username, 'Alicia B');
assert.equal(await hasName('Alicia B'), true); assert.equal(await hasName('Alice'), false, 'old name is free again');
assert.equal((await boss.op('prename', { uid: 'uBob', username: 'alicia b' })).code, 'taken');
assert.equal((await boss.op('prename', { uid: 'uAlice', username: 'ALICIA B' })).ok, true, 'case-only change of own name is fine');
assert.equal([...app.sessions].find((s) => s.uid === 'uAlice').username, 'ALICIA B');

// ---- change password: length-checked, never another admin's, the store gets the new password
const pwSet = []; adminStore.setPassword = async (uid, pw) => { pwSet.push([uid, pw]); };
assert.equal((await boss.op('ppassword', { uid: 'uMod', password: 'short' })).code, 'bad_password');
assert.equal((await boss.op('ppassword', { uid: 'uMod', password: 'x'.repeat(129) })).code, 'bad_password');
await adminStore.setAdmin('uMod', true, 'uBoss');
assert.equal((await boss.op('ppassword', { uid: 'uMod', password: 'longenough1' })).code, 'protected', 'other admins are off limits');
await adminStore.setAdmin('uMod', false);
assert.equal((await boss.op('ppassword', { uid: 'uMod', password: 'longenough1' })).ok, true);
assert.equal((await boss.op('ppassword', { uid: 'uBoss', password: 'myownpass1' })).ok, true, 'own password is fine');
assert.deepEqual(pwSet, [['uMod', 'longenough1'], ['uBoss', 'myownpass1']]);

// ---- edit coins / stats bumps updatedAt
await adminStore.setProgress('uAlice', { coins: 5, updatedAt: Date.now() + 5000, stats: { wins: 3 } });
const before = (await adminStore.getProgress('uAlice')).updatedAt;
const rs = alice.next((m) => m.t === 'resync' && m.force);
r = await boss.op('pedit', { uid: 'uAlice', coins: 1234, stats: { wins: 40, kills: 7 } });
assert.equal(r.ok, true); await rs;
const p = await adminStore.getProgress('uAlice');
assert.equal(p.coins, 1234); assert.equal(p.stats.wins, 40); assert.equal(p.stats.kills, 7); assert.ok(p.updatedAt > before, 'updatedAt bumped past the (even future) client save');
assert.equal((await boss.op('pedit', { uid: 'uAlice', coins: -1 })).code, 'bad_value');
assert.equal((await boss.op('pedit', { uid: 'uAlice', stats: { hax: 1 } })).code, 'bad_value');
assert.equal((await boss.op('pedit', { uid: 'uAlice', coins: 'lots' })).code, 'bad_value');
const g2 = await boss.op('pget', { uid: 'uAlice' }); assert.deepEqual([g2.player.progress.coins, g2.player.progress.stats.wins], [1234, 40]);

// ---- delete account removes everything
await social.update(['uAlice', 'uBob'], (m) => { m.get('uAlice').friends.push('uBob'); m.get('uBob').friends.push('uAlice'); return { ok: true }; });
await ranks.setRank('uBob', { tier: 'Ne', div: 2, wins: 1, matches: 4, totalWins: 3, updatedAt: 1 }, 'Bobby');
await adminStore.setAdmin('uBob', true); await adminStore.setBan('uBob', { until: Date.now() + 99999, by: 'x' }); await adminStore.setProgress('uBob', { coins: 1 });
assert.equal((await boss.op('pdelete', { uid: 'uBob', confirm: 'nope' })).code, 'confirm_mismatch');
assert.equal((await boss.op('pdelete', { uid: 'uBoss', confirm: 'Boss' })).code, 'protected');
assert.ok((await social.getUsers(['uBob'])).get('uBob'));
const gone = bob3.next((m) => m.t === 'error' && m.code === 'deleted');
r = await boss.op('pdelete', { uid: 'uBob', confirm: 'bobby' }); assert.equal(r.ok, true); await gone;
assert.equal((await social.getUsers(['uBob'])).get('uBob'), null, 'user/username entry gone');
assert.deepEqual(await social.getLinks('uBob'), { friends: [], incoming: [], outgoing: [] });
assert.deepEqual((await social.getLinks('uAlice')).friends, [], 'removed from the friend list of others');
assert.equal(await adminStore.getProgress('uBob'), null); assert.equal(await adminStore.getBan('uBob'), null); assert.equal(await adminStore.isAdmin('uBob'), false);
assert.equal((await ranks.getRank('uBob')).totalWins, 0, 'rank record deleted');
assert.equal((await boss.op('pget', { uid: 'uBob' })).code, 'not_found');

clearTimeout(guard);
for (const c of [boss, alice, mod, bob3]) c.ws.terminate();
await app.close();
console.log('admin tests passed');
