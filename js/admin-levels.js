// ADMIN > LEVELS tab: edit the level table (xp per level, wins / games per level, online xp multiplier, level coins, max level). The server is the only
// authority (server/admin-items.js: lget / lset / lreset); the same validateLevels (js/leveldef.js) runs here first. DOM only.
import { registerAdminTab, ADMIN_ERR } from './admin-core.js';
import { validateLevels } from './leveldef.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const FIELDS = [['xpPerLevel', 'XP PER LEVEL', 1], ['winsPerLevel', 'WINS PER LEVEL', 1], ['gamesPerLevel', 'GAMES PER LEVEL', 1], ['onlineMult', 'ONLINE XP MULTIPLIER', 0.1],
  ['coinsPerLevel', 'COINS PER LEVEL (x LEVEL)', 1], ['coinsMax', 'MAX COINS PER LEVEL', 1], ['maxLevel', 'MAX LEVEL (PRESTIGE AT)', 1]];

function mountLevels(root, { call }) {
  const msg = el('div', 'adMsg'), body = el('div');
  root.append(msg, body);
  const say = (t, kind) => { msg.textContent = t || ''; msg.className = 'adMsg' + (kind ? ' ' + kind : ''); };
  const fail = (r) => say(ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad');

  function draw(t) {
    body.textContent = '';
    const inputs = {};
    for (const [k, label, step] of FIELDS) {
      const i = el('input'); i.type = 'number'; i.step = step; i.value = t[k]; inputs[k] = i;
      const l = el('label', 'adLine'); l.append(el('span', '', label + ' '), i); body.appendChild(l);
    }
    body.append(btn('SAVE', 'primary', async () => {
      const o = {}; for (const [k] of FIELDS) o[k] = Number(inputs[k].value);
      if (!validateLevels(o).ok) return say(ADMIN_ERR.bad_levels, 'bad');
      say('...'); const r = await call('lset', { levels: o });
      if (!r.ok) return fail(r);
      draw(r.levels); say('SAVED', 'ok');
    }), btn('RESET TO DEFAULT', '', async () => {
      say('...'); const r = await call('lreset', {});
      if (!r.ok) return fail(r);
      draw(r.levels); say('RESET', 'ok');
    }));
  }

  (async () => { say('...'); const r = await call('lget', {}); if (!r.ok) return fail(r); say(''); draw(r.levels); })();
}
registerAdminTab('levels', 'LEVELS', mountLevels);
