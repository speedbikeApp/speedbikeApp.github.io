// Leveling system core (no DOM; the visible UI is built on this API). Tables: js/leveldef.js; rewards use js/drops.js.
//   levelInfo(d = getSave()) -> { level, xp, need, max, prestige, prestigePicks, canPrestige }   need = xp per level, canPrestige = level === max
//   xpFor({ won, online }) -> integer xp for a finished match (no side effects)
//   awardXp({ won, online }, rng) -> { gained, levelsUp: [{ level, coins, drop|null }], info }   applies xp + level-up coins / drops to the save and flushes.
//       Level-up reward for level L: coins min(coinsPerLevel * L, coinsMax) + ONE drop: L % 100 -> legendary, else L % 10 -> epic, else L % 5 -> rare.
//       At max level xp stops at need - 1 (the bar stays full, no overflow levels).
//   addXp(n, rng) -> same shape as awardXp for a plain xp amount (quest rewards)
//   prestige() -> { ok, reason? }   reason 'notMax'. level = 1, xp = 0, prestige++, prestigePicks++
//   prestigeChoices(d) -> ability ids eligible for the free unlimited pick (paid, not yet unlimited, not the most expensive one)
//   pickPrestigeUnlimited(id) -> { ok, reason? }   reason 'noPick' | 'notAllowed'. Grants unlimited for free, prestigePicks--
import { ABILITIES, ABILITY_IDS } from './abilities.js';
import { getSave, flushSave } from './save.js';
import { getLevelTable } from './leveldef.js';
import { getDropTable } from './dropdef.js';
import { rollDrop, applyDrop } from './drops.js';

export function levelInfo(d = getSave()) {
  const t = getLevelTable();
  return { level: d.level, xp: d.xp, need: t.xpPerLevel, max: t.maxLevel, prestige: d.prestige, prestigePicks: d.prestigePicks, canPrestige: d.level >= t.maxLevel };
}

export function xpFor({ won, online }) {
  const t = getLevelTable();
  return Math.round((won ? t.xpPerLevel / t.winsPerLevel : t.xpPerLevel / t.gamesPerLevel) * (online ? t.onlineMult : 1));
}

const milestone = (L) => (L % 100 === 0 ? 'legendary' : L % 10 === 0 ? 'epic' : L % 5 === 0 ? 'rare' : null);

export function awardXp({ won, online }, rng = Math.random) {
  const d = getSave(), t = getLevelTable(), gained = xpFor({ won, online }), levelsUp = [];
  d.xp += gained;
  while (d.xp >= t.xpPerLevel && d.level < t.maxLevel) {
    d.xp -= t.xpPerLevel; d.level++;
    const coins = Math.min(t.coinsPerLevel * d.level, t.coinsMax), tier = milestone(d.level);
    d.coins += coins;
    const drop = tier ? rollDrop(d, getDropTable(), rng, tier) : null;
    if (drop) applyDrop(d, drop);
    levelsUp.push({ level: d.level, coins, drop });
  }
  if (d.level >= t.maxLevel) d.xp = t.xpPerLevel - 1; // bar stays full
  flushSave();
  return { gained, levelsUp, info: levelInfo(d) };
}

/** Same level-up rules as awardXp for an arbitrary xp amount (quest rewards); returns the same shape. */
export function addXp(n, rng = Math.random) {
  const d = getSave(), t = getLevelTable(), gained = Math.max(0, Math.floor(n)), levelsUp = [];
  d.xp += gained;
  while (d.xp >= t.xpPerLevel && d.level < t.maxLevel) {
    d.xp -= t.xpPerLevel; d.level++;
    const coins = Math.min(t.coinsPerLevel * d.level, t.coinsMax), tier = milestone(d.level);
    d.coins += coins;
    const drop = tier ? rollDrop(d, getDropTable(), rng, tier) : null;
    if (drop) applyDrop(d, drop);
    levelsUp.push({ level: d.level, coins, drop });
  }
  if (d.level >= t.maxLevel) d.xp = t.xpPerLevel - 1;
  flushSave();
  return { gained, levelsUp, info: levelInfo(d) };
}

export function prestige() {
  const d = getSave();
  if (!levelInfo(d).canPrestige) return { ok: false, reason: 'notMax' };
  d.level = 1; d.xp = 0; d.prestige++; d.prestigePicks++;
  flushSave();
  return { ok: true };
}

export function prestigeChoices(d = getSave()) {
  const paid = ABILITY_IDS.filter((id) => ABILITIES[id].price > 0), top = Math.max(...paid.map((id) => ABILITIES[id].price));
  return paid.filter((id) => ABILITIES[id].price < top && !d.unlocks.abilityInf.includes(id));
}

export function pickPrestigeUnlimited(id) {
  const d = getSave();
  if (d.prestigePicks <= 0) return { ok: false, reason: 'noPick' };
  if (!prestigeChoices(d).includes(id)) return { ok: false, reason: 'notAllowed' };
  d.unlocks.abilityInf.push(id); delete d.unlocks.abilityCount[id]; // same effect as buyInfinite, without the coins
  if (!d.unlocks.abilities.includes(id)) d.unlocks.abilities.push(id);
  d.prestigePicks--;
  flushSave();
  return { ok: true };
}

/** Next level above `level` (up to max) that pays a milestone drop -> { level, tier } | null. Pure. */
export function nextMilestone(level, max = getLevelTable().maxLevel) {
  for (let L = level + 1; L <= max; L++) { const tier = milestone(L); if (tier) return { level: L, tier }; }
  return null;
}
