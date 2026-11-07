// Client friends state (js/social.js): snapshot + live deltas, ordering (online first), friend lookup for the HUD icon, pending count.
import assert from 'node:assert/strict';

const { createSocial, REL_ACTION, FRIEND_ERR } = await import('../js/social.js');
const { FRIEND_ICON } = await import('../js/hud.js').catch(() => ({ FRIEND_ICON: null }));

const s = createSocial();
let changes = 0;
s.onChange(() => changes++);
assert.equal(s.apply({ t: 'ping' }), false, 'non-social messages are ignored');
assert.equal(s.isFriend('x'), false);

const rank = { tier: 'Ne', div: 2, wins: 1 };
s.apply({
  t: 'friends',
  friends: [
    { uid: 'u1', username: 'zed', rank, online: false },
    { uid: 'u2', username: 'Bob', rank, online: true },
    { uid: 'u3', username: 'alice', rank, online: true },
    { uid: 'u4', username: 'Carl', rank: null, online: false },
  ],
  incoming: [{ uid: 'u5', username: 'Eve', rank }, { uid: 'u6', username: 'dan', rank }],
  outgoing: [{ uid: 'u7', username: 'Fay', rank }],
});
assert.deepEqual(s.sortedFriends().map((f) => f.username), ['alice', 'Bob', 'Carl', 'zed'], 'online first, then by name (case-insensitive)');
assert.equal(s.onlineCount(), 2); assert.equal(s.pendingCount(), 2);
assert.deepEqual(s.incomingList().map((p) => p.username), ['dan', 'Eve']);
assert.ok(s.isFriend('u1') && !s.isFriend('u5') && !s.isFriend(undefined) && !s.isFriend(5), 'only real friends (not pending) get the icon');

s.apply({ t: 'fpresence', uid: 'u1', online: true });
assert.deepEqual(s.sortedFriends().map((f) => f.username).slice(0, 3), ['alice', 'Bob', 'zed'], 'presence reorders live');
s.apply({ t: 'fpresence', uid: 'nobody', online: true });  // unknown uid: ignored
s.apply({ t: 'frank', uid: 'u4', rank });
assert.deepEqual(s.state.friends.get('u4').rank, rank);
s.apply({ t: 'fname', uid: 'u2', username: 'Robert' });
assert.equal(s.state.friends.get('u2').username, 'Robert');
s.apply({ t: 'fname', uid: 'u5', username: 'Eva' });
assert.equal(s.state.incoming.get('u5').username, 'Eva', 'names update in pending lists too');
s.apply({ t: 'fname', uid: 'u2', username: 5 });
assert.equal(s.state.friends.get('u2').username, 'Robert', 'garbage ignored');
assert.ok(changes === 5);

// a new snapshot replaces everything (removed friends vanish)
s.apply({ t: 'friends', friends: [{ uid: 'u3', username: 'alice', online: true }], incoming: [], outgoing: [] });
assert.equal(s.isFriend('u2'), false); assert.equal(s.pendingCount(), 0);
s.apply({ t: 'friends', friends: 'junk', incoming: null, outgoing: [{ nouid: 1 }] });
assert.equal(s.sortedFriends().length, 0, 'malformed snapshot is harmless');

s.reset(); assert.equal(s.state.ready, false);
assert.equal(REL_ACTION.none.act, 'fadd'); assert.equal(REL_ACTION.incoming.act, 'faccept'); assert.equal(REL_ACTION.friend.act, null);
for (const code of ['self', 'not_found', 'limit_friends', 'target_limit_incoming', 'rate_limited']) assert.ok(FRIEND_ERR[code]);
if (FRIEND_ICON) assert.ok(FRIEND_ICON.includes('<svg') && !FRIEND_ICON.includes('<script'));
console.log('social client tests passed');
