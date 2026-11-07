import assert from 'node:assert/strict';
import { TIERS, TIER_ORDER, LADDER, defaultRank, ladderIndex, normalizeRank, migrateRank, RANK_VERSION, rankLabel, isTierPoint, applyResult } from '../js/ranks.js';

const R = (tier, div, wins = 0) => ({ ...defaultRank(), tier, div, wins });

assert.equal(LADDER.length, 9);
assert.deepEqual(LADDER.map((s) => s.tier + s.div), ['He1', 'He2', 'He3', 'Ne1', 'Ne2', 'Ne3', 'Xe1', 'Xe2', 'Xe3']);
assert.deepEqual(TIER_ORDER, ['He', 'Ne', 'Xe']);
assert.equal(TIERS.He.color, '#ff9a76'); assert.equal(TIERS.Ne.color, '#ff4d2e'); assert.equal(TIERS.Xe.color, '#8f7bff');
assert.equal(ladderIndex(R('Ne', 1)), 3); assert.equal(ladderIndex(R('He', 1)), 0); assert.equal(ladderIndex(R('Xe', 3)), 8);

{ // default + win/loss
  const d = defaultRank(); assert.deepEqual([d.tier, d.div, d.wins, d.v], ['He', 1, 0, RANK_VERSION]);
  let x = applyResult(d, true, 5);
  assert.equal(x.change, 'none'); assert.equal(x.rank.wins, 1); assert.equal(x.rank.matches, 1); assert.equal(x.rank.totalWins, 1); assert.equal(x.rank.updatedAt, 5);
  assert.equal(d.wins, 0, 'input not mutated');
  x = applyResult(x.rank, true);
  assert.equal(x.change, 'promote'); assert.equal(x.tierChange, false); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['He', 2, 0]);
}
{ // demote below 0 -> wins 1 one division down
  const x = applyResult(R('Ne', 1, 0), false);
  assert.equal(x.change, 'demote'); assert.equal(x.tierChange, true); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['He', 3, 1]);
  assert.equal(x.rank.totalWins, 0); assert.equal(x.rank.matches, 1);
  const y = applyResult(R('He', 2, 1), false); assert.equal(y.change, 'none'); assert.equal(y.rank.wins, 0);
}
{ // floor at He1
  const x = applyResult(R('He', 1, 0), false);
  assert.equal(x.change, 'none'); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['He', 1, 0]);
}
{ // cap at Xe3: wins never above 1, no promotion
  let x = applyResult(R('Xe', 3, 1), true);
  assert.equal(x.change, 'none'); assert.equal(x.rank.wins, 1); assert.deepEqual([x.rank.tier, x.rank.div], ['Xe', 3]);
  x = applyResult(R('Xe', 3, 0), true); assert.equal(x.rank.wins, 1);
  x = applyResult(R('Xe', 3, 0), false); assert.equal(x.change, 'demote'); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['Xe', 2, 1]);
}
{ // tier up
  const x = applyResult(R('He', 3, 1), true);
  assert.equal(x.change, 'promote'); assert.equal(x.tierChange, true); assert.deepEqual([x.rank.tier, x.rank.div, x.rank.wins], ['Ne', 1, 0]);
  const z = applyResult(R('Ne', 3, 1), true); assert.deepEqual([z.rank.tier, z.rank.div], ['Xe', 1]);
}
{ // tier point: div 3 + 1 win, not Xe
  assert.ok(isTierPoint(R('He', 3, 1))); assert.ok(isTierPoint(R('Ne', 3, 1)));
  assert.ok(!isTierPoint(R('Xe', 3, 1))); assert.ok(!isTierPoint(R('He', 3, 0)));
  assert.ok(!isTierPoint(R('He', 2, 1))); assert.ok(!isTierPoint(R('Ne', 1, 1)));
  assert.ok(isTierPoint(applyResult(R('He', 3, 0), true).rank));
  assert.ok(!isTierPoint(applyResult(R('He', 3, 1), false).rank));
}
{ // labels
  assert.equal(rankLabel(R('Ne', 2)), 'NEON II'); assert.equal(rankLabel(R('Ne', 2), true), 'Ne II');
  assert.equal(rankLabel(R('He', 1)), 'HELIUM I'); assert.equal(rankLabel(R('Xe', 3), true), 'Xe III');
}
{ // long walk: always valid, ends pinned at the top / bottom
  let r = defaultRank();
  for (let i = 0; i < 40; i++) { r = applyResult(r, true).rank; assert.ok(ladderIndex(r) >= 0 && r.wins >= 0 && r.wins <= 1); }
  assert.deepEqual([r.tier, r.div, r.wins], ['Xe', 3, 1]);
  for (let i = 0; i < 40; i++) r = applyResult(r, false).rank;
  assert.deepEqual([r.tier, r.div, r.wins], ['He', 1, 0]);
}
{ // normalize untrusted docs
  assert.deepEqual(normalizeRank(null), defaultRank());
  const n = normalizeRank({ tier: 'Zz', div: 9, wins: 99, matches: -4 }); assert.deepEqual([n.tier, n.div, n.wins, n.matches], ['He', 1, 1, 0]);
  assert.equal(normalizeRank({ tier: 'Ne', div: 2, wins: 5 }).wins, 1);
  assert.deepEqual(normalizeRank({ v: 2, tier: 'Ne', div: 3, wins: 1 }).div, 3, 'normalizeRank never converts');
}
{ // migration of stored v1 records (div 3 was the LOWEST): same ladder position, nobody moves; v2 records untouched
  const old = (tier, div, wins) => ({ tier, div, wins, matches: 7, totalWins: 3, updatedAt: 9 }); // no `v`
  const oldLadder = TIER_ORDER.flatMap((tier) => [3, 2, 1].map((div) => ({ tier, div })));   // the v1 order, lowest first
  oldLadder.forEach((s, i) => {
    const m = migrateRank(old(s.tier, s.div, 1));
    assert.equal(ladderIndex(m), i, 'v1 ' + s.tier + s.div + ' keeps its ladder position'); assert.equal(m.v, RANK_VERSION);
    assert.equal(m.wins, 1); assert.equal(m.matches, 7); assert.equal(m.totalWins, 3);
  });
  let m = migrateRank(old('He', 3, 0)); assert.deepEqual([m.tier, m.div], ['He', 1]);          // old lowest -> He 1
  m = migrateRank(old('Xe', 1, 1)); assert.deepEqual([m.tier, m.div, m.wins], ['Xe', 3, 1]);    // old highest -> Xe 3
  m = migrateRank(old('Ne', 2, 0)); assert.deepEqual([m.tier, m.div], ['Ne', 2]);               // the middle stays the middle
  m = migrateRank({ v: 2, tier: 'Ne', div: 3, wins: 0 }); assert.deepEqual([m.tier, m.div], ['Ne', 3], 'current records are not converted again');
  assert.deepEqual(migrateRank(migrateRank(old('He', 3, 0))), migrateRank(old('He', 3, 0)), 'idempotent');
  assert.deepEqual(migrateRank(null), defaultRank()); assert.deepEqual(migrateRank({ tier: 'Qq', div: 3 }), defaultRank());
  // a promotion after migration continues in the new order: old He2 (middle of He) -> He 2 -> win-win -> He 3
  m = migrateRank(old('He', 2, 1)); const w = applyResult(m, true); assert.deepEqual([w.rank.tier, w.rank.div, w.change], ['He', 3, 'promote']);
}
console.log('ranks tests ok');
