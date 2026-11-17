// Quest definitions (no DOM): shared by the client (js/quests.js), the server (GET /catalog `quests` / `event`, admin QUESTS tab) and tests.
// Requirement string: "<id>:<count>" or "<id>(<param>):<count>", e.g. "kill:10", "early_kill(30):1" (REQUIREMENTS below; count 1..100000).
//   double_kill = 2 kills within 3 s; triple_kill ("kill all") = 3 kills within 5 s (js/questtrack.js detects them, any mode).
//   early_kill(S) = a kill at most S s after GO; early_death(S) = dying at most S s after GO.
// Reward string: comma-separated "<type>:<amount>": coins, xp, common_drop | rare_drop | epic_drop | legendary_drop (amount = number of drops),
//   powerup(<abilityId>):<charges>. Example "coins:500,rare_drop:1".
// Quest = { id (short unique), title (<= 40), body (<= 120), requirement, reward }. Text is plain text: show it with textContent only.
// Config = { daily: [pool], weekly: [pool], season: [exactly 10], dailyCount, weeklyCount, seasonMonths }. Event = { id, title, start, end (ms), html (<= 20000, only for a sandboxed iframe), quests: [<= 20] }.
// Periods are UTC: daily = calendar day, weekly = ISO week (Monday), season = seasonMonths-month blocks counted from 2026-01-01 (season 1 = Jan-Feb 2026).
import { ABILITIES, isAbilityId } from './abilities.js';

export const MAX_COUNT = 100000, MAX_PARAM = 3600, SEASON_QUESTS = 10, MAX_POOL = 50, MAX_EVENT_QUESTS = 20, MAX_HTML = 20000, SEASON_EPOCH = Date.UTC(2026, 0, 1);

/** id -> { label(param): what the player does (UI shows "label  progress/count"), param: true when "(<seconds>)" is required }. */
export const REQUIREMENTS = {
  match_completed: { label: () => 'MATCHES PLAYED' },
  singleplayer_game_completed: { label: () => 'SINGLE PLAYER MATCHES PLAYED' },
  multiplayer_game_completed: { label: () => 'MULTIPLAYER MATCHES PLAYED' },
  win: { label: () => 'MATCHES WON' },
  multiplayer_win: { label: () => 'MULTIPLAYER MATCHES WON' },
  loss: { label: () => 'MATCHES LOST' },
  kill: { label: () => 'KILLS' },
  death: { label: () => 'DEATHS' },
  double_kill: { label: () => 'DOUBLE KILLS (2 IN 3 S)' },
  triple_kill: { label: () => 'TRIPLE KILLS (3 IN 5 S)' },
  early_kill: { label: (p) => `KILLS IN THE FIRST ${p} S`, param: true },
  early_death: { label: (p) => `DEATHS IN THE FIRST ${p} S`, param: true },
  round_won: { label: () => 'ROUNDS WON' },
  deathmatch_win: { label: () => 'DEATH MATCHES WON' },
  boost_used: { label: () => 'BOOSTS USED' },
  jump_used: { label: () => 'JUMPS USED' },
  powerup_used: { label: () => 'POWER-UPS USED' },
  distance: { label: () => 'DISTANCE DRIVEN' },
  level_up: { label: () => 'LEVELS GAINED' },
};
export const REWARD_TYPES = ['coins', 'xp', 'common_drop', 'rare_drop', 'epic_drop', 'legendary_drop', 'powerup'];
const REWARD_MAX = { coins: 1e6, xp: 1e6, common_drop: 10, rare_drop: 10, epic_drop: 10, legendary_drop: 10, powerup: 99 };

/** "kill:10" | "early_kill(30):1" -> { id, param: number|null, count } | null. */
export function parseRequirement(s) {
  const m = typeof s === 'string' && /^([a-z_]+)(?:\((\d{1,5})\))?:(\d{1,6})$/.exec(s.trim());
  if (!m || !Object.hasOwn(REQUIREMENTS, m[1])) return null;
  const param = m[2] === undefined ? null : +m[2], count = +m[3];
  if (!!REQUIREMENTS[m[1]].param !== (param !== null) || (param !== null && (param < 1 || param > MAX_PARAM)) || count < 1 || count > MAX_COUNT) return null;
  return { id: m[1], param, count };
}
export const requirementLabel = (r) => REQUIREMENTS[r.id].label(r.param);

/** "coins:500,rare_drop:1,powerup(shield):5" -> [{ type, amount, id? }] (1-4 parts) | null. */
export function parseReward(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split(','), out = [];
  if (parts.length > 4) return null;
  for (const p of parts) {
    const m = /^\s*([a-z_]+)(?:\(([A-Za-z0-9_]{1,24})\))?:(\d{1,7})\s*$/.exec(p);
    if (!m || !REWARD_TYPES.includes(m[1])) return null;
    const amount = +m[3], id = m[2];
    if (amount < 1 || amount > REWARD_MAX[m[1]] || (m[1] === 'powerup') !== (id !== undefined)) return null;
    if (id !== undefined && !(isAbilityId(id) && ABILITIES[id].price > 0)) return null;
    out.push(id === undefined ? { type: m[1], amount } : { type: m[1], amount, id });
  }
  return out;
}

const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
/** Untrusted quest -> { ok, quest } (clean copy) | { ok: false, why }. */
export function validateQuest(q) {
  if (!q || typeof q !== 'object') return { ok: false, why: 'not an object' };
  if (typeof q.id !== 'string' || !ID_RE.test(q.id)) return { ok: false, why: 'id must be 1-24 letters, digits, _ or -' };
  if (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 40) return { ok: false, why: 'title must be 1-40 characters' };
  if (typeof q.body !== 'string' || q.body.length > 120) return { ok: false, why: 'body must be at most 120 characters' };
  if (!parseRequirement(q.requirement)) return { ok: false, why: `bad requirement "${q.requirement}" (known ids: ${Object.keys(REQUIREMENTS).join(', ')})` };
  if (!parseReward(q.reward)) return { ok: false, why: `bad reward "${q.reward}" (e.g. coins:500,rare_drop:1)` };
  return { ok: true, quest: { id: q.id, title: q.title.trim(), body: q.body, requirement: q.requirement.trim(), reward: q.reward.trim() } };
}
function validateList(list, name, min, max, seen) {
  if (!Array.isArray(list) || list.length < min || list.length > max) return { ok: false, why: `${name} must be a list of ${min === max ? min : `${min}-${max}`} quests` };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const v = validateQuest(list[i]);
    if (!v.ok) return { ok: false, why: `${name}[${i}]${list[i] && list[i].id ? ` "${list[i].id}"` : ''}: ${v.why}` };
    if (seen.has(v.quest.id)) return { ok: false, why: `${name}[${i}]: duplicate id "${v.quest.id}"` };
    seen.add(v.quest.id); out.push(v.quest);
  }
  return { ok: true, list: out };
}
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Untrusted config -> { ok, config } (clean copy) | { ok: false, why: readable text naming the quest and the problem }. Quest ids are unique across the whole config. */
export function validateQuestConfig(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'config must be an object' };
  for (const [k, lo, hi] of [['dailyCount', 1, 10], ['weeklyCount', 1, 10], ['seasonMonths', 1, 12]]) if (!int(raw[k], lo, hi)) return { ok: false, why: `${k} must be a whole number ${lo}-${hi}` };
  const seen = new Set(), config = { dailyCount: raw.dailyCount, weeklyCount: raw.weeklyCount, seasonMonths: raw.seasonMonths };
  for (const [k, min, max] of [['daily', raw.dailyCount, MAX_POOL], ['weekly', raw.weeklyCount, MAX_POOL], ['season', SEASON_QUESTS, SEASON_QUESTS]]) {
    const v = validateList(raw[k], k, min, max, seen);
    if (!v.ok) return v;
    config[k] = v.list;
  }
  return { ok: true, config };
}

/** Untrusted event -> { ok, event } | { ok: false, why }. */
export function validateEvent(e) {
  if (!e || typeof e !== 'object') return { ok: false, why: 'event must be an object' };
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return { ok: false, why: 'id must be 1-24 letters, digits, _ or -' };
  if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > 40) return { ok: false, why: 'title must be 1-40 characters' };
  if (!int(e.start, 0, 4e12) || !int(e.end, 0, 4e12) || e.end <= e.start) return { ok: false, why: 'start / end must be ms timestamps with end after start' };
  if (typeof e.html !== 'string' || e.html.length > MAX_HTML) return { ok: false, why: `html must be a string of at most ${MAX_HTML} characters` };
  const v = validateList(e.quests, 'quests', 0, MAX_EVENT_QUESTS, new Set());
  if (!v.ok) return v;
  return { ok: true, event: { id: e.id, title: e.title.trim(), start: e.start, end: e.end, html: e.html, quests: v.list } };
}
export const eventActive = (e, now = Date.now()) => !!e && e.start <= now && now < e.end;

const Q = (id, title, body, requirement, reward) => ({ id, title, body, requirement, reward });
export const DEFAULT_QUESTS = Object.freeze({
  daily: [
    Q('d_play3', 'WARM UP', 'Finish 3 matches.', 'match_completed:3', 'coins:200'),
    Q('d_solo3', 'SOLO RUN', 'Finish 3 single player matches.', 'singleplayer_game_completed:3', 'coins:200'),
    Q('d_online', 'ONLINE DEBUT', 'Finish a multiplayer match.', 'multiplayer_game_completed:1', 'coins:300'),
    Q('d_win', 'WINNER', 'Win a match.', 'win:1', 'common_drop:1'),
    Q('d_kill3', 'FIRST BLOOD', 'Take down 3 bikes.', 'kill:3', 'xp:1500'),
    Q('d_early', 'QUICK DRAW', 'Get a kill in the first 30 seconds.', 'early_kill(30):1', 'common_drop:1'),
    Q('d_double', 'DOUBLE TROUBLE', 'Get 2 kills within 3 seconds.', 'double_kill:1', 'coins:400'),
    Q('d_rounds', 'ROUND KING', 'Win 3 rounds.', 'round_won:3', 'xp:2000'),
    Q('d_boost', 'NITRO HEAD', 'Use boost 15 times.', 'boost_used:15', 'xp:1000'),
    Q('d_jump', 'AIR TIME', 'Jump 15 times.', 'jump_used:15', 'xp:1000'),
    Q('d_power', 'POWER TRIP', 'Use 3 power-ups.', 'powerup_used:3', 'coins:250'),
    Q('d_road', 'ROAD HOG', 'Drive 5000 units.', 'distance:5000', 'coins:150'),
  ],
  weekly: [
    Q('w_win5', 'ON A ROLL', 'Win 5 matches.', 'win:5', 'rare_drop:1'),
    Q('w_online2', 'NET CHAMP', 'Win 2 multiplayer matches.', 'multiplayer_win:2', 'rare_drop:1'),
    Q('w_kill40', 'HUNTER', 'Take down 40 bikes.', 'kill:40', 'coins:1000'),
    Q('w_play20', 'REGULAR', 'Finish 20 matches.', 'match_completed:20', 'xp:6000'),
    Q('w_dm', 'DEATH WISH', 'Win a Death Match.', 'deathmatch_win:1', 'rare_drop:1'),
    Q('w_triple', 'CLEAN SWEEP', 'Get 3 kills within 5 seconds.', 'triple_kill:1', 'epic_drop:1'),
    Q('w_far', 'LONG HAUL', 'Drive 40000 units.', 'distance:40000', 'coins:800'),
    Q('w_level', 'LEVEL UP', 'Gain a level.', 'level_up:1', 'coins:500'),
  ],
  season: [
    Q('s_win50', 'CHAMPION', 'Win 50 matches.', 'win:50', 'rare_drop:2'),
    Q('s_kill500', 'EXTERMINATOR', 'Take down 500 bikes.', 'kill:500', 'epic_drop:1'),
    Q('s_play150', 'DEDICATED', 'Finish 150 matches.', 'match_completed:150', 'coins:5000'),
    Q('s_online25', 'ONLINE LEGEND', 'Win 25 multiplayer matches.', 'multiplayer_win:25', 'epic_drop:1'),
    Q('s_dm10', 'ARENA MASTER', 'Win 10 Death Matches.', 'deathmatch_win:10', 'rare_drop:2'),
    Q('s_triple10', 'UNSTOPPABLE', 'Get 10 triple kills.', 'triple_kill:10', 'epic_drop:1'),
    Q('s_early10', 'FAST HANDS', 'Get 10 kills in the first 10 seconds.', 'early_kill(10):10', 'rare_drop:1,coins:1000'),
    Q('s_road', 'ENDLESS ROAD', 'Drive 90000 units.', 'distance:90000', 'coins:5000'),
    Q('s_boost', 'SPEED DEMON', 'Use boost 500 times.', 'boost_used:500', 'rare_drop:1'),
    Q('s_level5', 'CLIMBER', 'Gain 5 levels.', 'level_up:5', 'legendary_drop:1'),
  ],
  dailyCount: 3, weeklyCount: 2, seasonMonths: 2,
});
export const DEFAULT_EVENT = null;

let config = structuredClone(DEFAULT_QUESTS), event = DEFAULT_EVENT;
/** Active config (client). setQuestConfig ignores invalid input and keeps the current one; returns true if applied. */
export const getQuestConfig = () => config;
export function setQuestConfig(c) { const v = validateQuestConfig(c); if (v.ok) config = v.config; return v.ok; }
/** The event the server currently offers (or null). setEvent(null) clears; invalid input is ignored (returns false). */
export const getEvent = () => event;
export function setEvent(e) { if (e === null || e === undefined) { event = null; return true; } const v = validateEvent(e); if (v.ok) event = v.event; return v.ok; }

// ---- periods (UTC) ----
const DAY = 86400000;
const dayStart = (now) => Math.floor(now / DAY) * DAY;
export const dailyKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const weekStart = (now = Date.now()) => dayStart(now) - ((new Date(now).getUTCDay() + 6) % 7) * DAY;
export function weeklyKey(now = Date.now()) {
  const thu = new Date(weekStart(now) + 3 * DAY), y = thu.getUTCFullYear(); // the ISO year is the year of the week's Thursday
  return `${y}-W${String(Math.floor((thu - Date.UTC(y, 0, 1)) / DAY / 7) + 1).padStart(2, '0')}`;
}
const monthsSince = (now) => { const d = new Date(now); return (d.getUTCFullYear() - 2026) * 12 + d.getUTCMonth(); };
export const seasonKey = (now = Date.now(), months = config.seasonMonths) => Math.floor(monthsSince(now) / months) + 1;
export const seasonStart = (now = Date.now(), months = config.seasonMonths) => Date.UTC(2026, (seasonKey(now, months) - 1) * months, 1);
export const seasonEnd = (now = Date.now(), months = config.seasonMonths) => Date.UTC(2026, seasonKey(now, months) * months, 1);
export const nextDailyReset = (now = Date.now()) => dayStart(now) + DAY;
export const nextWeeklyReset = (now = Date.now()) => weekStart(now) + 7 * DAY;
export const nextSeasonReset = seasonEnd;
/** Block key stored in the save: sorts like time ('2026-11-17', '2026-W47', '007'), so the newer period is the larger string. */
export const periodKey = (kind, now = Date.now()) => (kind === 'daily' ? dailyKey(now) : kind === 'weekly' ? weeklyKey(now) : String(seasonKey(now)).padStart(3, '0'));

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
/** `count` quests from `pool`, the same for everybody for one period key (seeded partial shuffle). */
export function pickQuests(pool, count, key) {
  let a = hash(key) || 1;
  const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; // mulberry32
  const idx = pool.map((_, i) => i);
  for (let i = 0; i < Math.min(count, idx.length); i++) { const j = i + Math.floor(rnd() * (idx.length - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, count).map((i) => pool[i]);
}
export const dailyQuests = (now = Date.now(), c = config) => pickQuests(c.daily, c.dailyCount, dailyKey(now));
export const weeklyQuests = (now = Date.now(), c = config) => pickQuests(c.weekly, c.weeklyCount, weeklyKey(now));

// ---- save block (d.quests): daily / weekly / season = { key, p: {questId: progress}, c: [claimed ids] }; event = { id, p, c } ----
export const emptyQuestsSave = () => ({ daily: { key: '', p: {}, c: [] }, weekly: { key: '', p: {}, c: [] }, season: { key: '', p: {}, c: [] }, event: { id: '', p: {}, c: [] } });
export const KINDS = ['daily', 'weekly', 'season', 'event'];
export const keyField = (kind) => (kind === 'event' ? 'id' : 'key');
const cleanBlock = (b, kf) => {
  const o = { [kf]: typeof b?.[kf] === 'string' ? b[kf].slice(0, 24) : '', p: {}, c: [] };
  if (b && b.p && typeof b.p === 'object') for (const [k, v] of Object.entries(b.p).slice(0, 60)) if (ID_RE.test(k) && Number.isFinite(v)) o.p[k] = Math.min(MAX_COUNT, Math.max(0, Math.floor(v)));
  if (b && Array.isArray(b.c)) o.c = [...new Set(b.c.filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, 60);
  return o;
};
/** Any value -> a well-formed d.quests (untrusted: local storage / cloud). */
export function cleanQuestsSave(q) { const o = {}; for (const k of KINDS) o[k] = cleanBlock(q && q[k], keyField(k)); return o; }

/** Cloud merge: same period -> per-quest max progress + union of claimed; different -> the newer period (larger key) wins; events: `preferA` (the newer save) wins. */
export function mergeQuests(a, b, preferA = true) {
  const x = cleanQuestsSave(a), y = cleanQuestsSave(b), out = {};
  for (const k of KINDS) {
    const kf = keyField(k), p = x[k], q = y[k];
    if (p[kf] !== q[kf]) { out[k] = k === 'event' ? (preferA ? p : q) : p[kf] > q[kf] ? p : q; continue; }
    const m = { [kf]: p[kf], p: { ...p.p }, c: [...new Set([...p.c, ...q.c])] };
    for (const [id, n] of Object.entries(q.p)) m.p[id] = Math.max(m.p[id] || 0, n);
    out[k] = m;
  }
  return out;
}
