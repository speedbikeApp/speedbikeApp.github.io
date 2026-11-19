// Server-side bots that fill free seats of an online match (docs/MULTIPLAYER.md "Bots"). They run the same AI as singleplayer
// (js/ai.js) inside the Room. To players they look like players: a gamer-tag name and a display rank near the humans' rank.
// Inside the system they stay bots: bot:true, uid null, the rank is display only (never saved, never settled), no stats, no social.
import { CFG } from '../js/config.js';
import { defaultRank, LADDER, ladderIndex, normalizeRank, WINS_TO_PROMOTE } from '../js/ranks.js';
import { makeRng } from '../js/ai.js';

export const BOT_NAMES = [
  'NeonDrift', 'kai_07', 'VoltRider', 'Zyrex', 'nightowl', 'Pixelfox', 'R4ven', 'ShadowLane', 'turbo_tom', 'Lumen',
  'GridWalker', 'xXFluxXx', 'Mira_k', 'Ghostline', 'ByteRush', 'sp4rk', 'Orion77', 'Kestrel', 'jaxx', 'CyberMoth',
  'Vexa', 'lowkey_leo', 'Quasar', 'NovaByte', 'drift_king', 'Echo_9', 'Saber', 'Tachyon', 'mint_chip', 'Riptide',
  'Zenith', 'h4wk', 'LaserLiz', 'Nyx', 'PhaseShift', 'rookie_ray', 'Cobalt', 'VantaBlack', 'skye_r', 'Helix',
  'Ironclad', 'b0lt', 'Starling', 'GlitchGod', 'arc_light', 'Wraith', 'Pulsar', 'nico_v', 'Static', 'RedLine',
  'Frost_Byte', 'Juno', 'kilowatt', 'Spectre', 'Draxx', 'emberz', 'Overclock', 'Ludo', 'TronJr', 'max_speed',
  'Solace', 'Vortex', 'pine_apple', 'Comet_K', 'Rune', 'ZeroLag', 'Talon', 'yuki_99', 'Mercury', 'Blitz',
  'Onyx', 'wavy_dave', 'Krypt', 'Fennec', 'LightCycle', 'SableX', 'Ozone', 'tiny_titan', 'Vega', 'Ripley',
];
export const BOT_EASY = 0, BOT_MEDIUM = 1, BOT_HARD = 2; // js/ai.js levels (CFG.ai.levels)
export const HARD_FROM_INDEX = 3;                         // average human ladder index >= 3 (Ne 1 and up) -> HARD bots, below -> MEDIUM
export const NEWBIE_MATCHES = 5;                          // every human under this many settled online matches -> EASY bots (so new players win sometimes)

/** Bot difficulty for a lobby: EASY while every human is new, MEDIUM for Helium, HARD once the humans average Neon or better.
 *  Hard bots also carry the singleplayer Hard loadout (CFG.ai.loadouts[2]: Turbo + Protector). */
export function botLevel(humans) {
  const rs = humans.filter((p) => p.rank).map((p) => normalizeRank(p.rank));
  if (!rs.length) return BOT_MEDIUM;
  if (rs.every((r) => r.matches < NEWBIE_MATCHES)) return BOT_EASY;
  return rs.reduce((a, r) => a + ladderIndex(r), 0) / rs.length >= HARD_FROM_INDEX ? BOT_HARD : BOT_MEDIUM;
}

/** Display rank for a bot: a random human's ladder step, or one step above / below. Never stored anywhere. */
export function botRank(humans, rng = Math.random) {
  const rs = humans.filter((p) => p.rank), base = rs.length ? ladderIndex(normalizeRank(rs[Math.floor(rng() * rs.length)].rank)) : 0;
  const idx = Math.max(0, Math.min(LADDER.length - 1, base + Math.floor(rng() * 3) - 1));
  return { ...defaultRank(), ...LADDER[idx], wins: Math.floor(rng() * WINS_TO_PROMOTE) };
}

/** One new bot for a lobby that already holds `humans` and `bots` (name and colour not used by them). */
export function newBot(humans, bots, rng = Math.random, level = botLevel(humans)) {
  const all = [...humans, ...bots], names = BOT_NAMES.filter((n) => !all.some((p) => p.username === n));
  const color = [0, 1, 2, 3].find((c) => !all.some((p) => p.colorIdx === c));
  return { uid: null, username: names[Math.floor(rng() * names.length)], rank: botRank(humans, rng), colorIdx: color ?? all.length % 4, bot: true, level,
    loadout: (CFG.ai.loadouts[level] || []).slice(), send: () => {} };
}

/** Bot entries for the free seats of a match: the bots that already joined the lobby (`have`, difficulty refreshed for the final humans) + new ones. */
export function makeBots(humans, total = 4, seed = (Math.random() * 2 ** 32) >>> 0, have = []) {
  const rng = makeRng(seed), level = botLevel(humans);
  const out = have.slice(0, Math.max(0, total - humans.length)).map((b) => ({ ...b, level, loadout: (CFG.ai.loadouts[level] || []).slice() }));
  while (humans.length + out.length < total) out.push(newBot(humans, out, rng, level));
  return out;
}
