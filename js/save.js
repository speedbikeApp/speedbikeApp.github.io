// Versioned save data in one localStorage key. Every storage access is try/catch; defaults are deep-merged on load so
// missing / corrupt / old data never breaks the game. No DOM; storage is looked up lazily (tests stub globalThis.localStorage).
import { CFG } from './config.js';
import { ABILITIES, ABILITY_IDS, isAbilityId, FREE_ABILITIES } from './abilities.js';
import { CATS, DEFAULT_PARTS, PARTS, getPart, isPartId, freeParts } from './parts.js';
import { getAchievement, newlyEarned } from './achievements.js';

export const KEY = 'speedbike.save.v1';
export const VERSION = 1;
export const NAME_MAX = 12;
export const DEFAULT_NAME = 'PLAYER';

export const defaults = () => ({
  version: VERSION,
  settings: { bloom: CFG.render.bloom.strength, masterVol: CFG.audio.master, musicVol: CFG.audio.music, sfxVol: CFG.audio.sfx,
    muted: false, aiDifficulty: CFG.ai.difficulty, quality: 'high' },
  profile: { username: DEFAULT_NAME },
  coins: 0,
  stats: { matches: 0, wins: 0, winStreak: 0, bestStreak: 0, kills: 0, distance: 0, boosts: 0, jumps: 0,
    bestRoundBoosts: 0, bestRoundJumps: 0, dmFlawless: 0, wins3d: 0, winsHyper: 0 },
  // parts: owned part ids per category (free ones are always present); achievements: earned ids
  unlocks: { abilities: FREE_ABILITIES(), parts: Object.fromEntries(CATS.map((c) => [c, freeParts(c)])), achievements: [] },
  equipped: { abilities: FREE_ABILITIES(), parts: { ...DEFAULT_PARTS } },
});

// Trim, keep letters / digits / space / _ / -, collapse spaces, max NAME_MAX chars; empty -> default.
export function sanitizeName(s) {
  const t = (typeof s === 'string' ? s : '').replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return t || DEFAULT_NAME;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Deep merge `src` onto a clone of `def`: only keys present in def survive for plain-object defaults whose value types
// match; arrays / free-form maps (unlocks.parts, equipped) are kept if the type matches.
function merge(def, src) {
  if (isObj(def)) {
    const out = {};
    const freeForm = Object.keys(def).length === 0;
    if (!isObj(src)) return freeForm ? {} : merge(def, {});
    for (const k of Object.keys(def)) out[k] = merge(def[k], src[k]);
    if (freeForm) for (const k of Object.keys(src)) out[k] = src[k];
    return out;
  }
  if (Array.isArray(def)) return Array.isArray(src) ? src.slice() : [];
  if (typeof def === 'number') return typeof src === 'number' && Number.isFinite(src) ? src : def;
  if (typeof def === 'boolean') return typeof src === 'boolean' ? src : def;
  if (typeof def === 'string') return typeof src === 'string' ? src : def;
  return def;
}

function clamp(d) {
  const s = d.settings, c01 = (v) => Math.min(1, Math.max(0, v));
  s.masterVol = c01(s.masterVol); s.musicVol = c01(s.musicVol); s.sfxVol = c01(s.sfxVol);
  s.bloom = Math.min(3, Math.max(0, s.bloom));
  s.aiDifficulty = Math.min(2, Math.max(0, Math.round(s.aiDifficulty)));
  if (!(s.quality in CFG.quality)) s.quality = 'high';
  d.profile.username = sanitizeName(d.profile.username);
  d.coins = Math.max(0, Math.floor(d.coins));
  // abilities: only known ids; free ones are always unlocked; equipped must be unlocked, unique, <= maxSlots
  const un = new Set(d.unlocks.abilities.filter(isAbilityId));
  for (const id of FREE_ABILITIES()) un.add(id);
  d.unlocks.abilities = ABILITY_IDS.filter((id) => un.has(id));
  const eq = Array.isArray(d.equipped.abilities) ? d.equipped.abilities : FREE_ABILITIES();
  d.equipped.abilities = [...new Set(eq.filter((id) => un.has(id)))].slice(0, CFG.abilities.maxSlots);
  for (const k of Object.keys(d.stats)) d.stats[k] = Math.max(0, d.stats[k]);
  // achievements: known ids only; parts: known ids, free ones always owned; equipped part must be owned else default
  d.unlocks.achievements = [...new Set(d.unlocks.achievements.filter((id) => !!getAchievement(id)))];
  for (const cat of CATS) {
    const own = new Set([...d.unlocks.parts[cat].filter((id) => isPartId(cat, id)), ...freeParts(cat)]);
    d.unlocks.parts[cat] = PARTS[cat].map((p) => p.id).filter((id) => own.has(id));
    const eq = d.equipped.parts[cat];
    d.equipped.parts[cat] = isPartId(cat, eq) && own.has(eq) ? eq : DEFAULT_PARTS[cat];
  }
  return d;
}

export function parseSave(text) {
  let raw = null;
  try { raw = text == null ? null : JSON.parse(text); } catch { raw = null; }
  const d = merge(defaults(), raw);
  // old saves without an equipped list start with the free abilities equipped (an explicit [] stays empty)
  if (!isObj(raw) || !isObj(raw.equipped) || !Array.isArray(raw.equipped.abilities)) d.equipped.abilities = FREE_ABILITIES();
  return clamp(d);
}

let data = null, timer = null;

export function loadSave() {
  let text = null;
  try { text = globalThis.localStorage.getItem(KEY); } catch { text = null; }
  data = parseSave(text);
  return data;
}
export const getSave = () => data || loadSave();

export function flushSave() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!data) return;
  try { globalThis.localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage unavailable / full */ }
}
// Debounced write (call after every mutation).
export function saveSoon(ms = 400) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushSave, ms);
}
export function resetSave() { data = parseSave(null); flushSave(); return data; }

export function setUsername(name) { const d = getSave(); d.profile.username = sanitizeName(name); saveSoon(); return d.profile.username; }
export function setSetting(key, value) { const d = getSave(); d.settings[key] = value; clamp(d); saveSoon(); return d.settings[key]; }

// ---- progression ----
// placement is 1-based. CFG.rewards.coins[placement-1], 0 beyond the list.
export function coinsForPlacement(placement) { return CFG.rewards.coins[placement - 1] || 0; }

// session: {kills, distance, boosts, jumps} accumulated by the player since the last commit (any time, even mid-match).
export function addSessionStats(session) {
  const st = getSave().stats;
  for (const k of ['kills', 'distance', 'boosts', 'jumps']) st[k] += Math.max(0, session[k] || 0);
  const unlocked = checkAchievements();
  if (unlocked.length) flushSave(); else saveSoon();
  return unlocked;
}

// Best single-round counters (round end; Death Match = the whole match). counts: {boosts, jumps}. Returns unlocked ids.
export function recordRound(counts) {
  const st = getSave().stats;
  st.bestRoundBoosts = Math.max(st.bestRoundBoosts, Math.floor(counts.boosts || 0));
  st.bestRoundJumps = Math.max(st.bestRoundJumps, Math.floor(counts.jumps || 0));
  const unlocked = checkAchievements();
  if (unlocked.length) flushSave(); else saveSoon();
  return unlocked;
}

// Record every achievement whose threshold the stats now meet (once each) and unlock its part. Returns the new ids.
export function checkAchievements() {
  const d = getSave(), ids = newlyEarned(d.stats, d.unlocks.achievements);
  for (const id of ids) {
    d.unlocks.achievements.push(id);
    const r = getAchievement(id).reward;
    if (!d.unlocks.parts[r.cat].includes(r.id)) d.unlocks.parts[r.cat].push(r.id);
  }
  if (ids.length) clamp(d);
  return ids;
}

// Match finished: matches / wins / streak + coins. Returns {placement, earned, total, won}.
// bonus = extra coins (Death Match kills: bikeKills * CFG.deathMatch.coinsPerKill).
// info = {mode: 'standard'|'hyper'|'3d'|'deathmatch', flawless: won a Death Match without losing a life}.
// Also returns `unlocked` (achievement ids newly earned).
export function recordMatch(placement, bonus = 0, info = {}) {
  const d = getSave(), st = d.stats, won = placement === 1;
  st.matches++;
  if (won) { st.wins++; st.winStreak++; st.bestStreak = Math.max(st.bestStreak, st.winStreak); } else st.winStreak = 0;
  if (won) {
    if (info.mode === '3d') st.wins3d++;
    if (info.mode === 'hyper') st.winsHyper++;
    if (info.mode === 'deathmatch' && info.flawless) st.dmFlawless++;
  }
  const earned = coinsForPlacement(placement) + Math.max(0, Math.floor(bonus));
  d.coins += earned;
  const unlocked = checkAchievements();
  flushSave(); // important milestone: write right away
  return { placement, earned, total: d.coins, won, unlocked };
}

// ---- abilities ----
// Buy with SBCoins. Returns {ok, reason?}.
export function buyAbility(id) {
  const d = getSave();
  if (!isAbilityId(id)) return { ok: false, reason: 'unknown' };
  if (d.unlocks.abilities.includes(id)) return { ok: false, reason: 'owned' };
  const price = ABILITIES[id].price;
  if (d.coins < price) return { ok: false, reason: 'coins' };
  d.coins -= price; d.unlocks.abilities.push(id);
  clamp(d); flushSave();
  return { ok: true };
}
// Toggle an owned ability in the equipped slots. Returns {ok, equipped, reason?}.
export function toggleEquip(id) {
  const d = getSave(), eq = d.equipped.abilities;
  if (!isAbilityId(id) || !d.unlocks.abilities.includes(id)) return { ok: false, reason: 'locked' };
  const i = eq.indexOf(id);
  if (i >= 0) eq.splice(i, 1);
  else if (eq.length >= CFG.abilities.maxSlots) return { ok: false, reason: 'full' };
  else eq.push(id);
  saveSoon();
  return { ok: true, equipped: i < 0 };
}

// ---- garage parts ----
// Why a part is not owned: {kind:'ach', id} | {kind:'coins', price}; null when owned.
export const partOwned = (cat, id) => getSave().unlocks.parts[cat]?.includes(id) || false;
// Buy a coin part. Achievement parts cannot be bought. Returns {ok, reason?}: unknown | owned | ach | coins.
export function buyPart(cat, id) {
  const d = getSave(), p = getPart(cat, id);
  if (!p) return { ok: false, reason: 'unknown' };
  if (partOwned(cat, id)) return { ok: false, reason: 'owned' };
  if (p.ach) return { ok: false, reason: 'ach' };
  if (d.coins < p.price) return { ok: false, reason: 'coins' };
  d.coins -= p.price; d.unlocks.parts[cat].push(id);
  clamp(d); flushSave();
  return { ok: true };
}
// Equip an owned part. Returns {ok, reason?}.
export function equipPart(cat, id) {
  const d = getSave();
  if (!isPartId(cat, id) || !partOwned(cat, id)) return { ok: false, reason: 'locked' };
  d.equipped.parts[cat] = id; saveSoon();
  return { ok: true };
}
