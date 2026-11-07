import assert from 'node:assert/strict';
import { TIERS, TIER_ORDER, LADDER, defaultRank, ladderIndex, normalizeRank, rankLabel, isTierPoint, applyResult } from '../js/ranks.js';

const R = (tier, div, wins = 0) => ({ ...defaultRank(), tier, div, wins });

assert.equal(LADDER.length, 9);
assert.deepEqual(LADDER.map((s) => s.tier + s.div), ['He3', 'He2', 'He1', 'Ne3', 'Ne2', 'Ne1', 'Xe3', 'Xe2', 'Xe1']);
assert.deepEqual(TIER_ORDER, ['He', 'Ne', 'Xe']);
assert.equal(TIERS.He.color, '#ff9a76'); assert.equal(TIERS.Ne.color, '#ff4d2e'); assert.equal(TIERS.Xe.color, '#8f7bff');
assert.equal(ladderIndex(R('Ne', 3)), 3);

{ // default + win/loss
  const d = defaultRank(); assert.deepEqual([d.tier, d.div, d.wins], ['He', 3, 0]);
  let x = applyResult(d, true, 5);
  assert.equal(x.change, 'none'); assert.equal(x.rank.wins, 1); assert.equal(x.rank.matches, 1); assert.equal(x.rank.totalWins, 1); assert.equal(x.rank.updatedAt, 5);
  assert.equal(d.wins, 0, 'input not mutated');
  x = applyResult(x.rank, true);
  assert.equal(x.change, 'promote'); assert.equal(x.tierChange, false); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['He', 2, 0]);
}
{ // demote below 0 -> wins 1 one division down
  const x = applyResult(R('Ne', 3, 0), false);
  assert.equal(x.change, 'demote'); assert.equal(x.tierChange, true); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['He', 1, 1]);
  assert.equal(x.rank.totalWins, 0); assert.equal(x.rank.matches, 1);
  const y = applyResult(R('He', 2, 1), false); assert.equal(y.change, 'none'); assert.equal(y.rank.wins, 0);
}
{ // floor at He3
  const x = applyResult(R('He', 3, 0), false);
  assert.equal(x.change, 'none'); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['He', 3, 0]);
}
{ // cap at Xe1: wins never above 1, no promotion
  let x = applyResult(R('Xe', 1, 1), true);
  assert.equal(x.change, 'none'); assert.equal(x.rank.wins, 1); assert.deepEqual([x.rank.tier, x.rank.div], ['Xe', 1]);
  x = applyResult(R('Xe', 1, 0), true); assert.equal(x.rank.wins, 1);
  x = applyResult(R('Xe', 1, 0), false); assert.equal(x.change, 'demote'); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['Xe', 2, 1]);
}
{ // tier up
  const x = applyResult(R('He', 1, 1), true);
  assert.equal(x.change, 'promote'); assert.equal(x.tierChange, true); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['Ne', 3, 0]);
  const z = applyResult(R('Ne', 1, 1), true); assert.deepEqual([z.rank.tier, z.rank.div], ['Xe', 3]);
}
{ // tier point: div 1 + 1 win, not Xe
  assert.ok(isTierPoint(R('He', 1, 1))); assert.ok(isTierPoint(R('Ne', 1, 1)));
  assert.ok(!isTierPoint(R('Xe', 1, 1))); assert.ok(!isTierPoint(R('He', 1, 0)));
  assert.ok(!isTierPoint(R('He', 2, 1))); assert.ok(!isTierPoint(R('Ne', 3, 1)));
  assert.ok(isTierPoint(applyResult(R('He', 1, 0), true).rank));
  assert.ok(!isTierPoint(applyResult(R('He', 1, 1), false).rank));
}
{ // labels
  assert.equal(rankLabel(R('Ne', 2)), 'NEON II'); assert.equal(rankLabel(R('Ne', 2), true), 'Ne II');
  assert.equal(rankLabel(R('He', 3)), 'HELIUM III'); assert.equal(rankLabel(R('Xe', 1), true), 'Xe I');
}
{ // long walk: always valid, ends pinned at the top / bottom
  let r = defaultRank();
  for (let i = 0; i < 40; i++) { r = applyResult(r, true).rank; assert.ok(ladderIndex(r) >= 0 && r.wins >= 0 && r.wins <= 1); }
  assert.deepEqual([r.tier, r.div, r.wins], ['Xe', 1, 1]);
  for (let i = 0; i < 40; i++) r = applyResult(r, false).rank;
  assert.deepEqual([r.tier, r.div, r.wins], ['He', 3, 0]);
}
{ // normalize untrusted docs
  assert.deepEqual(normalizeRank(null), defaultRank());
  const n = normalizeRank({ tier: 'Zz', div: 9, wins: 99, matches: -4 }); assert.deepEqual([n.tier, n.div, n.wins, n.matches], ['He', 3, 1, 0]);
  assert.equal(normalizeRank({ tier: 'Ne', div: 2, wins: 5 }).wins, 1);
}
console.log('ranks tests ok');
