// Level table (leveling system): shared by the client (js/levels.js), the server (GET /catalog `levels`, admin LEVELS tab) and tests.
//   xpPerLevel: xp needed per level. winsPerLevel / gamesPerLevel: a win gives xpPerLevel / winsPerLevel, any other match xpPerLevel / gamesPerLevel.
//   onlineMult: xp multiplier for online matches. coinsPerLevel: level-up coins = min(coinsPerLevel * level, coinsMax). maxLevel: prestige is possible there.
export const DEFAULT_LEVELS = Object.freeze({ xpPerLevel: 10000, winsPerLevel: 3, gamesPerLevel: 6, onlineMult: 1.5, coinsPerLevel: 100, coinsMax: 4500, maxLevel: 250 });

const RANGES = { xpPerLevel: [100, 1e7], winsPerLevel: [1, 100], gamesPerLevel: [1, 100], coinsPerLevel: [0, 1e5], coinsMax: [0, 1e6], maxLevel: [1, 1000] };

/** Untrusted (admin input / server response) -> {ok, levels} (clean copy) | {ok:false, why: key}. */
export function validateLevels(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'levels' };
  const levels = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const v = raw[k];
    if (!Number.isInteger(v) || v < lo || v > hi) return { ok: false, why: k };
    levels[k] = v;
  }
  const m = raw.onlineMult;
  if (typeof m !== 'number' || !(m >= 1 && m <= 10)) return { ok: false, why: 'onlineMult' };
  levels.onlineMult = m;
  return { ok: true, levels };
}

let table = { ...DEFAULT_LEVELS };
/** Active table (client). setLevelTable ignores invalid input and keeps the current one; returns true if applied. */
export const getLevelTable = () => table;
export function setLevelTable(t) { const v = validateLevels(t); if (v.ok) table = v.levels; return v.ok; }
