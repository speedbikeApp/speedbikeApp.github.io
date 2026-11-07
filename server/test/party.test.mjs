// Party state machine (server/party.js) with fake deps and a fake clock.
import assert from 'node:assert/strict';
import { Parties, PARTY } from '../party.js';

function setup() {
  const w = { now: 1000, online: new Set(), busy: new Set(), friends: new Set(), out: [], gone: [], disbanded: [] };
  const names = (u) => u.toUpperCase();
  const P = new Parties({
    now: () => w.now, send: (uid, m) => w.out.push({ uid, ...m }), isOnline: (u) => w.online.has(u),
    isFriend: (a, b) => w.friends.has(`${a}>${b}`), isBusy: (u) => w.busy.has(u),
    info: (u) => (w.online.has(u) ? { username: names(u), rank: { tier: 'He', div: 3, wins: 0, junk: 1 } } : null),
    onMemberOut: (u) => w.gone.push(u), onDisband: (u) => w.disbanded.push(u),
  });
  const user = (...us) => us.forEach((u) => w.online.add(u));
  const friend = (a, b) => { w.friends.add(`${a}>${b}`); w.friends.add(`${b}>${a}`); };
  const last = (uid, t) => [...w.out].reverse().find((m) => m.uid === uid && m.t === t);
  return { P, w, user, friend, last };
}
const ids = (v) => v.members.map((m) => m.uid);

{ // invite validation
  const { P, user, friend, last } = setup();
  user('a', 'b', 'c'); friend('a', 'b');
  assert.equal(P.invite('a', 'a').code, 'self');
  assert.equal(P.invite('a', 'c').code, 'not_friend');
  assert.ok(P.invite('a', 'b').ok);
  assert.equal(last('b', 'pinvites').invites[0].uid, 'a'); assert.equal(last('b', 'pinvites').invites[0].ttl, PARTY.inviteTtlMs);
  assert.equal(last('b', 'pevent').kind, 'invite');
  assert.equal(P.partyOf('a'), null, 'inviting alone creates no party');
  assert.equal(P.accept('b', 'c').code, 'no_invite');
  assert.ok(P.accept('b', 'a').ok);
  const v = last('a', 'party').party;
  assert.deepEqual(ids(v), ['a', 'b']); assert.equal(v.leader, 'a'); assert.equal(v.max, 4);
  assert.deepEqual(last('b', 'party').party.members[0].rank, { tier: 'He', div: 3, wins: 0 }, 'rank is sanitized');
  assert.deepEqual(last('b', 'pinvites').invites, [], 'invite used up');
  assert.equal(P.invite('b', 'a').code, 'already_in_party');
}
{ // anyone may invite (own friends only); size cap 4; invites expire
  const { P, w, user, friend, last } = setup();
  user('a', 'b', 'c', 'd', 'e'); friend('a', 'b'); friend('b', 'c'); friend('a', 'd'); friend('a', 'e');
  P.invite('a', 'b'); P.accept('b', 'a');
  assert.equal(P.invite('b', 'd').code, 'not_friend', 'only your own friends');
  assert.ok(P.invite('b', 'c').ok); assert.ok(P.accept('c', 'b').ok);
  assert.deepEqual(ids(last('a', 'party').party), ['a', 'b', 'c']);
  P.invite('a', 'd'); P.invite('a', 'e'); // two pending at once (3 + 2 would be 5)
  assert.ok(P.accept('d', 'a').ok);
  assert.equal(P.accept('e', 'a').code, 'party_full'); assert.equal(P.invite('a', 'e').code, 'party_full');
  assert.equal(ids(last('a', 'party').party).length, 4);
  w.now += PARTY.inviteTtlMs + 1; P.tick();
  assert.equal(P.accept('e', 'a').code, 'no_invite', 'expired');
  assert.deepEqual(last('e', 'pinvites').invites, []);
}
{ // decline; offline invitee; busy
  const { P, w, user, friend, last } = setup();
  user('a', 'b'); friend('a', 'b'); friend('a', 'c');
  assert.equal(P.invite('a', 'c').code, 'offline');
  P.invite('a', 'b'); P.decline('b', 'a'); assert.equal(P.accept('b', 'a').code, 'no_invite');
  P.invite('a', 'b'); w.busy.add('b'); assert.equal(P.accept('b', 'a').code, 'busy'); w.busy.delete('b');
  w.busy.add('a'); assert.equal(P.invite('a', 'b').code, 'busy'); w.busy.delete('a');
  P.accept('b', 'a');
  w.busy.add('b'); user('c'); assert.equal(P.invite('a', 'c').code, 'busy', 'a party in a queue / match cannot grow');
}
{ // leader leaves -> earliest joiner leads; party of 2 dissolves when one is left
  const { P, w, user, friend, last } = setup();
  user('a', 'b', 'c', 'd'); friend('a', 'b'); friend('a', 'c'); friend('a', 'd');
  for (const u of ['b', 'c', 'd']) { P.invite('a', u); P.accept(u, 'a'); }
  assert.equal(last('a', 'party').party.leader, 'a');
  assert.ok(P.leave('a').ok);
  assert.equal(last('a', 'party').party, null); assert.equal(last('a', 'party').reason, 'left');
  assert.equal(last('b', 'party').party.leader, 'b', 'b joined before c and d');
  assert.deepEqual(w.gone, ['a']); assert.equal(last('c', 'pevent').kind, 'leader');
  P.leave('b'); assert.equal(last('c', 'party').party.leader, 'c');
  P.leave('c');
  assert.equal(last('d', 'party').party, null); assert.equal(last('d', 'party').reason, 'disbanded'); assert.deepEqual(w.disbanded, ['d']);
  assert.equal(P.partyOf('d'), null); assert.equal(P.parties.size, 0);
  assert.equal(P.leave('d').code, 'not_in_party');
}
{ // kick + transfer permissions
  const { P, w, user, friend, last } = setup();
  user('a', 'b', 'c'); friend('a', 'b'); friend('a', 'c');
  for (const u of ['b', 'c']) { P.invite('a', u); P.accept(u, 'a'); }
  assert.equal(P.kick('b', 'c').code, 'not_leader'); assert.equal(P.transfer('b', 'c').code, 'not_leader');
  assert.equal(P.kick('a', 'a').code, 'self'); assert.equal(P.kick('a', 'zzz').code, 'not_member');
  assert.ok(P.transfer('a', 'b').ok); assert.equal(last('c', 'party').party.leader, 'b');
  assert.equal(P.transfer('b', 'c').ok, true);
  assert.equal(P.kick('b', 'a').code, 'not_leader', 'b no longer leads');
  assert.ok(P.kick('c', 'b').ok);
  assert.equal(last('b', 'party').reason, 'kicked'); assert.equal(last('a', 'pevent').kind, 'kicked'); assert.deepEqual(w.gone, ['b']);
  assert.deepEqual(ids(last('a', 'party').party), ['a', 'c'], 'a and c remain: still a party led by c');
}
{ // joining another party leaves the current one; a dissolving old party is fine
  const { P, user, friend, last } = setup();
  user('a', 'b', 'c', 'd'); friend('a', 'b'); friend('c', 'd'); friend('c', 'a'); friend('c', 'b');
  P.invite('a', 'b'); P.accept('b', 'a');
  P.invite('c', 'd'); P.accept('d', 'c');
  P.invite('c', 'a'); assert.ok(P.accept('a', 'c').ok);
  assert.deepEqual(ids(last('c', 'party').party), ['c', 'd', 'a'], 'a joined c');
  assert.equal(last('b', 'party').party, null, 'a and b: b was left alone -> dissolved'); assert.equal(P.partyOf('b'), null);
}
{ // disconnect grace: seat kept 30 s, back in time = no loss; leader gone for good -> earliest joiner
  const { P, w, user, friend, last } = setup();
  user('a', 'b', 'c'); friend('a', 'b'); friend('a', 'c');
  for (const u of ['b', 'c']) { P.invite('a', u); P.accept(u, 'a'); }
  w.online.delete('a'); P.onDisconnect('a');
  assert.equal(last('b', 'party').party.members.find((m) => m.uid === 'a').online, false);
  w.now += PARTY.graceMs - 1; P.tick(); assert.ok(P.partyOf('a'));
  w.online.add('a'); P.onConnect('a'); assert.equal(last('a', 'party').party.members.length, 3);
  w.now += 60000; P.tick(); assert.ok(P.partyOf('a'), 'reconnect cleared the timer');
  w.online.delete('a'); P.onDisconnect('a'); w.now += PARTY.graceMs; P.tick();
  assert.equal(P.partyOf('a'), null); assert.equal(last('b', 'party').party.leader, 'b'); assert.equal(last('b', 'party').party.members.length, 2);
  // a disconnected non-leader is dropped and the party dissolves when only one remains
  w.online.delete('c'); P.onDisconnect('c'); w.now += PARTY.graceMs; P.tick();
  assert.equal(P.partyOf('b'), null);
  assert.equal(last('b', 'party').reason, 'disbanded');
}
{ // forQueue: leader only, needs 2 online members
  const { P, w, user, friend } = setup();
  user('a', 'b', 'c'); friend('a', 'b'); friend('a', 'c');
  assert.deepEqual(P.forQueue('a'), { ok: true, party: null });
  for (const u of ['b', 'c']) { P.invite('a', u); P.accept(u, 'a'); }
  assert.equal(P.forQueue('b').code, 'not_leader');
  w.online.delete('c'); P.onDisconnect('c');
  assert.deepEqual(P.forQueue('a').members, ['a', 'b']);
  w.online.delete('b'); assert.equal(P.forQueue('a').code, 'party_offline');
}
{ // invite cap per invitee
  const { P, user, friend } = setup();
  user('t'); const many = Array.from({ length: PARTY.maxInvitesPerUser + 1 }, (_, i) => `u${i}`);
  user(...many); many.forEach((u) => friend(u, 't'));
  many.slice(0, PARTY.maxInvitesPerUser).forEach((u) => assert.ok(P.invite(u, 't').ok));
  assert.equal(P.invite(many.at(-1), 't').code, 'invite_limit');
  assert.ok(P.invite(many[0], 't').ok, 're-inviting refreshes');
}
console.log('party tests ok');
