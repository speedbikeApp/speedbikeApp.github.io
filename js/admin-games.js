// ADMIN > GAMES tab: waiting queues / lobbies (FORCE START), running matches (STOP) and the featured-mode selector. The server is the only authority
// (server/admin-games.js: gget / gstart / gstop / gfeatured). The list refreshes every 3 s while the tab is open. User text only via textContent. DOM only.
import { registerAdminTab, ADMIN_ERR } from './admin-core.js';
import { net, MODE_LABEL } from './online.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const ERR = { ...ADMIN_ERR, not_found: 'NO LONGER WAITING / RUNNING' };
const label = (m) => MODE_LABEL[m] || String(m).toUpperCase();

function mountGames(root, { call }) {
  const msg = el('div', 'adMsg'), feat = el('div', 'adSec'), body = el('div');
  root.append(msg, feat, body);
  const say = (t, kind) => { msg.textContent = t || ''; msg.className = 'adMsg' + (kind ? ' ' + kind : ''); };
  const fail = (r) => say(ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad');
  const act = async (op, args, ok) => { say('...'); const r = await call(op, args); if (r.ok) { say(ok, 'ok'); load(); } else { fail(r); load(); } };
  let dead = false;

  function drawFeatured(f) {
    feat.textContent = ''; feat.append(el('b', '', 'FEATURED MODE'));
    const row = el('div', 'adLine'), sel = el('select');
    for (const [v, t] of [['auto', 'AUTO (HOURLY ROTATION)'], ...f.cycle.map((m) => [m, label(m)])]) { const o = el('option', '', t); o.value = v; sel.appendChild(o); }
    sel.value = f.override || 'auto';
    row.append(sel, btn('SET', 'primary', () => act('gfeatured', { mode: sel.value }, 'FEATURED MODE UPDATED')));
    feat.append(row, el('div', '', `NOW: ${label(f.current)}${f.override ? ' (SET BY ADMIN)' : ' (ROTATION)'}`));
  }
  const section = (title) => { const s = el('div', 'adSec'); s.append(el('b', '', title)); body.appendChild(s); return s; };
  const row = (s, text, ...btns) => { const r = el('div', 'adLine'); r.append(el('span', '', text + ' '), ...btns); s.appendChild(r); };

  function draw(r) {
    drawFeatured(r.featured); body.textContent = '';
    const wait = section('WAITING (QUEUES AND LOBBIES)');
    for (const l of r.lobbies) {
      const left = Math.max(0, Math.ceil((l.endsAt - net.serverNow()) / 1000));
      row(wait, `LOBBY ${label(l.mode)}${l.party ? ' (PARTY)' : ''}: ${l.players.join(', ')} - STARTS IN ${left}s`, btn('FORCE START', 'primary', () => act('gstart', { lobby: l.id }, 'STARTED')));
    }
    for (const q of r.queues) row(wait, `QUEUE ${label(q.mode)}: ${q.players.join(', ')}`, btn('FORCE START', 'primary', () => act('gstart', { queue: q.mode }, 'STARTED')));
    if (!r.lobbies.length && !r.queues.length) wait.append(el('div', 'frEmpty', 'NOBODY IS WAITING'));
    const live = section('RUNNING MATCHES');
    for (const m of r.rooms) {
      const who = m.players.map((p, i) => `${p.username}${p.bot ? ' (BOT)' : ''}${p.left ? ' (LEFT)' : ''} ${m.scores[i]}`).join(', ');
      row(live, `#${m.id} ${label(m.mode)} | MAP ${m.map} | ROUND ${m.round} | ${String(m.phase).toUpperCase()} | ${who}`, btn('STOP', 'danger', () => { if (globalThis.confirm(`Stop match #${m.id}? Nobody's rank or coins change.`)) act('gstop', { id: m.id }, 'MATCH STOPPED'); }));
    }
    if (!r.rooms.length) live.append(el('div', 'frEmpty', 'NO MATCH IS RUNNING'));
  }
  async function load() { const r = await call('gget', {}); if (dead) return; if (r.ok) draw(r); else fail(r); }
  load(); const timer = setInterval(load, 3000);
  return () => { dead = true; clearInterval(timer); };
}
registerAdminTab('games', 'GAMES', mountGames);
