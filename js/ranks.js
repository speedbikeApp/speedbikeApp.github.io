// Multiplayer rank ladder (pure, shared by client and server). He3 (lowest) .. Xe1 (highest), 2 wins per division.
// Record: { tier, div, wins, matches, totalWins, updatedAt }.
export const TIER_ORDER = ['He', 'Ne', 'Xe'];
export const TIERS = {
  He: { id: 'He', name: 'HELIUM', short: 'He', color: '#ff9a76' }, // helium discharge: soft orange-pink
  Ne: { id: 'Ne', name: 'NEON', short: 'Ne', color: '#ff4d2e' },   // neon red-orange
  Xe: { id: 'Xe', name: 'XENON', short: 'Xe', color: '#8f7bff' },  // violet-blue
};
export const LADDER = TIER_ORDER.flatMap((tier) => [3, 2, 1].map((div) => ({ tier, div }))); // index 0..8
export const WINS_TO_PROMOTE = 2;
const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

export const defaultRank = () => ({ tier: 'He', div: 3, wins: 0, matches: 0, totalWins: 0, updatedAt: 0 });

export const ladderIndex = (r) => LADDER.findIndex((s) => s.tier === r.tier && s.div === r.div);

// Clean an untrusted record (e.g. a Firestore doc): unknown tier/div -> default, numbers clamped.
export function normalizeRank(raw) {
  const d = defaultRank();
  if (!raw || typeof raw !== 'object') return d;
  const r = { ...d };
  if (TIERS[raw.tier] && [1, 2, 3].includes(raw.div)) { r.tier = raw.tier; r.div = raw.div; }
  const top = ladderIndex(r) === LADDER.length - 1;
  r.wins = Math.min(top ? 1 : WINS_TO_PROMOTE - 1, Math.max(0, Math.floor(Number(raw.wins) || 0)));
  r.matches = Math.max(0, Math.floor(Number(raw.matches) || 0));
  r.totalWins = Math.max(0, Math.floor(Number(raw.totalWins) || 0));
  r.updatedAt = Number(raw.updatedAt) || 0;
  return r;
}

// "NEON II" (short: "Ne II")
export function rankLabel(r, short = false) {
  const t = TIERS[r.tier];
  return `${short ? t.short : t.name} ${ROMAN[r.div]}`;
}

// True when ONE more win promotes into a NEW tier (division 1 with 1 win, not the top tier).
export const isTierPoint = (r) => r.div === 1 && r.wins === 1 && r.tier !== 'Xe';

// Apply a match result. Sole 1st = won. Returns { rank (new object), change: 'promote'|'demote'|'none', tierChange }.
export function applyResult(rank, won, now = Date.now()) {
  const old = normalizeRank(rank);
  const r = { ...old, matches: old.matches + 1, totalWins: old.totalWins + (won ? 1 : 0), updatedAt: now };
  let idx = ladderIndex(r), change = 'none';
  r.wins += won ? 1 : -1;
  if (r.wins >= WINS_TO_PROMOTE) {
    if (idx < LADDER.length - 1) { idx++; r.wins = 0; change = 'promote'; } else r.wins = WINS_TO_PROMOTE - 1; // capped at the top
  } else if (r.wins < 0) {
    if (idx > 0) { idx--; r.wins = WINS_TO_PROMOTE - 1; change = 'demote'; } else r.wins = 0; // floored at the bottom
  }
  r.tier = LADDER[idx].tier; r.div = LADDER[idx].div;
  return { rank: r, change, tierChange: r.tier !== old.tier };
}
