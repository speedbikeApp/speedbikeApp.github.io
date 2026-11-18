// QUESTS screen (main menu QUESTS button): tabs QUESTS | SEASON | EVENT, claim buttons, timers. DOM only; logic is quests.js, texts questtext.js.
// Quest text goes in via textContent; the admin's event html lives only in a sandboxed iframe (no scripts, no same-origin).
import { questsView, claim } from './quests.js';
import { parseRequirement, requirementLabel } from './questdef.js';
import { rewardText, hms, dh, daysLeft, unclaimedCount } from './questtext.js';
import { dropBack, showAnnounce } from './hud.js';
import { getSave } from './save.js';
import { refreshProfile } from './profile-ui.js';

const $ = (id) => document.getElementById(id);
let tab = 'quests', shownEvent = null; // shownEvent: id rendered in the EVENT tab (null = none), to re-render when it ends / starts
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function row(v) { // one quest cube: title, requirement + progress, bar, reward (+ CLAIM)
  const r = el('div', 'qRow frame' + (v.done ? ' done' : ''));
  const bar = el('div', 'bar'), fill = el('i'); fill.style.width = Math.round((v.progress / v.count) * 100) + '%'; bar.append(fill);
  const req = parseRequirement(v.quest.requirement), rw = el('div', 'qRw'); rw.append(el('span', '', rewardText(v.quest.reward)));
  if (v.done && !v.claimed) { const b = el('button', 'mbtn frame primary qClaim', 'CLAIM'); b.type = 'button'; b.dataset.key = v.key; rw.append(b); }
  r.append(el('b', 'qTtl', v.quest.title.toUpperCase() + (v.kind === 'weekly' ? ' (WEEKLY)' : '')), el('small', '', v.quest.body || (req ? requirementLabel(req) : '')), el('span', 'tag', v.claimed ? 'CLAIMED' : `${v.progress} / ${v.count}`), bar, rw);
  return r;
}
const grid = (list) => { const g = el('div', 'qGrid'); g.append(...list.map(row)); return g; };
const head = (title, timer) => { const h = el('div', 'lbl'), t = el('span', 'qTimer'); h.append(title + ' ', t); t.dataset.t = timer; return h; };
const section = (heads, list) => { const s = el('div', 'qSec'); s.append(...heads, grid(list)); return s; }; // heads: one timer line per period shown
const evKey = (v) => (v.event ? v.event.id + (v.event.active ? ':on' : ':soon') : null);

function render() {
  const v = questsView(), ev = v.event;
  $('qEvTab').classList.toggle('dim', !ev); $('qEvTab').classList.toggle('soon', !!ev && !ev.active);
  if (tab === 'event' && !ev) tab = 'quests';
  for (const b of $('qTabs').children) b.classList.toggle('sel', b.dataset.tab === tab);
  const body = $('qBody'); body.replaceChildren(); body.className = tab;
  shownEvent = evKey(v);
  if (tab === 'quests') body.append(section([head('DAILY', 'daily'), head('WEEKLY', 'weekly')], [...v.daily, ...v.weekly])); // one grid: 3 dailies + 2 weeklies = one row
  else if (tab === 'season') body.append(section([head('SEASON', 'season')], v.season));
  else {
    const fr = el('iframe', 'frame qFrame'); fr.setAttribute('sandbox', ''); fr.srcdoc = ev.html; fr.title = 'Event';
    const side = el('div', 'qSide'), t = el('div', 'lbl'), tm = el('span', 'qTimer'); tm.dataset.t = 'event';
    t.append(ev.title.toUpperCase() + ' - ', tm); side.append(t, grid(ev.quests));
    body.append(fr, side);
  }
  tick(v);
}
function tick(v = questsView()) { // timers only: a full render every second would eat button presses and reload the iframe
  const now = Date.now(), ev = v.event, at = { daily: () => 'RESETS IN ' + hms(v.resets.daily - now), weekly: () => 'RESETS IN ' + dh(v.resets.weekly - now),
    season: () => `ENDS IN ${daysLeft(v.resets.season - now)} DAYS`,
    event: () => (ev ? (ev.active ? 'ENDS IN ' + dh(ev.end - now) : 'STARTS IN ' + dh(ev.start - now)).toUpperCase() : '') };
  for (const s of document.querySelectorAll('#qBody .qTimer')) s.textContent = at[s.dataset.t]();
  $('qEvTab').textContent = !ev ? 'NO EVENT RIGHT NOW' : (ev.active ? `EVENT · ${dh(ev.end - now)} LEFT` : `EVENT IN ${dh(ev.start - now)}`).toUpperCase();
  $('qTitle').textContent = tab === 'season' ? 'SEASON ' + seasonNo(v) : 'QUESTS';
  if (evKey(v) !== shownEvent) render();
}
const seasonNo = (v) => (v.season[0] ? +/^s:(\d+):/.exec(v.season[0].key)[1] : ''); // the period key carries the number

/** Main-menu badge: completed-but-unclaimed count. */
export function updateQuestBadge() { const n = unclaimedCount(questsView()), b = $('mQBadge'); b.hidden = !n; b.textContent = n; }

function showWon(rewards) {
  const pop = $('qPop'), box = pop.querySelector('.drops'); box.replaceChildren();
  for (const r of rewards) {
    const c = el('div'), d = r.drop, tier = d ? d.tier : r.type === 'xp' ? 'epic' : 'rare';
    c.className = `dcard open pop t-${tier}`;
    if (r.type === 'powerup' || r.type.endsWith('_drop')) c.innerHTML = dropBack(d); // numbers / escaped catalog names only
    else c.textContent = r.type === 'coins' ? `+${r.amount} SBCOINS` : `+${r.amount} XP`;
    box.append(c);
    if (r.levelsUp && r.levelsUp.length) box.append(Object.assign(el('div', 'dcard open t-legendary'), { textContent: 'LEVEL UP! ' + r.levelsUp.at(-1).level }));
  }
  pop.hidden = false;
}

let timer = 0;
export function onScreen(name) {
  clearInterval(timer);
  if (name !== 'scrQuests') return;
  $('qPop').hidden = true; render();
  timer = setInterval(() => (document.hidden || !$('scrQuests').classList.contains('on') ? clearInterval(timer) : tick()), 1000);
}

export function initQuestsUi(h) {
  $('mQuests').addEventListener('click', () => h.show('scrQuests'));
  $('qBack').addEventListener('click', () => h.show('scrMain'));
  $('qTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || (b.dataset.tab === 'event' && b.classList.contains('dim'))) return;
    tab = b.dataset.tab; render();
  });
  $('qOk').addEventListener('click', () => { $('qPop').hidden = true; });
  $('qBody').addEventListener('click', (e) => {
    const b = e.target.closest('.qClaim'); if (!b) return;
    const r = claim(b.dataset.key);
    if (!r.ok) { showAnnounce('CANNOT CLAIM'); render(); return; }
    showWon(r.rewards); refreshProfile(); $('mCoins').textContent = getSave().coins; render(); updateQuestBadge();
  });
  updateQuestBadge();
}
