// ADMIN page (button at the top-right of the main menu, admins only) with a tab registry (admin-core.js registerAdminTab) and the PLAYERS tab.
// Cosmetic only: the server re-checks every action (server/admin.js). User text only via textContent. DOM only.
// Other tabs (MAPS, GARAGE): write js/admin-<name>.js that calls registerAdminTab('maps', 'MAPS', mount) and add `import './admin-<name>.js';` below.
import { net, adminCall } from './online.js';
import { isAdmin, onAdminChange, registerAdminTab, hasAdminTab, adminTabs, ADMIN_ERR, fmtTime } from './admin-core.js';
import { rankLabel, defaultRank } from './ranks.js';
// ---- tab modules plug in here (each registers itself on import) ----
import './admin-garage.js';
import './admin-maps.js';
import './admin-drops.js';

const $ = (id) => document.getElementById(id);
let show = () => {}, active = 'players', cleanup = null;
const STAT_KEYS = ['matches', 'wins', 'winStreak', 'bestStreak', 'kills', 'distance', 'boosts', 'jumps', 'bestRoundBoosts', 'bestRoundJumps', 'dmFlawless', 'wins3d', 'winsHyper'];

export function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const input = (cls, attrs = {}) => { const i = el('input', cls); i.autocomplete = 'off'; i.spellcheck = false; Object.assign(i, attrs); return i; };
const toast = (box, text, kind) => { box.textContent = text || ''; box.className = 'adMsg' + (kind ? ' ' + kind : ''); };
export const errText = (r) => ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase();

// ---- PLAYERS ----
function mountPlayers(root) {
  const form = el('form', 'adLine'), q = input('wide', { type: 'text', maxLength: 12, placeholder: 'SEARCH BY USERNAME' }), msg = el('div', 'adMsg'), list = el('div'), detail = el('div');
  form.noValidate = true; form.append(q, btn('SEARCH', 'primary', () => form.requestSubmit()));
  root.append(form, msg, list, detail);
  let me = null;
  const run = async (op, args, okText) => { toast(msg, '...'); const r = await adminCall(op, args); if (r.ok) toast(msg, okText || 'DONE', 'ok'); else toast(msg, errText(r), 'bad'); return r; };

  const rows = (ps) => { for (const p of ps) {
    const row = el('div', 'frRow ' + (p.online ? 'on' : 'off')), nm = el('button', 'nm', p.username + (p.admin ? ' ✎' : ''));
    nm.type = 'button'; nm.addEventListener('click', () => open(p.uid));
    row.append(el('span', 'st', p.online ? '[ONLINE]' : '[OFFLINE]'), nm); list.appendChild(row);
  } };
  async function browse(after) { // all players A-Z, 50 per page
    const r = await run('plist', after ? { after } : {}, '');
    if (!r.ok) return;
    more.remove(); rows(r.players);
    if (r.next) { more.onclick = () => browse(r.next); list.appendChild(more); }
  }
  const more = btn('LOAD MORE', '', () => {});
  async function search() {
    list.textContent = ''; detail.textContent = '';
    if (!q.value.trim()) return browse();
    const r = await run('psearch', { q: q.value }, '');
    if (!r.ok) return;
    if (!r.results.length) return void toast(msg, 'NO PLAYERS FOUND');
    rows(r.results);
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); search(); });

  async function open(uid) {
    detail.textContent = '';
    const r = await run('pget', { uid }, '');
    if (!r.ok) return;
    const p = r.player, self = net.welcome && net.welcome.uid === p.uid;
    const sec = (title) => { const s = el('div', 'adSec'); s.append(el('b', '', title)); detail.appendChild(s); return s; };
    const line = (s) => { const l = el('div', 'adLine'); s.appendChild(l); return l; };
    const reload = () => open(uid);

    const head = sec(`${p.username}${p.admin ? ' ✎ ADMIN' : ''}  -  ${p.online ? 'ONLINE' : 'OFFLINE'}`);
    head.append(el('div', '', `RANK ${p.rank ? rankLabel(p.rank) : rankLabel(defaultRank())}  |  MATCHES ${p.rank ? p.rank.matches : 0}  |  RANKED WINS ${p.rank ? p.rank.totalWins : 0}`));
    head.append(el('div', '', p.ban ? (p.ban.permanent ? 'BANNED PERMANENTLY' : 'BANNED UNTIL ' + fmtTime(p.ban.until)) + (p.ban.reason ? ' - ' + p.ban.reason : '') : 'NOT BANNED'));

    const st = sec(p.progress.synced ? 'STATS' : 'STATS (NO CLOUD SAVE YET - EDITING CREATES ONE)'), grid = el('div', 'adStats'), fields = {};
    const mk = (key, label, value) => { const l = el('label', '', label), i = input('', { type: 'number', min: 0, step: 1, value: String(value) }); l.appendChild(i); grid.appendChild(l); fields[key] = [i, value]; };
    mk('coins', 'COINS', p.progress.coins); for (const k of STAT_KEYS) mk(k, k.toUpperCase(), p.progress.stats[k]);
    st.append(grid, el('div', '', `ACHIEVEMENTS ${p.progress.achievements}`));
    st.append(btn('SAVE CHANGES', 'primary', async () => {
      const args = { uid, stats: {} };
      for (const [k, [i, old]] of Object.entries(fields)) { const v = Number(i.value); if (!Number.isFinite(v)) return toast(msg, ADMIN_ERR.bad_value, 'bad'); if (v === old) continue; if (k === 'coins') args.coins = v; else args.stats[k] = v; }
      if (args.coins === undefined && !Object.keys(args.stats).length) return toast(msg, 'NOTHING CHANGED');
      if ((await run('pedit', args, 'SAVED - THE PLAYER IS UPDATED IF ONLINE')).ok) reload();
    }));

    const ban = sec('BAN'), bl = line(ban), mins = input('', { type: 'number', min: 1, step: 1, placeholder: 'MINUTES' }), why = input('wide', { type: 'text', maxLength: 100, placeholder: 'REASON (OPTIONAL)' });
    bl.append(mins, why);
    const bl2 = line(ban);
    bl2.append(btn('BAN FOR MINUTES', '', async () => { if ((await run('pban', { uid, minutes: Number(mins.value), reason: why.value }, 'BANNED')).ok) reload(); }),
      btn('BAN PERMANENTLY', 'danger', async () => { if ((await run('pban', { uid, permanent: true, reason: why.value }, 'BANNED PERMANENTLY')).ok) reload(); }));
    if (p.ban) bl2.append(btn('UNBAN', 'primary', async () => { if ((await run('punban', { uid }, 'UNBANNED')).ok) reload(); }));
    if (self || p.adminLocked) for (const b of bl2.querySelectorAll('button')) if (b.textContent !== 'UNBAN') b.disabled = true;

    const ad = sec('ADMIN RIGHTS'), ab = btn(p.admin ? 'REMOVE ADMIN' : 'MAKE ADMIN', p.admin ? 'danger' : 'primary', async () => { if ((await run('padmin', { uid, on: !p.admin }, p.admin ? 'ADMIN REMOVED' : 'NOW AN ADMIN')).ok) reload(); });
    ab.disabled = p.admin && (self || p.adminLocked);
    ad.append(ab); if (p.adminLocked) ad.append(el('div', '', 'SET BY THE SERVER CONFIG - CANNOT BE REMOVED HERE'));

    const rn = sec('CHANGE USERNAME / PASSWORD'), rl = line(rn), nn = input('wide', { type: 'text', maxLength: 12, placeholder: 'NEW USERNAME (3-12)' });
    rl.append(nn, btn('RENAME', 'primary', async () => { if ((await run('prename', { uid, username: nn.value }, 'RENAMED')).ok) reload(); }));
    const pl = line(rn), pw = input('wide', { type: 'password', maxLength: 128, placeholder: 'NEW PASSWORD (8+)', autocomplete: 'new-password' });
    const pb = btn('CHANGE PASSWORD', 'primary', async () => { if ((await run('ppassword', { uid, password: pw.value }, 'PASSWORD CHANGED - THE PLAYER MUST SIGN IN AGAIN')).ok) pw.value = ''; });
    pb.disabled = !self && p.admin; pl.append(pw, pb); // other admins' passwords are off limits (server checks too)

    const del = sec('DELETE ACCOUNT (CANNOT BE UNDONE)'), dl = line(del), cf = input('wide', { type: 'text', maxLength: 12, placeholder: `TYPE "${p.username}" TO CONFIRM` });
    const db = btn('DELETE ACCOUNT', 'danger', async () => { if ((await run('pdelete', { uid, confirm: cf.value }, 'ACCOUNT DELETED')).ok) { detail.textContent = ''; list.textContent = ''; } });
    db.disabled = true; cf.addEventListener('input', () => { db.disabled = self || p.adminLocked || cf.value.trim().toLowerCase() !== p.username.toLowerCase(); });
    dl.append(cf, db);
    me = p;
  }
  q.focus(); search();
  return () => { me = null; };
}

function placeholder(root) { root.append(el('div', 'frEmpty', 'COMING SOON')); }
registerAdminTab('players', 'PLAYERS', mountPlayers);
for (const [id, label] of [['maps', 'MAPS'], ['garage', 'GARAGE']]) if (!hasAdminTab(id)) registerAdminTab(id, label, placeholder);

// ---- page ----
function openTab(id) {
  active = id;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const body = $('adBody'); body.textContent = '';
  for (const b of $('adTabs').children) b.classList.toggle('sel', b.dataset.tab === id);
  const t = adminTabs().find((x) => x.id === id); if (!t) return;
  try { cleanup = t.mount(body, { call: adminCall, toast }) || null; } catch (e) { body.append(el('div', 'frEmpty', 'TAB FAILED TO LOAD')); console.error(e); }
}
/** Called by menu.js when the ADMIN screen opens. */
export function onScreen() {
  if (!isAdmin()) return void show('scrMain');
  const tabs = $('adTabs'); tabs.textContent = '';
  const all = adminTabs(); if (!all.some((t) => t.id === active)) active = all[0].id;
  for (const t of all) { const b = btn(t.label, '', () => openTab(t.id)); b.dataset.tab = t.id; tabs.appendChild(b); }
  openTab(active);
}
export function initAdminUi(h) {
  show = h.show;
  const sync = () => { $('mAdmin').hidden = !isAdmin(); if (!isAdmin() && $('scrAdmin').classList.contains('on')) show('scrMain'); };
  $('mAdmin').addEventListener('click', () => { if (isAdmin()) show('scrAdmin'); });
  $('adBack').addEventListener('click', () => show('scrMain'));
  onAdminChange(sync); sync();
}
