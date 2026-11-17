// ADMIN > QUESTS tab: the quest pools (daily / weekly / season, JSON) and the events (info HTML + quests). The server is the only authority
// (server/admin-items.js: qget / qset / qreset, eget / eset / edel); the same validators (js/questdef.js) run here first so the error names the quest.
// Event html is only ever shown in a sandboxed iframe (sandbox="" = no scripts, srcdoc). DOM only.
import { registerAdminTab, ADMIN_ERR } from './admin-core.js';
import { validateQuestConfig, validateEvent, REQUIREMENTS, REWARD_TYPES } from './questdef.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const area = (rows) => { const t = el('textarea'); t.rows = rows; t.spellcheck = false; t.style.cssText = 'width:100%;box-sizing:border-box;background:#012;color:#fff;border:1px solid #357;padding:6px 8px;font:12px/1.4 monospace;resize:vertical'; return t; };
const field = (label, input) => { const l = el('label', 'adLine'); l.append(el('span', '', label + ' '), input); return l; };
const num = (v) => { const i = el('input'); i.type = 'number'; i.value = v; return i; };
const json = (v) => JSON.stringify(v, null, 1);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z'; // UTC, minutes
const parseTime = (s) => (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z$/.test(s.trim()) ? Date.parse(s.trim()) : NaN);
const parse = (text, what) => { try { return { v: JSON.parse(text) }; } catch (e) { return { err: `${what}: not valid JSON (${e.message})` }; } };

function mountQuests(root, { call }) {
  const msg = el('div', 'adMsg'), cfgSec = el('div', 'adSec'), evSec = el('div', 'adSec');
  root.append(msg, cfgSec, evSec);
  const say = (t, kind) => { msg.textContent = t || ''; msg.className = 'adMsg' + (kind ? ' ' + kind : ''); msg.scrollIntoView?.({ block: 'nearest' }); };
  const fail = (r) => say(ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad');

  // ---- quest pools ----
  const help = el('div', '', `QUEST = {"id","title","body","requirement","reward"}. REQUIREMENT "id:count" or "id(seconds):count". IDS: ${Object.keys(REQUIREMENTS).join(', ')}. REWARD "type:amount,..." TYPES: ${REWARD_TYPES.join(', ')} (powerup(abilityId):charges). SEASON = EXACTLY 10.`);
  help.style.cssText = 'font-size:11px;opacity:.8';
  const ta = { daily: area(10), weekly: area(8), season: area(10) }, counts = { dailyCount: num(3), weeklyCount: num(2), seasonMonths: num(2) };
  const read = () => {
    const raw = { dailyCount: Number(counts.dailyCount.value), weeklyCount: Number(counts.weeklyCount.value), seasonMonths: Number(counts.seasonMonths.value) };
    for (const k of ['daily', 'weekly', 'season']) { const p = parse(ta[k].value, k.toUpperCase()); if (p.err) return { ok: false, why: p.err }; raw[k] = p.v; }
    return validateQuestConfig(raw);
  };
  const draw = (c) => { for (const k of ['daily', 'weekly', 'season']) ta[k].value = json(c[k]); for (const k of Object.keys(counts)) counts[k].value = c[k]; };
  cfgSec.append(el('b', '', 'QUEST POOLS (DAILY / WEEKLY PICKS ARE SEEDED BY THE DAY / WEEK)'), help,
    field('DAILIES PER DAY', counts.dailyCount), field('WEEKLIES PER WEEK', counts.weeklyCount), field('SEASON LENGTH (MONTHS)', counts.seasonMonths),
    el('b', '', 'DAILY POOL'), ta.daily, el('b', '', 'WEEKLY POOL'), ta.weekly, el('b', '', 'SEASON QUESTS'), ta.season,
    btn('VALIDATE', '', () => { const v = read(); say(v.ok ? 'VALID' : v.why, v.ok ? 'ok' : 'bad'); }),
    btn('SAVE', 'primary', async () => {
      const v = read(); if (!v.ok) return say(v.why, 'bad');
      say('...'); const r = await call('qset', { quests: v.config });
      if (!r.ok) return fail(r);
      draw(r.quests); say('SAVED', 'ok');
    }),
    btn('RESET TO DEFAULT', '', async () => { say('...'); const r = await call('qreset', {}); if (!r.ok) return fail(r); draw(r.quests); say('RESET', 'ok'); }));

  // ---- events ----
  const list = el('div'), editor = el('div');
  evSec.append(el('b', '', 'EVENTS (THE ONE RUNNING NOW SHOWS ON THE EVENT TAB)'), list, editor);
  const f = { id: el('input'), title: el('input'), start: el('input'), end: el('input') };
  for (const i of Object.values(f)) i.className = 'wide';
  const html = area(10), quests = area(8), frame = el('iframe');
  frame.setAttribute('sandbox', ''); frame.style.cssText = 'width:100%;height:220px;border:1px solid #357;background:#fff';
  const pv = () => { frame.srcdoc = html.value; };
  html.addEventListener('input', pv);
  const fill = (e) => { f.id.value = e.id; f.title.value = e.title; f.start.value = iso(e.start); f.end.value = iso(e.end); html.value = e.html; quests.value = json(e.quests); pv(); };
  const readEvent = () => {
    const q = parse(quests.value, 'QUESTS'); if (q.err) return { ok: false, why: q.err };
    const start = parseTime(f.start.value), end = parseTime(f.end.value);
    if (Number.isNaN(start) || Number.isNaN(end)) return { ok: false, why: 'START / END: use UTC like 2026-12-01T00:00Z' };
    return validateEvent({ id: f.id.value.trim(), title: f.title.value, start, end, html: html.value, quests: q.v });
  };
  const status = (e) => { const n = Date.now(); return n < e.start ? 'UPCOMING' : n < e.end ? 'RUNNING' : 'ENDED'; };
  const drawList = (events) => {
    list.textContent = '';
    for (const e of events) { const l = el('div', 'adLine'); l.append(btn(e.id, '', () => fill(e)), el('span', '', `${e.title}  ${iso(e.start)} - ${iso(e.end)}  ${status(e)}`)); list.appendChild(l); }
    if (!events.length) list.appendChild(el('div', '', 'NO EVENTS'));
  };
  const template = () => { const n = Date.now(); return { id: 'event' + new Date(n).getUTCFullYear(), title: 'NEW EVENT', start: n, end: n + 7 * 864e5, html: '<h1>NEW EVENT</h1><p>Describe the event here (HTML + CSS, no scripts).</p>',
    quests: [{ id: 'ev_play', title: 'ON MY WAY TO THE TOP', body: 'play a multiplayer game!', requirement: 'multiplayer_game_completed:1', reward: 'common_drop:1' }] }; };
  const sideBySide = el('div', 'adLine'); sideBySide.style.alignItems = 'flex-start';
  const left = el('div'), right = el('div'); left.style.cssText = right.style.cssText = 'flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:6px';
  left.append(field('ID', f.id), field('TITLE', f.title), field('START (UTC)', f.start), field('END (UTC)', f.end), el('b', '', 'INFO HTML (NO SCRIPTS)'), html, el('b', '', 'EVENT QUESTS (JSON LIST, MAX 20)'), quests);
  right.append(el('b', '', 'PREVIEW'), frame);
  sideBySide.append(left, right);
  editor.append(btn('NEW EVENT', '', () => fill(template())), sideBySide,
    btn('VALIDATE', '', () => { const v = readEvent(); say(v.ok ? 'VALID' : v.why, v.ok ? 'ok' : 'bad'); }),
    btn('SAVE EVENT', 'primary', async () => {
      const v = readEvent(); if (!v.ok) return say(v.why, 'bad');
      say('...'); const r = await call('eset', { event: v.event });
      if (!r.ok) return fail(r);
      drawList(r.events); say('SAVED', 'ok');
    }),
    btn('DELETE EVENT', '', async () => {
      const id = f.id.value.trim(); if (!id) return;
      say('...'); const r = await call('edel', { id });
      if (!r.ok) return fail(r);
      drawList(r.events); say('DELETED', 'ok');
    }));
  fill(template());

  (async () => {
    say('...');
    const [a, b] = [await call('qget', {}), await call('eget', {})];
    if (!a.ok) return fail(a);
    if (!b.ok) return fail(b);
    say(''); draw(a.quests); drawList(b.events);
  })();
}
registerAdminTab('quests', 'QUESTS', mountQuests);
