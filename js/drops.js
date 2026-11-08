// Drops (loot boxes): how many a match earns, what each one holds, and applying it to the save. Logic takes a save-like `d` and an rng
// (default Math.random) so tests can seed it. A drop is {tier, id?, inf?, n?, coins?}: tier = common|rare|epic|unlimited, id = ability,
// inf = unlimited granted, n = charges granted, coins = coins granted (also the half-price value of what did not fit / was already owned).
import { ABILITIES, ABILITY_IDS } from './abilities.js';
import { getSave, flushSave, STACK_MAX, INFINITE_MULT } from './save.js';
import { getDropTable } from './dropdef.js';

const paid = () => ABILITY_IDS.filter((id) => ABILITIES[id].price > 0);
const pick = (a, rng) => a[Math.floor(rng() * a.length) % a.length];
const half = (n) => Math.floor(n / 2);

/** {won, bonus (online or HARD bots), streak (losses in a row before this match)} -> {count, streak after}. */
export function dropsEarned({ won, bonus, streak }, t = getDropTable(), rng = Math.random) {
  let count = 0, s = won ? 0 : streak + 1;
  if (won) count = bonus ? t.bonusWinDrops : t.winDrops;
  else if (s >= t.loseStreak) { count = 1; s = 0; }
  if (rng() < t.extraChance) count++; // every match, win or lose
  return { count, streak: s };
}

/** Decide one drop without changing anything. */
export function rollDrop(d, t = getDropTable(), rng = Math.random) {
  const all = paid(), inf = d.unlocks.abilityInf;
  if (rng() < 1 / t.unlimitedOdds) {
    const left = all.filter((id) => !inf.includes(id));
    if (left.length) return { tier: 'unlimited', id: pick(left, rng), inf: true };
    return { tier: 'unlimited', coins: half(ABILITIES[pick(all, rng)].price * INFINITE_MULT) }; // owns every unlimited already
  }
  let r = rng() * (t.tiers.common.weight + t.tiers.rare.weight + t.tiers.epic.weight), tier = 'epic';
  for (const k of ['common', 'rare']) { if (r < t.tiers[k].weight) { tier = k; break; } r -= t.tiers[k].weight; }
  const rw = pick(t.tiers[tier].rewards, rng);
  if (rw.kind === 'coins') return { tier, coins: rw.amount };
  const pool = all.filter((id) => rw.pool === 'normal' ? ABILITIES[id].price <= t.normalMax : rw.pool === 'rare' ? ABILITIES[id].price >= t.rareMin : true);
  const id = pick(pool.length ? pool : all, rng), price = ABILITIES[id].price;
  if (inf.includes(id)) return { tier, id, n: 0, coins: half(price * rw.count) };
  const fit = Math.min(rw.count, STACK_MAX - (d.unlocks.abilityCount[id] || 0));
  return { tier, id, n: fit, coins: half((rw.count - fit) * price) };
}

/** Apply a rolled drop to the save (keeps the same invariants as save.js clamp). */
export function applyDrop(d, drop) {
  const u = d.unlocks;
  d.coins += drop.coins || 0;
  if (!drop.inf && !drop.n) return;
  if (!u.abilities.includes(drop.id)) u.abilities.push(drop.id);
  if (drop.inf) { u.abilityInf.push(drop.id); delete u.abilityCount[drop.id]; } else u.abilityCount[drop.id] = (u.abilityCount[drop.id] || 0) + drop.n;
}

/** Match end: earn + roll + apply + save right away (quitting cannot lose them). Returns the drops to show. */
export function awardDrops({ won, bonus }, rng = Math.random) {
  const d = getSave(), t = getDropTable(), e = dropsEarned({ won, bonus, streak: d.stats.dropLose }, t, rng), drops = [];
  d.stats.dropLose = e.streak;
  for (let i = 0; i < e.count; i++) { const x = rollDrop(d, t, rng); applyDrop(d, x); drops.push(x); }
  flushSave();
  return drops;
}
