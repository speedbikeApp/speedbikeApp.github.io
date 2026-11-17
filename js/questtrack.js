// Match -> quest progress glue (single player: main.js, online: online.js). Owns the per-match counters; the tutorial drill never calls it.
//   begin()                 new match: clear kill timestamps + the list of quests completed meanwhile
//   kill(t) / death(t)      my kill / my death, t = seconds since GO (match.runTime). kill: kill, early_kill, double_kill (2 within 3 s), triple_kill (3 within 5 s)
//   used('boost_used' | 'jump_used' | 'powerup_used')
//   roundWon()              I won a round (rounds modes)
//   addDistance(units) / flushDistance()   driven distance, written to the quests as whole units
//   matchEnd({ online, rank, deathmatch }) -> [view]   completion counters; returns EVERY quest completed since begin() (for reward.quests)
import { track } from './quests.js';

let kills = [], done = [], carry = 0;
const t = (id, n, p) => { const d = track(id, n, p); if (d.length) done.push(...d); };

export function begin() { kills = []; done = []; }
export function kill(s) {
  if (kills.length && s < kills[kills.length - 1]) kills = []; // runTime restarted: new round
  kills.push(s);
  t('kill'); t('early_kill', 1, s);
  const within = (w) => kills.filter((k) => s - k <= w).length;
  if (within(3) === 2) t('double_kill');
  if (within(5) === 3) t('triple_kill');
}
export function death(s) { t('death'); t('early_death', 1, s); }
export const used = (id) => t(id);
export const roundWon = () => t('round_won');
export function addDistance(u) { carry += u; }
export function flushDistance() { const n = Math.floor(carry); carry -= n; if (n > 0) t('distance', n); }
export function matchEnd({ online, rank, deathmatch }) {
  flushDistance();
  const won = rank === 1;
  t('match_completed'); t(online ? 'multiplayer_game_completed' : 'singleplayer_game_completed'); t(won ? 'win' : 'loss');
  if (won && online) t('multiplayer_win');
  if (won && deathmatch) t('deathmatch_win');
  return done.splice(0);
}
/** level_up: call with the levels gained by awardXp (result.levelsUp.length). */
export const levelUp = (n) => { if (n > 0) t('level_up', n); };
