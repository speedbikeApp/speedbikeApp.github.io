// Invite links (server/invites.js) with fake deps over the in-memory social store, plus the Founder rule (server/founder.js).
import assert from 'node:assert/strict';
import { Invites, INVITE } from '../invites.js';
import { createFounders, sessionIcon, parseFounderUntil } from '../founder.js';
import { createJsonSocialStore } from '../social-store.js';
import { parseClientMessage } from '../protocol.js';

function setup(opts = {}) {
  const w = { online: new Set(), busy: new Set(), friends: new Set(), out: [], calls: [], n: 0 };
  const store = createJsonSocialStore(null);
  const key = (a, b) => [a, b].sort().join('>');
  const inv = new Invites({
    store, rand: () => `code${String(++w.n).padStart(6, '0')}`, ...opts,
    social: { befriend: async (a, b) => { if (w.friends.has(key(a, b))) return { ok: false, code: 'already_friends' }; w.friends.add(key(a, b)); return { ok: true }; } },
    parties: { invite: (a, b) => { w.calls.push(['invite', a, b]); return { ok: true }; }, accept: (a, b) => { w.calls.push(['accept', a, b]); return { ok: true }; } },
    isOnline: (u) => w.online.has(u), isBusy: (u) => w.busy.has(u), nameOf: async (u) => u.toUpperCase(), send: (u, m) => w.out.push({ uid: u, ...m }),
  });
  const sent = (uid, t) => w.out.filter((m) => m.uid === uid && m.t === t);
  return { inv, w, store, sent };
}

{ // codes: one standing code per player, resettable, dead after reset
  const { inv } = setup();
  const c1 = await inv.codeOf('a');
  assert.equal(await inv.codeOf('a'), c1, 'standing code');
  assert.notEqual(await inv.codeOf('b'), c1);
  assert.equal(await inv.who(c1), 'A');
  const c2 = await inv.reset('a');
  assert.notEqual(c2, c1); assert.equal(await inv.who(c1), null, 'old code is dead'); assert.equal(await inv.who(c2), 'A');
  assert.deepEqual(await inv.use('b', c1), { ok: false, code: 'unknown' });
  assert.deepEqual(await inv.use('b', 'nosuchcode1'), { ok: false, code: 'unknown' });
  assert.deepEqual(await inv.use('a', c2), { ok: false, code: 'own' });
}
{ // default codes: >= 8 URL-safe chars, random
  const inv = new Invites({ store: createJsonSocialStore(null) }), c = await inv.codeOf('a');
  assert.match(c, /^[\w-]{12}$/); assert.notEqual(await inv.codeOf('b'), c);
}
{ // link -> friends + party (inviter online and idle)
  const { inv, w, sent } = setup(); w.online.add('a'); w.online.add('b');
  const code = await inv.codeOf('a');
  assert.deepEqual(await inv.use('b', code), { ok: true, username: 'A', joined: true });
  assert.ok(w.friends.has('a>b')); assert.deepEqual(w.calls, [['invite', 'a', 'b'], ['accept', 'b', 'a']], 'reuses Parties.invite + accept');
  assert.equal(sent('a', 'pevent').length, 0);
  assert.deepEqual(await inv.use('b', code), { ok: false, code: 'already_friends' });
}
{ // inviter busy / offline: friends only; busy online inviter gets a notice
  const { inv, w, sent } = setup(); w.online.add('a'); w.online.add('b'); w.busy.add('a');
  const code = await inv.codeOf('a');
  assert.deepEqual(await inv.use('b', code), { ok: true, username: 'A', joined: false });
  assert.deepEqual(w.calls, []); assert.equal(sent('a', 'pevent')[0].kind, 'invlink'); assert.equal(sent('a', 'pevent')[0].username, 'B');
  w.online.delete('a'); assert.equal((await inv.use('c', code)).joined, false);
}
{ // reward: once, both sides, after the first finished match; waits for the owner to connect when offline
  const { inv, w, sent } = setup(); w.online.add('a'); w.online.add('b');
  const code = await inv.codeOf('a'); await inv.use('b', code);
  await inv.onMatchEnd('x'); assert.equal(w.out.filter((m) => m.t === 'invreward').length, 0, 'not invited: nothing');
  w.online.delete('a');
  await inv.onMatchEnd('b');
  assert.deepEqual(sent('b', 'invreward'), [{ uid: 'b', t: 'invreward', coins: INVITE.rewardCoins, name: 'A' }]);
  assert.equal(sent('a', 'invreward').length, 0, 'offline inviter: pending');
  await inv.onMatchEnd('b'); await inv.onMatchEnd('b'); assert.equal(sent('b', 'invreward').length, 1, 'only once');
  w.online.add('a'); await inv.deliver('a'); await inv.deliver('a');
  assert.deepEqual(sent('a', 'invreward'), [{ uid: 'a', t: 'invreward', coins: INVITE.rewardCoins, name: 'B' }], 'delivered once on connect');
}
{ // invitedBy is set once (first link wins) and a second link pays nobody
  const { inv, w, store, sent } = setup(); w.online.add('b');
  const ca = await inv.codeOf('a'), cc = await inv.codeOf('c');
  await inv.use('b', ca); await inv.use('b', cc);
  assert.equal((await store.getInv('b')).invitedBy, 'a');
  assert.ok(w.friends.has('b>c'), 'still friends with the second inviter');
  await inv.onMatchEnd('b'); w.online.add('a'); w.online.add('c'); await inv.deliver('a'); await inv.deliver('c');
  assert.equal(sent('a', 'invreward').length, 1); assert.equal(sent('c', 'invreward').length, 0);
}
{ // cap: the inviter is paid for at most `rewardCap` invites; the invitee's slot is spent without a payout
  const { inv, w, store, sent } = setup({ rewardCap: 2 }); w.online.add('a');
  const code = await inv.codeOf('a');
  for (const u of ['b1', 'b2', 'b3']) { w.online.add(u); await inv.use(u, code); await inv.onMatchEnd(u); }
  assert.equal((await store.getInv('a')).rewarded, 2);
  assert.equal(sent('b1', 'invreward').length, 1); assert.equal(sent('b2', 'invreward').length, 1); assert.equal(sent('b3', 'invreward').length, 0);
  assert.equal(sent('a', 'invreward').length, 2);
  await inv.onMatchEnd('b3'); assert.equal(sent('b3', 'invreward').length, 0, 'not retried');
}
{ // protocol
  const ok = (o) => parseClientMessage(JSON.stringify(o)).ok;
  assert.ok(ok({ t: 'invuse', code: 'abcDEF12-_x' })); assert.ok(ok({ t: 'invget' })); assert.ok(ok({ t: 'invreset' }));
  assert.ok(!ok({ t: 'invuse', code: 'short' })); assert.ok(!ok({ t: 'invuse', code: 'bad code!!!' })); assert.ok(!ok({ t: 'invuse' }));
  assert.ok(ok({ t: 'icon', icon: 'founder' }));
}

// ---- Founder ----
{
  assert.equal(parseFounderUntil(undefined), null); assert.equal(parseFounderUntil('nonsense'), null);
  const until = parseFounderUntil('2027-01-01');
  const at = { old: Date.parse('2026-06-01'), fresh: Date.parse('2027-03-01') };
  let lookups = 0;
  const f = createFounders({ until, createdAt: async (u) => { lookups++; if (u === 'boom') throw new Error('x'); return at[u]; } });
  assert.equal(await f.is('old'), true); assert.equal(await f.is('fresh'), false); assert.equal(await f.is('old'), true); assert.equal(lookups, 2, 'cached per uid');
  assert.equal(await f.is('boom'), false); assert.equal(await f.is('boom'), false); assert.equal(lookups, 4, 'failures are not cached');
  const all = createFounders({ until: null, createdAt: async () => { throw new Error('never asked'); } });
  assert.equal(await all.is('anyone'), true, 'unset cutoff: every account is a founder');
  // the icon the server shows
  assert.equal(sessionIcon(null, false, false), ''); assert.equal(sessionIcon(null, true, true), 'admin'); assert.equal(sessionIcon(null, false, true), 'founder');
  assert.equal(sessionIcon('founder', false, true), 'founder'); assert.equal(sessionIcon('founder', true, false), '', 'founder refused for non-founders');
  assert.equal(sessionIcon('admin', false, true), '', 'admin still refused for non-admins'); assert.equal(sessionIcon('admin', true, false), 'admin');
  assert.equal(sessionIcon('star:3', false, false), 'star:3'); assert.equal(sessionIcon('', true, true), '');
}
{ // an old account opening a link: friends (and party) as usual, but no reward for anyone
  const { inv, w, store, sent } = setup({ isNew: async (u) => u !== 'old' }); w.online.add('a'); w.online.add('old');
  assert.equal((await inv.use('old', await inv.codeOf('a'))).ok, true); assert.ok(w.friends.has('a>old'));
  assert.equal((await store.getInv('old')).invitedBy || null, null);
  await inv.onMatchEnd('old'); assert.equal(sent('old', 'invreward').length + sent('a', 'invreward').length, 0);
}
console.log('invites tests passed');
