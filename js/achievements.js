// Achievements: pure data + checks over the save's stats (no DOM, no three). Each reads ONE number from `stats`
// (`value`) and unlocks when value >= target; the reward is a garage part. Round-scoped ones read the best-in-one-round
// counters that save.js keeps (bestRoundBoosts / bestRoundJumps); match-scoped ones read counters bumped by recordMatch.
export const ACHIEVEMENTS = [
  { id: 'boost5', name: 'Boost Junkie', desc: 'Boost 5 times in one round', target: 5, stat: 'bestRoundBoosts', reward: { cat: 'rim', id: 'triblade' } },
  { id: 'jump5', name: 'Sky Rider', desc: 'Jump 5 times in one round', target: 5, stat: 'bestRoundJumps', reward: { cat: 'rim', id: 'ring' } },
  { id: 'kills100', name: 'Trail Hunter', desc: 'Get 100 trail kills', target: 100, stat: 'kills', reward: { cat: 'rim', id: 'turbine' } },
  { id: 'streak10', name: 'Unstoppable', desc: 'Win 10 matches in a row', target: 10, stat: 'bestStreak', reward: { cat: 'body', id: 'wedge' } },
  { id: 'wins100', name: 'Centurion', desc: 'Win 100 matches', target: 100, stat: 'wins', reward: { cat: 'body', id: 'apex' } },
  { id: 'dist50k', name: 'Long Haul', desc: 'Travel 50,000 units', target: 50000, stat: 'distance', reward: { cat: 'tire', id: 'knobby' } },
  { id: 'flawless', name: 'Untouchable', desc: 'Win a Death Match without losing a life', target: 1, stat: 'dmFlawless', reward: { cat: 'glow', id: 'gold' } },
  { id: 'win3d', name: 'Third Dimension', desc: 'Win a 3D match', target: 1, stat: 'wins3d', reward: { cat: 'glow', id: 'mint' } },
  { id: 'hyperWin', name: 'Hyper Drive', desc: 'Win a Hyper match', target: 1, stat: 'winsHyper', reward: { cat: 'tire', id: 'dual' } },
];
export const getAchievement = (id) => ACHIEVEMENTS.find((a) => a.id === id) || null;
export const isAchievementId = (id) => ACHIEVEMENTS.some((a) => a.id === id);
export const achValue = (a, stats) => Math.max(0, +stats[a.stat] || 0);
export const achProgress = (a, stats) => Math.min(1, achValue(a, stats) / a.target);

// Ids of achievements whose threshold is met by `stats` and that are not in `owned` (array / Set of ids) yet.
// Pure: the caller records them (save.js checkAchievements) so each fires exactly once.
export function newlyEarned(stats, owned) {
  const have = owned instanceof Set ? owned : new Set(owned);
  return ACHIEVEMENTS.filter((a) => !have.has(a.id) && achValue(a, stats) >= a.target).map((a) => a.id);
}
