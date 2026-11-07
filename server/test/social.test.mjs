// Social logic (server/social.js) on the in-memory store with fake presence: requests, accept/decline/cancel/remove, limits, auto-accept, search, ghosts.
import assert from 'node:assert/strict';
import { Social, LIMITS } from '../social.js';
import { createJsonSocialStore } from '../social-store.js';
import { normalizeQuery, parseClientMessage } from '../protocol.js';

const store = createJsonSocialStore(null);
const online = new Set(), inbox = new Map(), liveRanks = new Map();
const sent = (uid) => inbox.get(uid) || [];
const social = new Social({
  store, getRank: async () => ({ tier: 'He', div: 3, wins: 0 }), liveRank: (u) => liveRanks.get(u), isOnline: (u) => online.has(u),
  send: (u, m) => { if (!inbox.has(u)) inbox.set(u, []); inbox.get(u).push(m); },
});
for (const [uid, name] of [['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol'], ['al2', 'Alfred']]) await store.noteUser(uid, name);
const links = (u) => store.getLinks(u);

// ---- request / accept ----
assert.deepEqual(await social.request('a', 'a'), { ok: false, code: 'self' });
assert.deepEqual(await social.request('a', 'zz'), { ok: false, code: 'not_found' });
online.add('b');
let r = await social.request('a', 'b');
assert.deepEqual(r, { ok: true, state: 'sent' });
assert.deepEqual((await links('a')).outgoing, ['b']); assert.deepEqual((await links('b')).incoming, ['a']);
assert.ok(sent('b').some((m) => m.t === 'fevent' && m.kind === 'request' && m.username === 'Alice'), 'receiver gets a request event');
assert.ok(sent('b').some((m) => m.t === 'friends' && m.incoming.length === 1 && m.incoming[0].username === 'Alice'), 'receiver snapshot shows the request');
assert.equal((await social.request('a', 'b')).code, 'already_sent');
assert.equal((await social.accept('a', 'b')).code, 'no_request', 'sender cannot accept their own request');
r = await social.accept('b', 'a');
assert.deepEqual(r, { ok: true, state: 'friends' });
assert.deepEqual((await links('a')).friends, ['b']); assert.deepEqual((await links('b')).friends, ['a']);
assert.deepEqual((await links('a')).outgoing, []); assert.deepEqual((await links('b')).incoming, []);
assert.equal((await social.accept('b', 'a')).state, 'friends', 'accept is idempotent');
assert.equal((await social.request('a', 'b')).code, 'already_friends');

// ---- decline / cancel ----
await social.request('c', 'a');
assert.deepEqual((await social.decline('a', 'c')).state, 'none');
assert.deepEqual((await links('c')).outgoing, []); assert.deepEqual((await links('a')).incoming, []);
await social.request('c', 'a');
assert.deepEqual((await social.cancel('c', 'a')).state, 'none');
assert.deepEqual((await links('a')).incoming, []);

// ---- mutual request auto-accepts ----
await social.request('c', 'b');
r = await social.request('b', 'c');
assert.deepEqual(r, { ok: true, state: 'friends' }, 'they already asked us: becomes friends');
assert.ok((await links('c')).friends.includes('b') && (await links('b')).friends.includes('c'));

// ---- remove removes both sides ----
assert.equal((await social.remove('a', 'b')).ok, true);
assert.deepEqual((await links('a')).friends, []); assert.ok(!(await links('b')).friends.includes('a'));
assert.ok(sent('b').some((m) => m.t === 'friends' && !m.friends.some((f) => f.uid === 'a')), 'other side is refreshed');

// ---- presence fan-out ----
online.add('a'); online.add('c');
await social.onConnect('a', 'Alice');
await social.request('a', 'c'); await social.accept('c', 'a');
inbox.clear();
await social.onConnect('c', 'Carol');
assert.ok(sent('a').some((m) => m.t === 'fpresence' && m.uid === 'c' && m.online === true));
const snap = sent('c').find((m) => m.t === 'friends');
assert.ok(snap.friends.find((f) => f.uid === 'a').online === true && snap.friends.find((f) => f.uid === 'a').username === 'Alice');
online.delete('c'); social.onDisconnect('c');
assert.ok(sent('a').some((m) => m.t === 'fpresence' && m.uid === 'c' && m.online === false));
online.add('c'); await social.onConnect('c', 'Carol'); inbox.clear();
social.noteRank('a', { tier: 'Ne', div: 2, wins: 1, matches: 9 });
assert.deepEqual(sent('c').find((m) => m.t === 'frank'), { t: 'frank', uid: 'a', rank: { tier: 'Ne', div: 2, wins: 1 } }, 'rank update reaches online friends, trimmed');
// rename
inbox.clear();
await store.noteUser('a', 'Alicia');
assert.equal(await social.refreshName('a'), 'Alicia');
assert.deepEqual(sent('c').find((m) => m.t === 'fname'), { t: 'fname', uid: 'a', username: 'Alicia' });

// ---- search ----
let s = await social.search('b', 'al');
assert.deepEqual(s.results.map((x) => x.username).sort(), ['Alfred', 'Alicia']);
assert.equal(s.results.find((x) => x.username === 'Alicia').rel, 'none');
s = await social.search('c', 'ali');
assert.equal(s.results.find((x) => x.uid === 'a').rel, 'friend');
s = await social.search('a', 'ali'); assert.ok(!s.results.some((x) => x.uid === 'a'), 'self excluded');
await social.request('b', 'a'); s = await social.search('b', 'alic'); assert.equal(s.results[0].rel, 'outgoing');
s = await social.search('a', 'bo'); assert.equal(s.results[0].rel, 'incoming');
assert.equal((await social.search('a', 'zzz')).results.length, 0);

// ---- limits ----
const big = createJsonSocialStore(null), many = new Social({ store: big, getRank: async () => null, liveRank: () => undefined, isOnline: () => false, send: () => {} });
await big.noteUser('me', 'Me');
for (let i = 0; i <= LIMITS.incoming; i++) await big.noteUser('u' + i, 'U' + i);
for (let i = 0; i < LIMITS.incoming; i++) assert.equal((await many.request('u' + i, 'me')).ok, true);
assert.equal((await many.request('u' + LIMITS.incoming, 'me')).code, 'target_limit_incoming', 'max pending incoming');
for (let i = 0; i <= LIMITS.outgoing; i++) await big.noteUser('f' + i, 'F' + i);
for (let i = 0; i < LIMITS.outgoing; i++) assert.equal((await many.request('me', 'f' + i)).ok, true);
assert.equal((await many.request('me', 'f' + LIMITS.outgoing)).code, 'limit_outgoing', 'max pending outgoing');
await big.update(['me'], (m) => { m.get('me').friends = Array.from({ length: LIMITS.friends }, (_, i) => 'x' + i); m.get('me').outgoing = []; return { ok: true }; });
assert.equal((await many.accept('me', 'u0')).code, 'limit_friends', 'max friends');
assert.equal((await many.request('me', 'f50')).code, 'limit_friends');

// ---- ghosts: a deleted account is removed from lists lazily ----
await store.deleteUser('b');
social.names.clear();
const gs = await social.snapshot('c');
assert.ok(!gs.friends.some((f) => f.uid === 'b'));
const sa = await social.snapshot('a');
assert.ok(!sa.outgoing.some((f) => f.uid === 'b') && !sa.incoming.some((f) => f.uid === 'b'), 'pending request with a deleted account pruned');
assert.ok(!(await links('a')).outgoing.includes('b') && !(await links('c')).friends.includes('b'), 'links really removed');

// ---- input validation ----
assert.equal(normalizeQuery('  Al  '), 'al'); assert.equal(normalizeQuery('a'), null); assert.equal(normalizeQuery('a'.repeat(13)), null);
assert.equal(normalizeQuery('x<y'), null); assert.equal(normalizeQuery(5), null); assert.equal(normalizeQuery('a b_c-1'), 'a b_c-1');
assert.equal(parseClientMessage(JSON.stringify({ t: 'fsearch', q: 'Bo' })).msg.q, 'bo');
assert.equal(parseClientMessage(JSON.stringify({ t: 'fsearch', q: '%%' })).code, 'bad_query');
for (const t of ['fadd', 'faccept', 'fdecline', 'fcancel', 'fremove']) {
  assert.equal(parseClientMessage(JSON.stringify({ t, uid: 'abc_1-2' })).ok, true);
  for (const uid of [undefined, '', 5, 'a b', '../x', 'a'.repeat(129), {}]) assert.equal(parseClientMessage(JSON.stringify({ t, uid })).ok, false, `${t} ${JSON.stringify(uid)}`);
}
assert.equal(parseClientMessage(JSON.stringify({ t: 'flist' })).ok, true);
assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'frefresh' })).msg, { t: 'frefresh' });
console.log('social tests passed');
