// Applies match results to the rank store and works out the global announcements.
import { applyResult, isTierPoint, ladderIndex, LADDER, TIERS } from '../js/ranks.js';

// Announcements caused by a rank change (before -> after) of one player.
export function announcementsFor(name, before, after, change) {
  const out = [];
  if (change === 'promote' && after.tier !== before.tier) out.push({ kind: 'tierUp', text: `${name} reached ${TIERS[after.tier].name}!` });
  else if (!isTierPoint(before) && isTierPoint(after)) {
    const next = LADDER[ladderIndex(after) + 1].tier; // isTierPoint guarantees it exists
    out.push({ kind: 'tierPoint', text: `${name} is one win from ${TIERS[next].name}!` });
  }
  return out;
}

// entries: [{ id, uid, username, place, won }]. Persists each and returns { ranks, announcements } (`ranks` = the `end` payload).
export async function settleMatch(store, entries, now = Date.now()) {
  const ranks = [], announcements = [];
  for (const e of entries) {
    const rankBefore = await store.getRank(e.uid);
    const { rank: rankAfter, change } = applyResult(rankBefore, e.won, now);
    await store.setRank(e.uid, rankAfter, e.username);
    ranks.push({ id: e.id, uid: e.uid, place: e.place, won: e.won, rankBefore, rankAfter, change });
    announcements.push(...announcementsFor(e.username, rankBefore, rankAfter, change));
  }
  return { ranks, announcements };
}
