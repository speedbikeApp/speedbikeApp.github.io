import assert from 'node:assert/strict';
import { Matchmaker } from '../matchmaker.js';

let clock = 1000;
const started = [];
const mk = (over = {}) => new Matchmaker({ now: () => clock, onStart: (l) => started.push(l), ...over });
const player = (n) => { const p = { uid: n, username: n, rank: null, where: null, msgs: [], send(m) { p.msgs.push(m); } }; return p; };
const last = (p, t) => [...p.msgs].reverse().find((m) => m.t === t);

{ // 1 player waits; 2nd opens a lobby with a 30 s countdown
  started.length = 0; clock = 1000;
  const mm = mk(), a = player('a'), b = player('b');
  assert.ok(mm.queue(a, 'standard').ok);
  assert.equal(last(a, 'queued').position, 1); assert.equal(last(a, 'lobby'), undefined);
  assert.ok(!mm.queue(a, 'standard').ok, 'cannot queue twice');
  assert.equal(mm.queue(a, 'deathmatch').code, 'busy');
  mm.queue(b, 'standard');
  const l = last(a, 'lobby');
  assert.equal(l.mode, 'standard'); assert.equal(l.players.length, 2); assert.equal(l.countdownEndsAt, 31000);
  assert.deepEqual(last(b, 'lobby').players.map((p) => p.uid), ['a', 'b']);
  assert.notEqual(l.players[0].colorIdx, l.players[1].colorIdx);
  assert.equal(a.where.type, 'lobby');
  mm.tick(30999); assert.equal(started.length, 0);
  mm.tick(31000); assert.equal(started.length, 1); assert.equal(started[0].players.length, 2, 'timeout starts with 2');
  assert.equal(a.where.type, 'match'); assert.equal(mm.stats().lobbies, 0);
}
{ // joining resets the countdown; start with 3 at timeout
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c] = ['a', 'b', 'c'].map(player);
  mm.queue(a, 'standard'); mm.queue(b, 'standard');
  clock = 20000; mm.queue(c, 'standard');
  assert.equal(last(c, 'lobby').countdownEndsAt, 50000, 'reset to now + 30 s');
  assert.equal(last(a, 'lobby').players.length, 3, 'existing members get the update');
  mm.tick(30000); assert.equal(started.length, 0, 'old deadline no longer applies');
  mm.tick(50000); assert.equal(started.length, 1); assert.equal(started[0].players.length, 3);
}
{ // 4 players start immediately; the 5th waits in the queue
  started.length = 0; clock = 0;
  const mm = mk(), ps = ['a', 'b', 'c', 'd', 'e'].map(player);
  for (const p of ps.slice(0, 3)) mm.queue(p, 'deathmatch');
  assert.equal(started.length, 0);
  mm.queue(ps[3], 'deathmatch');
  assert.equal(started.length, 1); assert.equal(started[0].players.length, 4);
  assert.equal(new Set(started[0].players.map((p) => p.colorIdx)).size, 4, 'distinct colours');
  mm.queue(ps[4], 'deathmatch');
  assert.equal(last(ps[4], 'queued').position, 1); assert.equal(ps[4].where.type, 'queue'); assert.equal(started.length, 1);
}
{ // queue overflow: 6 queued at once-ish -> first lobby of 4 starts, remaining 2 form the next lobby
  started.length = 0; clock = 0;
  const mm = mk(), ps = ['a', 'b', 'c', 'd', 'e', 'f'].map(player);
  for (const p of ps) mm.queue(p, 'standard');
  assert.equal(started.length, 1);
  const l = last(ps[5], 'lobby'); assert.deepEqual(l.players.map((p) => p.uid), ['e', 'f']);
}
{ // late joiners fill an OPEN lobby before a new one is created; modes are independent
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c, x, y] = ['a', 'b', 'c', 'x', 'y'].map(player);
  mm.queue(a, 'standard'); mm.queue(b, 'standard'); mm.queue(x, 'deathmatch');
  assert.equal(last(x, 'queued').mode, 'deathmatch'); assert.equal(last(x, 'lobby'), undefined);
  mm.queue(c, 'standard'); assert.equal(mm.stats().lobbies, 1);
  mm.queue(y, 'deathmatch'); assert.equal(mm.stats().lobbies, 2);
}
{ // leaving: lobby shrinks silently (no reset), dissolves under 2, remaining player returns to the queue
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c] = ['a', 'b', 'c'].map(player);
  mm.queue(a, 'standard'); mm.queue(b, 'standard'); mm.queue(c, 'standard');
  clock = 5000; assert.ok(mm.leave(c));
  assert.equal(c.where, null); assert.deepEqual(last(a, 'lobby').players.map((p) => p.uid), ['a', 'b']); assert.equal(last(a, 'lobby').countdownEndsAt, 30000);
  mm.leave(b);
  assert.equal(mm.stats().lobbies, 0); assert.equal(a.where.type, 'queue'); assert.equal(last(a, 'queued').position, 1);
  mm.tick(99999); assert.equal(started.length, 0);
  mm.queue(c, 'standard'); assert.equal(mm.stats().lobbies, 1, 'lobby re-forms');
  assert.ok(!mm.leave(player('z')), 'unknown player is a no-op');
}
{ // leaveQueue from the queue
  const mm = mk(), a = player('a'), b = player('b');
  mm.queue(a, 'standard'); assert.ok(mm.leave(a)); assert.equal(a.where, null); assert.equal(mm.stats().queued, 0);
  mm.queue(a, 'standard'); mm.queue(b, 'hyper'); assert.equal(last(b, 'queued').position, 1);
}
{ // featured rotation: new joins use the allowed set, but players already queued for the old featured mode still get matched
  started.length = 0; clock = 0;
  let featured = 'hyper';
  const mm = mk({ allowed: (m) => ['standard', 'deathmatch', featured].includes(m) });
  const [a, b, c] = ['a', 'b', 'c'].map(player);
  mm.queue(a, 'hyper'); featured = '3d';
  assert.equal(mm.queue(c, 'hyper').code, 'bad_mode', 'old featured no longer open for new joins');
  assert.equal(a.where.mode, 'hyper', 'queued player keeps waiting');
  // someone else already queued for hyper before the rotation: both are matched
  featured = 'hyper'; mm.queue(b, 'hyper'); featured = '3d';
  assert.equal(mm.stats().lobbies, 1); assert.equal(last(a, 'lobby').mode, 'hyper');
  mm.tick(30000); assert.equal(started.length, 1); assert.equal(started[0].mode, 'hyper');
}
{ // groups (parties): placed atomically, count as their players, a party of 4 starts at once
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c, d, x, y] = ['a', 'b', 'c', 'd', 'x', 'y'].map(player);
  assert.ok(mm.queueGroup([a, b, c, d], 'standard', 7).ok);
  assert.equal(started.length, 1, 'party of 4 starts immediately'); assert.deepEqual(started[0].players.map((p) => p.uid), ['a', 'b', 'c', 'd']);
  assert.equal(a.group, 7, 'group id stays on the player for the host');
  assert.equal(mm.queueGroup([x, y], 'standard', 8).code, undefined);
  assert.equal(mm.queueGroup([x], 'standard', 9).code, 'bad_party'); assert.equal(mm.queueGroup([a, b], 'standard', 9).code, 'busy');
}
{ // a party of 2 alone: lobby with the 30 s countdown (counts as 2 players); solos fill the remaining slots and reset it
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, s1, s2, s3] = ['a', 'b', 's1', 's2', 's3'].map(player);
  mm.queueGroup([a, b], 'standard', 1);
  assert.equal(last(a, 'lobby').players.length, 2); assert.equal(last(a, 'lobby').countdownEndsAt, 30000);
  clock = 10000; mm.queue(s1, 'standard');
  assert.equal(last(a, 'lobby').countdownEndsAt, 40000, 'solo join resets the countdown'); assert.equal(started.length, 0);
  mm.queue(s2, 'standard'); assert.equal(started.length, 1); assert.deepEqual(started[0].players.map((p) => p.uid), ['a', 'b', 's1', 's2']);
  mm.queue(s3, 'standard'); assert.equal(s3.where.type, 'queue');
}
{ // a party that does not fit the open lobby waits (never split); later solos still fill the lobby; it then forms the next lobby
  started.length = 0; clock = 0;
  const mm = mk(), [s1, s2, a, b, c, s3] = ['s1', 's2', 'a', 'b', 'c', 's3'].map(player);
  mm.queue(s1, 'standard'); mm.queue(s2, 'standard');
  mm.queueGroup([a, b, c], 'standard', 1);
  assert.equal(a.where.type, 'queue', 'party of 3 does not fit next to 2 solos'); assert.equal(last(a, 'queued').inQueue, 3);
  mm.queue(s3, 'standard'); assert.equal(s3.where.type, 'lobby', 'a solo behind the party still fills the open lobby');
  clock = 30000; mm.tick(clock); assert.equal(started.length, 1); assert.deepEqual(started[0].players.map((p) => p.uid), ['s1', 's2', 's3']);
  assert.equal(a.where.type, 'lobby', 'the party opens the next lobby'); assert.equal(last(a, 'lobby').players.length, 3);
}
{ // a member leaving a party lobby; the lobby dissolving keeps remaining party members together at the front
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c, s1, s2] = ['a', 'b', 'c', 's1', 's2'].map(player);
  mm.queueGroup([a, b, c], 'standard', 5);
  assert.ok(mm.leave(c)); assert.equal(c.group, null); assert.equal(a.where.type, 'lobby'); assert.equal(last(a, 'lobby').players.length, 2);
  assert.ok(mm.leave(b)); assert.equal(a.where.type, 'queue', 'below 2: dissolved back to the queue');
  mm.queueGroup([b, c], 'standard', 6); // new party 6 of two; a (group 5, alone) is first
  assert.equal(mm.lobbies[0].players.length, 3);
}
{ // two parties of 2 fill one lobby and start; other modes are independent
  started.length = 0;
  const mm = mk(), [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(player);
  mm.queue(e, 'deathmatch');
  mm.queueGroup([a, b], 'standard', 1); mm.queueGroup([c, d], 'standard', 2);
  assert.equal(started.length, 1); assert.equal(started[0].players.length, 4); assert.equal(e.where.type, 'queue');
}
console.log('matchmaker tests ok');
