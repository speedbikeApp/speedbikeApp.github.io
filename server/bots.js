// Server-side bots that fill a lobby up to 4 bikes when the countdown ends (docs/MULTIPLAYER.md "Bots").
// They run the same AI as singleplayer (js/ai.js) inside the Room. Bots have names, no uid and no rank: they are opponents
// only (a human who beats them still wins; they never get a rank record and are never settled).
import { CFG } from '../js/config.js';
import { ladderIndex, normalizeRank } from '../js/ranks.js';
import { makeRng } from '../js/ai.js';

export const BOT_NAMES = ['Nova', 'Pulse', 'Flux', 'Volt', 'Arc', 'Echo', 'Zap', 'Orbit', 'Quark', 'Ion', 'Photon', 'Vector', 'Comet', 'Prism'];
export const BOT_PREFIX = 'BOT ';
export const BOT_MEDIUM = 1, BOT_HARD = 2;       // js/ai.js levels (CFG.ai.levels)
export const HARD_FROM_INDEX = 3;                // average human ladder index >= 3 (Ne 1 and up) -> HARD bots, below -> MEDIUM

/** Bot difficulty for a lobby: MEDIUM for Helium players, HARD once the humans average Neon or better. Hard bots also
 *  carry the singleplayer Hard loadout (CFG.ai.loadouts[2]: Turbo + Protector). */
export function botLevel(humans) {
  const idx = humans.filter((p) => p.rank).map((p) => ladderIndex(normalizeRank(p.rank)));
  if (!idx.length) return BOT_MEDIUM;
  return idx.reduce((a, b) => a + b, 0) / idx.length >= HARD_FROM_INDEX ? BOT_HARD : BOT_MEDIUM;
}

/** Bot player entries for the free slots of a lobby (humans: player objects with colorIdx / rank / username). */
export function makeBots(humans, total = 4, seed = (Math.random() * 2 ** 32) >>> 0) {
  const need = Math.max(0, total - humans.length), rng = makeRng(seed), level = botLevel(humans);
  const colors = [0, 1, 2, 3].filter((c) => !humans.some((p) => p.colorIdx === c));
  const names = BOT_NAMES.slice(); // shuffled pick, no repeats inside a match
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  return Array.from({ length: need }, (_, i) => ({
    uid: null, username: BOT_PREFIX + names[i], rank: null, colorIdx: colors[i] ?? (humans.length + i) % 4, bot: true, level,
    loadout: (CFG.ai.loadouts[level] || []).slice(), send: () => {},
  }));
}
