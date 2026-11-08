// Drop table (task5): shared by the client (rolls + opening screen), the server (GET /catalog `drops`, admin DROPS tab) and tests.
// Shape:
//   { tiers: { common|rare|epic: { weight, rewards: [reward] } }, unlimitedOdds, extraChance, loseStreak, winDrops, bonusWinDrops, normalMax, rareMin }
//   reward = { kind: 'coins', amount } | { kind: 'ability', pool: 'normal'|'rare'|'any', count }
// pools: normal = paid abilities priced <= normalMax, rare = priced >= rareMin, any = every paid ability.
// unlimitedOdds: 1 in N per drop for the UNLIMITED (✪) reward, rolled before the tier.
// Earning: a win gives winDrops; a multiplayer win or a win vs HARD bots gives bonusWinDrops; every loseStreak-th loss in a row gives 1;
// every match has extraChance of 1 more drop.
export const TIERS = ['common', 'rare', 'epic'];
export const WEIGHT_RANGE = { common: [60, 75], rare: [10, 25], epic: [4, 12] }; // owner's ranges (task5)
export const POOLS = ['normal', 'rare', 'any'];
export const MAX_REWARDS = 12, MAX_COINS = 1e6, MAX_COUNT = 99;

export const DEFAULT_DROPS = Object.freeze({
  tiers: {
    common: { weight: 70, rewards: [{ kind: 'coins', amount: 100 }, { kind: 'coins', amount: 150 }, { kind: 'coins', amount: 250 }, { kind: 'ability', pool: 'normal', count: 1 }] },
    rare: { weight: 20, rewards: [{ kind: 'coins', amount: 500 }, { kind: 'coins', amount: 1000 }, { kind: 'ability', pool: 'normal', count: 5 }, { kind: 'ability', pool: 'rare', count: 1 }] },
    epic: { weight: 8, rewards: [{ kind: 'coins', amount: 1500 }, { kind: 'coins', amount: 2000 }, { kind: 'coins', amount: 3000 }, { kind: 'ability', pool: 'any', count: 10 }] },
  },
  unlimitedOdds: 10000, extraChance: 0.1, loseStreak: 3, winDrops: 1, bonusWinDrops: 2, normalMax: 400, rareMin: 600,
});

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Returns a clean copy of t, or null if anything is out of range (untrusted: admin input / server response). */
export function validateDrops(t) {
  if (!t || typeof t !== 'object' || !t.tiers || typeof t.tiers !== 'object') return null;
  const out = { tiers: {} };
  for (const k of TIERS) {
    const tier = t.tiers[k], [lo, hi] = WEIGHT_RANGE[k];
    if (!tier || !int(tier.weight, lo, hi) || !Array.isArray(tier.rewards) || !tier.rewards.length || tier.rewards.length > MAX_REWARDS) return null;
    const rewards = [];
    for (const r of tier.rewards) {
      if (r && r.kind === 'coins' && int(r.amount, 1, MAX_COINS)) rewards.push({ kind: 'coins', amount: r.amount });
      else if (r && r.kind === 'ability' && POOLS.includes(r.pool) && int(r.count, 1, MAX_COUNT)) rewards.push({ kind: 'ability', pool: r.pool, count: r.count });
      else return null;
    }
    out.tiers[k] = { weight: tier.weight, rewards };
  }
  if (!int(t.unlimitedOdds, 2, 1e7) || !(typeof t.extraChance === 'number' && t.extraChance >= 0 && t.extraChance <= 1)
    || !int(t.loseStreak, 1, 100) || !int(t.winDrops, 0, 10) || !int(t.bonusWinDrops, 0, 10) || !int(t.normalMax, 0, 1e6) || !int(t.rareMin, 0, 1e6)) return null;
  Object.assign(out, { unlimitedOdds: t.unlimitedOdds, extraChance: t.extraChance, loseStreak: t.loseStreak, winDrops: t.winDrops, bonusWinDrops: t.bonusWinDrops, normalMax: t.normalMax, rareMin: t.rareMin });
  return out;
}

let table = structuredClone(DEFAULT_DROPS);
/** Active table (client). setDropTable ignores invalid input and keeps the current one; returns true if applied. */
export const getDropTable = () => table;
export function setDropTable(t) { const v = validateDrops(t); if (v) table = v; return !!v; }
