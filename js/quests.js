// Quests (client, state in the save: d.quests, synced with the account). Definitions / periods / parsers: js/questdef.js. Match hooks: js/questtrack.js.
// API (for the QUESTS page):
//   track(id, amount = 1, param = null) -> [view]   add progress to every ACTIVE quest (today's dailies, this week's weeklies, this season's 10, the running
//        event's) whose requirement id is `id`. Param requirements: early_kill(S) / early_death(S) count when param <= S (track('early_kill', 1, secondsAfterGo)).
//        Progress stops at the quest's count. Returns the views of the quests that just became complete (for toasts). Saves soon.
//   questsView(now = Date.now()) -> { daily: [view], weekly: [view], season: [view], event: { id, title, start, end, html, active, quests: [view] } | null (active false = starts later: no progress, no claim),
//        resets: { daily, weekly, season } (ms) }   view = { key, kind: 'daily'|'weekly'|'season'|'event', quest: {id,title,body,requirement,reward}, progress, count, done, claimed }.
//        key is unique per period, e.g. 'd:2026-11-17:d_win', 'w:2026-W47:..', 's:006:..', 'e:<eventId>:..'. A period change resets that block when it is read / tracked.
//        event.html is admin-written: show it ONLY in a sandboxed iframe (sandbox="" + srcdoc), never innerHTML. Quest text: textContent.
//   claim(key, { rng, now } = {}) -> { ok, reason?, rewards: [{ type, amount, id?, drop?, levelsUp? }] }   reason: 'unknown' | 'notDone' | 'claimed'.
//        coins: coins; xp: addXp (levelsUp = its level-ups); *_drop: one entry per drop with `drop` (see js/drops.js; apply already done);
//        powerup(id): charges (drop = {id, n, coins}: what did not fit under the 99 cap is paid as half-price coins). A quest is claimable once per period.
//   requirementLabel(parseRequirement(quest.requirement)) / parseReward(quest.reward) (questdef.js) give the texts for the cards.
import { getSave, saveSoon, flushSave, STACK_MAX } from './save.js';
import { ABILITIES } from './abilities.js';
import { getQuestConfig, getEvent, eventActive, dailyQuests, weeklyQuests, parseRequirement, parseReward, periodKey, keyField, nextDailyReset, nextWeeklyReset, nextSeasonReset } from './questdef.js';
import { addXp } from './levels.js';
import { rollDrop, applyDrop } from './drops.js';
import { getDropTable } from './dropdef.js';

const PREFIX = { daily: 'd', weekly: 'w', season: 's', event: 'e' };
const reqCache = new Map();
const reqOf = (q) => { let r = reqCache.get(q.requirement); if (!r) reqCache.set(q.requirement, (r = parseRequirement(q.requirement))); return r; };

/** The save block of a period, reset first when its period changed (event: when another event runs). null = no event running. */
function block(kind, now, ev) {
  const q = getSave().quests, kf = keyField(kind), want = kind === 'event' ? (ev ? ev.id : null) : periodKey(kind, now);
  if (want === null) return null;
  if (q[kind][kf] !== want) { q[kind] = { [kf]: want, p: {}, c: [] }; saveSoon(); }
  return q[kind];
}

/** Every active quest as a view, flat (+ the event). */
function entries(now) {
  const cfg = getQuestConfig(), e = getEvent(), ev = eventActive(e, now) ? e : null, out = [];
  for (const [kind, list] of [['daily', dailyQuests(now, cfg)], ['weekly', weeklyQuests(now, cfg)], ['season', cfg.season], ['event', ev ? ev.quests : []]]) {
    const b = block(kind, now, ev);
    if (!b) continue;
    for (const quest of list) {
      const count = reqOf(quest).count, progress = Math.min(count, b.p[quest.id] || 0);
      out.push({ key: `${PREFIX[kind]}:${b[keyField(kind)]}:${quest.id}`, kind, quest, progress, count, done: progress >= count, claimed: b.c.includes(quest.id), b });
    }
  }
  return { list: out, ev };
}
const pub = ({ b, ...v }) => v; // the save block stays internal

export function track(id, amount = 1, param = null, now = Date.now()) {
  amount = Math.floor(amount);
  if (!(amount > 0)) return [];
  const done = [];
  for (const v of entries(now).list) {
    const r = reqOf(v.quest);
    if (r.id !== id || v.done || (r.param !== null && !(param !== null && param <= r.param))) continue;
    v.b.p[v.quest.id] = Math.min(v.count, v.progress + amount);
    if (v.progress + amount >= v.count) done.push(pub({ ...v, progress: v.count, done: true }));
  }
  if (done.length) flushSave(); else saveSoon();
  return done;
}

/** An event that has not started yet: shown (countdown + quest cubes) but never tracked or claimable. */
function upcoming(now) {
  const e = getEvent(); if (!e || e.start <= now) return null;
  const quests = e.quests.map((quest) => ({ key: `e:${e.id}:${quest.id}`, kind: 'event', quest, progress: 0, count: reqOf(quest).count, done: false, claimed: false }));
  return { id: e.id, title: e.title, start: e.start, end: e.end, html: e.html, active: false, quests };
}

export function questsView(now = Date.now()) {
  const { list, ev } = entries(now), of = (k) => list.filter((v) => v.kind === k).map(pub);
  return {
    daily: of('daily'), weekly: of('weekly'), season: of('season'),
    event: ev ? { id: ev.id, title: ev.title, start: ev.start, end: ev.end, html: ev.html, active: true, quests: of('event') } : upcoming(now),
    resets: { daily: nextDailyReset(now), weekly: nextWeeklyReset(now), season: nextSeasonReset(now) },
  };
}

export function claim(key, { rng = Math.random, now = Date.now() } = {}) {
  const v = entries(now).list.find((x) => x.key === key);
  if (!v) return { ok: false, reason: 'unknown', rewards: [] };
  if (v.claimed) return { ok: false, reason: 'claimed', rewards: [] };
  if (!v.done) return { ok: false, reason: 'notDone', rewards: [] };
  v.b.c.push(v.quest.id); // first: a crash while paying out can only lose the reward, never pay twice
  const d = getSave(), rewards = [];
  for (const r of parseReward(v.quest.reward)) {
    if (r.type === 'coins') { d.coins += r.amount; rewards.push({ type: 'coins', amount: r.amount }); }
    else if (r.type === 'xp') { const x = addXp(r.amount, rng); rewards.push({ type: 'xp', amount: r.amount, levelsUp: x.levelsUp }); }
    else if (r.type === 'powerup') {
      const have = d.unlocks.abilityInf.includes(r.id) ? STACK_MAX : d.unlocks.abilityCount[r.id] || 0, fit = Math.min(r.amount, STACK_MAX - have);
      const drop = { tier: 'common', id: r.id, n: fit, coins: Math.floor(((r.amount - fit) * ABILITIES[r.id].price) / 2) };
      applyDrop(d, drop); rewards.push({ type: 'powerup', amount: r.amount, id: r.id, drop });
    } else for (let i = 0; i < r.amount; i++) {
      const drop = rollDrop(d, getDropTable(), rng, r.type.slice(0, -5)); // 'rare_drop' -> 'rare'
      applyDrop(d, drop); rewards.push({ type: r.type, amount: 1, drop });
    }
  }
  flushSave();
  return { ok: true, rewards };
}
