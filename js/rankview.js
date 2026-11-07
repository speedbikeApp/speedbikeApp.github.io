// Rank badge formatting (pure; HTML strings use only escaped / controlled text). Shared by the multiplayer menus and the HUD.
// Badge = tier symbol (He / Ne / Xe) in the tier colour + roman division + 2 win pips (filled = wins).
import { TIERS, defaultRank, normalizeRank, ladderIndex, LADDER } from './ranks.js';

const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** {sym, roman, wins, pips:[bool,bool], color, tierName, label, shortLabel, top, index} for a rank record (garbage -> default He III). */
export function badgeInfo(rank) {
  const r = normalizeRank(rank || defaultRank()), t = TIERS[r.tier];
  const top = ladderIndex(r) === LADDER.length - 1;
  return {
    sym: t.short, roman: ROMAN[r.div], wins: r.wins, pips: [r.wins >= 1, r.wins >= 2], color: t.color, tierName: t.name,
    label: `${t.name} ${ROMAN[r.div]}`, shortLabel: `${t.short} ${ROMAN[r.div]}`, top, index: ladderIndex(r),
  };
}

/** Small inline badge: `<span class="rb" style="--rc:#..."><b>Ne</b><i>II</i><u class="on"></u><u></u></span>`. */
export function badgeHtml(rank, extraClass = '') {
  const b = badgeInfo(rank);
  const pips = b.pips.map((on) => `<u${on ? ' class="on"' : ''}></u>`).join('');
  return `<span class="rb${extraClass ? ' ' + esc(extraClass) : ''}" style="--rc:${esc(b.color)}" title="${esc(b.label)}"><b>${esc(b.sym)}</b><i>${b.roman}</i><s>${pips}</s></span>`;
}

/** "mm:ss" for a millisecond span (clamped at 0). */
export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Rank change summary for the end screen: {pipDelta:-1|0|1, banner:'PROMOTED'|'DEMOTED'|'', before, after, tierUp}. */
export function rankChange(before, after, change) {
  const b = normalizeRank(before), a = normalizeRank(after);
  const bi = ladderIndex(b), ai = ladderIndex(a);
  let pipDelta = 0;
  if (ai > bi || (ai === bi && a.wins > b.wins)) pipDelta = 1;
  else if (ai < bi || (ai === bi && a.wins < b.wins)) pipDelta = -1;
  const banner = change === 'promote' || ai > bi ? 'PROMOTED' : change === 'demote' || ai < bi ? 'DEMOTED' : '';
  return { pipDelta, banner, before: b, after: a, tierUp: a.tier !== b.tier && ai > bi };
}
