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
{ // a party of 2 alone: own lobby with the 30 s countdown; solos never join it (they form their own, ranked, lobby)
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, s1, s2, s3] = ['a', 'b', 's1', 's2', 's3'].map(player);
  mm.queueGroup([a, b], 'standard', 1);
  assert.equal(last(a, 'lobby').players.length, 2); assert.equal(last(a, 'lobby').countdownEndsAt, 30000);
  clock = 10000; mm.queue(s1, 'standard');
  assert.equal(last(a, 'lobby').countdownEndsAt, 30000, 'a solo does not reset the party lobby'); assert.equal(s1.where.type, 'queue', 'one solo waits for another solo');
  mm.queue(s2, 'standard'); assert.equal(s1.where.type, 'lobby'); assert.deepEqual(last(s1, 'lobby').players.map((p) => p.uid), ['s1', 's2']); assert.equal(started.length, 0);
  mm.queue(s3, 'standard'); assert.equal(last(s1, 'lobby').players.length, 3);
  clock = 40000; mm.tick(clock); assert.equal(started.length, 2);
  assert.deepEqual(started.map((l) => l.players.map((p) => p.uid).join()).sort(), ['a,b', 's1,s2,s3'], 'party and solos start separate matches');
}
{ // a party that does not fit its open lobby waits (never split); solos are unaffected
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c, d, e, s1, s2] = ['a', 'b', 'c', 'd', 'e', 's1', 's2'].map(player);
  mm.queueGroup([a, b, c], 'standard', 1); mm.queueGroup([d, e], 'standard', 2);
  assert.equal(a.where.type, 'lobby'); assert.equal(d.where.type, 'queue', 'party of 2 does not fit next to a party of 3');
  mm.queue(s1, 'standard'); mm.queue(s2, 'standard'); assert.equal(s1.where.type, 'lobby');
  clock = 30000; mm.tick(clock); assert.equal(started.length, 2);
  assert.equal(d.where.type, 'lobby', 'the waiting party opens the next lobby'); assert.equal(last(d, 'lobby').players.length, 2);
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

{ // solo lobbies (makeBot hook): one human waits soloWaitMs, then bots join one at a time; the match starts when full
  started.length = 0; clock = 0;
  const makeBot = (hs, bs) => ({ username: 'b' + bs.length, rank: null, colorIdx: [0, 1, 2, 3].find((c) => ![...hs, ...bs].some((p) => p.colorIdx === c)), bot: true });
  const mm = mk({ makeBot, soloWaitMs: 5000, botJoinMs: [1000, 3000], rng: () => 0.5 }), [a, b, c] = ['a', 'b', 'c'].map(player);
  mm.queue(a, 'standard');
  assert.equal(a.where.type, 'lobby'); assert.equal(last(a, 'lobby').players.length, 1); assert.equal(last(a, 'lobby').countdownEndsAt, 9000, 'ends when the last bot arrives');
  mm.tick(4999); assert.equal(last(a, 'lobby').players.length, 1);
  mm.tick(5000); assert.deepEqual(last(a, 'lobby').players.map((p) => p.username), ['a', 'b0']);
  assert.equal(last(a, 'lobby').players[1].uid, null); assert.ok(!('bot' in last(a, 'lobby').players[1]), 'no bot flag on the lobby list');
  assert.deepEqual(mm.view().lobbies[0].players, ['a', 'b0 (BOT)'], 'the admin still sees it is a bot');
  mm.tick(7000); assert.equal(last(a, 'lobby').players.length, 3);
  mm.tick(9000); assert.equal(started.length, 1); assert.equal(started[0].bots.length, 3); assert.equal(started[0].players.length, 1);
  assert.equal(new Set([a, ...started[0].bots].map((p) => p.colorIdx)).size, 4, 'distinct colours');

  // a second human switches to the normal countdown (the bot that already joined stays); leaving back to one replans; the last one out dissolves
  clock = 100000; mm.queue(b, 'standard'); clock = 105000; mm.tick(clock);
  assert.equal(last(b, 'lobby').players.length, 2);
  clock = 105500; mm.queue(c, 'standard');
  assert.deepEqual(last(c, 'lobby').players.map((p) => p.username), ['b', 'c', 'b0']); assert.equal(last(c, 'lobby').countdownEndsAt, 135500);
  mm.tick(134000); assert.equal(started.length, 1, 'no bots join while 2 humans count down');
  clock = 134000; mm.leave(c); assert.equal(last(b, 'lobby').countdownEndsAt, 138000, 'alone again: the next bots join every gap');
  mm.tick(136000); assert.equal(last(b, 'lobby').players.length, 3); mm.tick(138000); assert.equal(started.length, 2);
  clock = 200000; const d = player('d'); mm.queue(d, 'standard'); mm.leave(d);
  assert.equal(mm.stats().lobbies, 0); assert.equal(d.where, null); mm.tick(210000); assert.equal(started.length, 2, 'an emptied lobby is gone');
}
{ // admin bots switch: off sends a lone human (with arrived bots) back to the queue; on again replans
  started.length = 0; clock = 0;
  const makeBot = (hs, bs) => ({ username: 'b' + bs.length, colorIdx: 3 - bs.length, bot: true });
  const mm = mk({ makeBot, soloWaitMs: 1000, botJoinMs: [1000, 1000] }), a = player('a');
  mm.queue(a, 'standard'); mm.tick(1000); assert.equal(last(a, 'lobby').players.length, 2);
  mm.setMakeBot(null); assert.equal(a.where.type, 'queue'); assert.equal(mm.stats().lobbies, 0);
  mm.tick(99999); assert.equal(started.length, 0, 'nothing starts with one human and no bots');
  clock = 100000; mm.setMakeBot(makeBot); assert.equal(a.where.type, 'lobby'); assert.equal(last(a, 'lobby').countdownEndsAt, 103000);
  mm.tick(103000); assert.equal(started.length, 1); assert.equal(started[0].bots.length, 3);
}
{ // READY: every human pressed it -> starts on the next tick
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c] = ['a', 'b', 'c'].map(player);
  mm.ready(a); assert.equal(started.length, 0, 'ready outside a lobby does nothing');
  mm.queue(a, 'standard'); mm.queue(b, 'standard');
  assert.equal(last(a, 'lobby').canReady, true);
  mm.ready(a); mm.tick(1); assert.equal(started.length, 0, 'one of two is not enough');
  assert.equal(last(b, 'lobby').players[0].ready, true); assert.equal(last(b, 'lobby').players[1].ready, undefined);
  const n = b.msgs.length; mm.ready(a); assert.equal(b.msgs.length, n, 'pressing again sends nothing');
  mm.queue(c, 'standard'); mm.ready(b); mm.tick(2); assert.equal(started.length, 0, 'a newcomer must press it too');
  mm.ready(c); mm.tick(3); assert.equal(started.length, 1); assert.equal(started[0].players.length, 3);
}
{ // READY: the one who is not ready leaves -> the rest start; a party pulled out one by one does not
  started.length = 0; clock = 0;
  const mm = mk(), [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(player);
  mm.queue(a, 'standard'); mm.queue(b, 'standard'); mm.queue(c, 'standard');
  mm.ready(a); mm.ready(b); mm.leave(c); mm.tick(1); assert.equal(started.length, 1);
  mm.queueGroup([c, d, e], 'deathmatch', 'P'); mm.ready(d); mm.ready(e);
  mm.leave(c); mm.leave(d); mm.leave(e); mm.tick(2); assert.equal(started.length, 1, 'leader cancel never starts a match');
}
{ // READY in a solo lobby: not for one human, bots look ready, a stale ready does not survive being alone
  started.length = 0; clock = 0;
  const mm = mk({ makeBot: (h, bs) => ({ username: 'Bot' + bs.length, colorIdx: 3, rank: null }) }), [a, b, c] = ['a', 'b', 'c'].map(player);
  mm.queue(a, 'standard'); mm.ready(a); mm.tick(5000);
  assert.equal(started.length, 0); assert.equal(last(a, 'lobby').canReady, undefined); assert.equal(last(a, 'lobby').players[1].ready, undefined);
  mm.queue(b, 'standard'); assert.equal(last(b, 'lobby').players.find((p) => p.uid === null).ready, true, 'bots look ready');
  mm.ready(a); mm.leave(b); assert.equal(last(a, 'lobby').canReady, undefined);
  mm.queue(c, 'standard'); assert.equal(last(c, 'lobby').players.find((p) => p.uid === 'a').ready, undefined, 'asked again');
}
console.log('solo lobby tests ok');
