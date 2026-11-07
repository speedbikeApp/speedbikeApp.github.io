// Ability system. Pure (no three, no DOM). Registry of definitions + per-bike state helpers.
// Bike fields: abilities[] (equipped ids), activeAbility (index of the slot fired by the hexagon), cd{id: s left},
// active{id: s left}, used{id: true} (once-per-round), slowLeft (own Slow Down), stealth, airTurn.
// All numbers live in CFG.abilities and are read lazily (getters), so tests / tuning can change them at runtime.
import { CFG } from './config.js';

// physics.js registers startBoost / startJump here (avoids an import cycle).
export const hooks = { startBoost: null, startJump: null };

const A = (id) => CFG.abilities[id];

function mk(id, name, short, icon, type, desc, extra = {}) {
  const d = { id, name, short, icon, type, desc };
  Object.defineProperties(d, Object.getOwnPropertyDescriptors(extra)); // keeps getters lazy (spread would snapshot them)
  Object.defineProperties(d, {
    price: { get: () => A(id).price || 0, enumerable: true },
    cooldown: { get: () => A(id).cooldown || 0, enumerable: true },
    duration: { get: () => A(id).duration || 0, enumerable: true },
  });
  return d;
}
const others = (b, state) => state.bikes.filter((o) => o !== b && o.alive);

// onActivate(bike, state) -> false to refuse (cooldown not consumed). onTick(bike, dt) runs every tick while equipped.
// passive `mods`: numbers/booleans combined by modOf().
export const ABILITIES = {
  turbo: mk('turbo', 'Turbo Boost', 'TURBO', '>>>', 'active', 'Dash forward at 2.5x speed for ~125 units. You can still turn.',
    { onActivate: () => true }),
  fastCharge: mk('fastCharge', 'Fast Charge', 'CHARGE', '+', 'passive', 'Boost lasts longer and jump recharges faster.',
    { get mods() { return { boostDuration: A('fastCharge').boostDuration, jumpRecharge: A('fastCharge').jumpRecharge }; } }),
  rocketJump: mk('rocketJump', 'Rocket Jump', 'ROCKET', '^^', 'active', 'Jump twice as high (needs your jump ready).',
    { onActivate: (b) => !!hooks.startJump(b, { height: A('rocketJump').height, timeScale: A('rocketJump').timeScale }) }),
  doubleJump: mk('doubleJump', 'Double Jump', '2xJUMP', '^2', 'passive', 'Jump a second time while airborne.',
    { mods: { doubleJump: true } }),
  airTurn: mk('airTurn', 'Air Turn', 'AIRTURN', '<^>', 'passive', 'Make 90 degree turns in mid-air.',
    { mods: { airTurn: true } }),
  protector: mk('protector', 'Protector', 'SHIELD', '[]', 'active', 'Drive through trails for a few seconds. Walls still kill.',
    { onActivate: () => true }),
  stealth: mk('stealth', 'Stealth', 'STEALTH', '??', 'active', 'Your dot vanishes from opponents\' minimaps.',
    { onActivate: () => true, onTick: (b) => { b.stealth = (b.active.stealth || 0) > 0; } }),
  slowDown: mk('slowDown', 'Slow Down', 'SLOW', 'v', 'active', 'Slows your own bike for a few seconds (tight spaces).',
    { onActivate: (b) => { b.slowLeft = A('slowDown').duration; return true; } }),
  allBoost: mk('allBoost', 'All Boost', 'ALL BOOST', '>>', 'active', 'Forces every other bike to boost. Once per round.',
    { once: true, onActivate: (b, state) => {
      if (!state) return false;
      for (const o of others(b, state)) { o.boostMeter = 1; hooks.startBoost(o); }
      return true; } }),
  allJump: mk('allJump', 'All Jump', 'ALL JUMP', '^^^', 'active', 'Forces every other bike to jump. Once per round.',
    { once: true, onActivate: (b, state) => {
      if (!state) return false;
      for (const o of others(b, state)) { if (o.jumpT >= 0) continue; o.jumpMeter = 1; hooks.startJump(o); }
      return true; } }),
};
export const ABILITY_IDS = Object.keys(ABILITIES);
export const isAbilityId = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(ABILITIES, id);
export const FREE_ABILITIES = () => ABILITY_IDS.filter((id) => ABILITIES[id].price === 0);

// ---- per-bike state ----
export function resetAbilityState(b) {
  if (!b.abilities) { b.abilities = []; b.activeAbility = 0; }
  b.cd = {}; b.active = {}; b.used = {}; b.slowLeft = 0; b.stealth = false;
  b.jumpH = CFG.jump.height; b.jumpTS = 1; b.jumpY0 = 0; b.jumpDur = null; b.djUsed = false;
  b.boostDur = CFG.boost.duration;
  b.airTurn = !!modOf(b, 'airTurn', false);
}

// Combined passive modifier `key` over the equipped abilities (last one wins), else `base`.
export function modOf(b, key, base) {
  let v = base;
  for (const id of b.abilities || []) { const m = ABILITIES[id] && ABILITIES[id].mods; if (m && key in m) v = m[key]; }
  return v;
}
export const boostDuration = (b) => modOf(b, 'boostDuration', CFG.boost.duration);
export const jumpRecharge = (b) => modOf(b, 'jumpRecharge', CFG.jump.recharge);
export const canDoubleJump = (b) => !!modOf(b, 'doubleJump', false);

// Equip a list of ability ids (unknown / duplicate ids dropped, capped at maxSlots). Does not check unlocks.
export function setLoadout(b, ids) {
  const out = [];
  for (const id of ids || []) if (isAbilityId(id) && !out.includes(id) && out.length < CFG.abilities.maxSlots) out.push(id);
  b.abilities = out;
  const first = out.findIndex((id) => ABILITIES[id].type === 'active');
  b.activeAbility = first < 0 ? 0 : first;
  b.airTurn = !!modOf(b, 'airTurn', false);
}
export const activeDef = (b) => { const id = (b.abilities || [])[b.activeAbility]; return id && ABILITIES[id].type === 'active' ? ABILITIES[id] : null; };

// Switch the hexagon to the next equipped active ability. Returns true if it changed.
export function cycleAbility(b) {
  const n = (b.abilities || []).length;
  for (let k = 1; k < n; k++) {
    const i = (b.activeAbility + k) % n;
    if (ABILITIES[b.abilities[i]].type === 'active') { b.activeAbility = i; return true; }
  }
  return false;
}

export const isActive = (b, id) => (b.active && b.active[id] || 0) > 0;
export const isProtected = (b) => isActive(b, 'protector');
// Seconds of trail immunity left (Protector or spawn protection), 0 if none.
export const protectLeft = (b) => Math.max((b.active && b.active.protector) || 0, b.spawnProt || 0);
export const onCooldown = (b, id) => (b.cd[id] || 0) > 0;
export const canUse = (b, id) => !!b.alive && ABILITIES[id].type === 'active' && !onCooldown(b, id) && !(ABILITIES[id].once && b.used[id]);

// Speed multiplier from boost / Turbo (the larger one - they don't stack) and from being slowed.
export function speedMult(b) {
  let m = 1;
  if (b.boosting) m = CFG.boost.mult;
  if (isActive(b, 'turbo')) m = Math.max(m, A('turbo').mult);
  if (b.slowLeft > 0) m *= A('slowDown').mult;
  return m;
}

// Fire the bike's active ability. Returns true if it fired (then cooldown + duration start).
export function useAbility(b, state) {
  const def = activeDef(b);
  if (!def || !canUse(b, def.id)) return false;
  if (def.onActivate(b, state) === false) return false;
  b.cd[def.id] = def.cooldown; b.active[def.id] = def.duration;
  if (def.once) b.used[def.id] = true;
  return true;
}
// Fire a specific equipped active ability (AI).
export function useAbilityId(b, id, state) {
  const i = (b.abilities || []).indexOf(id);
  if (i < 0 || ABILITIES[id].type !== 'active') return false;
  const prev = b.activeAbility; b.activeAbility = i;
  const ok = useAbility(b, state);
  b.activeAbility = prev;
  return ok;
}

// Count down cooldowns / active timers and run onTick hooks. Called once per physics step per alive bike.
export function tickAbilities(b, dt) {
  for (const k in b.cd) if (b.cd[k] > 0) b.cd[k] = Math.max(0, b.cd[k] - dt);
  for (const k in b.active) if (b.active[k] > 0) b.active[k] = Math.max(0, b.active[k] - dt);
  if (b.slowLeft > 0) b.slowLeft = Math.max(0, b.slowLeft - dt);
  for (const id of b.abilities) { const t = ABILITIES[id].onTick; if (t) t(b, dt); }
}
