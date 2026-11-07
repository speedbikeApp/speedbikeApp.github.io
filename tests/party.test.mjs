// Client party state (js/party.js): snapshots, leader / member questions, invite expiry, canInvite, text tables.
import assert from 'node:assert/strict';
const { createParty, PARTY_ERR, PARTY_GONE, partyEventText, PARTY_MAX } = await import('../js/party.js');

let t = 1000;
const p = createParty(() => t);
let changes = 0; p.onChange(() => changes++);
p.setMe('me');
assert.equal(p.apply({ t: 'friends' }), false, 'other messages are ignored');
assert.equal(p.inParty(), false); assert.equal(p.canStartGame(), true, 'solo players start their own games'); assert.equal(p.isLeader(), false);
assert.deepEqual(p.memberActions('x'), []);

const snap = (leader, uids) => ({ t: 'party', party: { id: 1, leader, max: 4, members: uids.map((u, i) => ({ uid: u, username: u.toUpperCase(), rank: { tier: 'He', div: 3, wins: 0 }, online: i !== 2 })) } });
p.apply(snap('me', ['me', 'a', 'b']));
assert.equal(changes, 1); assert.equal(p.size(), 3); assert.ok(p.isLeader()); assert.ok(p.canStartGame()); assert.equal(p.leaderOf().uid, 'me');
assert.deepEqual(p.memberActions('a'), ['transfer', 'kick']); assert.deepEqual(p.memberActions('me'), [], 'never on yourself'); assert.deepEqual(p.memberActions('zzz'), []);
assert.equal(p.state.party.members[2].online, false);
assert.equal(p.isMember('a'), true); assert.equal(p.isMember('q'), false);
assert.equal(p.canInvite({ uid: 'q', online: true }), true); assert.equal(p.canInvite({ uid: 'q', online: false }), false); assert.equal(p.canInvite({ uid: 'a', online: true }), false, 'already in the party');
p.apply(snap('me', ['me', 'a', 'b', 'c']));
assert.equal(p.isFull(), true); assert.equal(p.canInvite({ uid: 'q', online: true }), false, 'full');

// a non-leader sees nothing destructive and cannot start games
p.apply(snap('a', ['a', 'me', 'b']));
assert.equal(p.isLeader(), false); assert.equal(p.canStartGame(), false); assert.deepEqual(p.memberActions('b'), []); assert.deepEqual(p.memberActions('a'), []);

// junk is sanitized
p.apply({ t: 'party', party: { leader: 5, members: [] } }); assert.equal(p.inParty(), false);
p.apply(snap('a', ['a', 'me'])); p.apply({ t: 'party', party: null, reason: 'kicked' });
assert.equal(p.inParty(), false); assert.equal(p.state.reason, 'kicked'); assert.ok(PARTY_GONE.kicked);
p.apply({ t: 'party', party: { id: 2, leader: 'me', members: [{ uid: 'me' }, null, { uid: 7 }, { uid: 'z', username: 'Z' }] } });
assert.equal(p.size(), 2); assert.equal(p.state.party.max, PARTY_MAX);

// invites expire on the local clock
p.apply({ t: 'pinvites', invites: [{ uid: 'a', username: 'Alice', ttl: 60000 }, { uid: 'b', username: 'Bob', ttl: 5000 }, { uid: 'c', ttl: 0 }, { bad: 1 }] });
assert.equal(p.activeInvites().length, 2);
t += 5001; assert.deepEqual(p.activeInvites().map((i) => i.uid), ['a']);
t += 60000; assert.equal(p.activeInvites().length, 0);
p.apply({ t: 'pinvites', invites: [{ uid: 'a', username: 'Alice', ttl: 1000 }] }); p.reset();
assert.equal(p.activeInvites().length, 0); assert.equal(p.inParty(), false);

for (const c of ['not_friend', 'party_full', 'not_leader', 'member_busy', 'busy', 'offline', 'no_invite']) assert.ok(PARTY_ERR[c], c);
assert.match(partyEventText({ kind: 'invite', username: 'Al' }), /Al invited you/); assert.equal(partyEventText({ kind: 'zzz' }), '');
console.log('party client tests passed');
