import assert from 'node:assert/strict';
import { resolveTick, resolveTimeout, applyAwards, matchWinner, placements } from '../js/rules.js';

const first = () => 0, last = () => 0.999;

{ // one crash, 3 survivors: one random survivor gets 1 point, round continues
  const r = resolveTick([0, 1, 2, 3], [1], first);
  assert.deepEqual(r.awards, [0]); assert.equal(r.ended, false);
  const r2 = resolveTick([0, 1, 2, 3], [1], last);
  assert.deepEqual(r2.awards, [3]); // never the crashed bike
  for (let i = 0; i < 200; i++) { const x = resolveTick([0, 1, 2, 3], [2]); assert.ok(x.awards.length === 1 && x.awards[0] !== 2); }
}
{ // crash leaving 1 alive: random-survivor point + last-alive point (same bike) and round ends
  const r = resolveTick([0, 3], [0], first);
  assert.deepEqual(r.awards, [3, 3]); assert.equal(r.ended, true);
}
{ // last two crash same tick (head-on): nobody scores, round ends
  const r = resolveTick([1, 2], [1, 2], first);
  assert.deepEqual(r.awards, []); assert.equal(r.ended, true);
}
{ // two of four crash same tick, two survive: each crash gives a point to a survivor, round continues
  const r = resolveTick([0, 1, 2, 3], [0, 1], first);
  assert.equal(r.awards.length, 2); assert.ok(r.awards.every((id) => id === 2 || id === 3)); assert.equal(r.ended, false);
}
{ // three of four crash at once: last one alive gets crash points + last-alive point, ends
  const r = resolveTick([0, 1, 2, 3], [0, 1, 2], first);
  assert.deepEqual(r.awards, [3, 3, 3, 3]); assert.equal(r.ended, true);
}
{ // all four wiped at once: nobody
  const r = resolveTick([0, 1, 2, 3], [0, 1, 2, 3], first);
  assert.deepEqual(r.awards, []); assert.equal(r.ended, true);
}
{ // timeout: all alive get 1
  const r = resolveTimeout([0, 2, 3]);
  assert.deepEqual(r.awards, [0, 2, 3]); assert.equal(r.ended, true);
  const s = { 0: 0, 1: 0, 2: 0, 3: 0 }; applyAwards(s, r.awards);
  assert.deepEqual(s, { 0: 1, 1: 0, 2: 1, 3: 1 });
}
{ // match winner / placements
  assert.equal(matchWinner({ 0: 4, 1: 3, 2: 4, 3: 0 }, 5), null);
  assert.equal(matchWinner({ 0: 5, 1: 3, 2: 4, 3: 0 }, 5), 0);
  assert.equal(matchWinner({ 0: 5, 1: 6, 2: 4, 3: 0 }, 5), 1);
  assert.deepEqual(placements({ 0: 1, 1: 5, 2: 3, 3: 3 }), [1, 2, 3, 0]);
}
{ // player out: round ends at once, one random surviving bot scores, none if no bot survives the tick
  const { resolvePlayerOut } = await import('../js/rules.js');
  const r = resolvePlayerOut([0, 1, 2, 3], [0], 0, () => 0.5);
  assert.equal(r.ended, true); assert.equal(r.awards.length, 1); assert.ok([1, 2, 3].includes(r.awards[0]));
  const r2 = resolvePlayerOut([0, 1, 2], [0, 1], 0, () => 0); assert.deepEqual(r2.awards, [2]);
  const r3 = resolvePlayerOut([0, 3], [0, 3], 0); assert.deepEqual(r3.awards, []); assert.equal(r3.ended, true);
}
console.log('rules tests passed');
