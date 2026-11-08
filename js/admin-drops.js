// ADMIN > DROPS tab: edit the loot-box drop table (tier weights, rewards, earning rules). The server is the only authority (server/admin-items.js: dget / dset / dreset);
// the same validateDrops (js/dropdef.js) runs here first so mistakes show up before sending. User text only via values / textContent. DOM only.
import { registerAdminTab, ADMIN_ERR } from './admin-core.js';
import { TIERS, WEIGHT_RANGE, POOLS, MAX_REWARDS, validateDrops } from './dropdef.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const field = (label, node) => { const l = el('label', 'adLine'); l.append(el('span', '', label + ' '), node); return l; };
const num = (v, min, max, step = 1) => { const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.step = step; i.value = v; return i; };
const select = (opts, val) => { const s = el('select'); for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; s.appendChild(o); } s.value = val; return s; };
const POOL_LABEL = { normal: 'NORMAL (<= NORMAL MAX)', rare: 'RARE (>= RARE MIN)', any: 'ANY' };
const RULES = [['unlimitedOdds', '"1 IN N" UNLIMITED', 2, 1e7], ['loseStreak', 'LOSSES IN A ROW = 1 DROP', 1, 100], ['winDrops', 'DROPS PER WIN', 0, 10], ['bonusWinDrops', 'DROPS PER BONUS WIN', 0, 10], ['normalMax', 'NORMAL MAX PRICE', 0, 1e6], ['rareMin', 'RARE MIN PRICE', 0, 1e6]];

function mountDrops(root, { call }) {
  const msg = el('div', 'adMsg'), body = el('div');
  root.append(msg, body);
  const say = (t, kind) => { msg.textContent = t || ''; msg.className = 'adMsg' + (kind ? ' ' + kind : ''); };
  let t = null, read = () => null; // read() builds a table from the inputs (numbers may be NaN -> validateDrops rejects)

  function draw() {
    body.textContent = '';
    const chance = el('div', 'adMsg'), tierIn = {}, ruleIn = {};
    const showChance = () => {
      const w = TIERS.map((k) => Number(tierIn[k].w.value)), sum = w.reduce((a, b) => a + b, 0), n = Number(ruleIn.unlimitedOdds.value);
      chance.textContent = 'CHANCE (AFTER THE 1/N UNLIMITED ROLL): ' + TIERS.map((k, i) => `${k.toUpperCase()} ${sum > 0 ? ((w[i] / sum) * (n > 1 ? 1 - 1 / n : 1) * 100).toFixed(2) : '?'}%`).join(' | ');
    };
    for (const k of TIERS) {
      const [lo, hi] = WEIGHT_RANGE[k], w = num(t.tiers[k].weight, lo, hi), rows = [], list = el('div');
      w.addEventListener('input', showChance);
      tierIn[k] = { w, rows };
      const drawRows = () => {
        list.textContent = '';
        rows.forEach((r, i) => {
          const kind = select([['coins', 'COINS'], ['ability', 'POWER-UP']], r.kind), amt = num(r.amount || 100, 1, 1e6), pool = select(POOLS.map((p) => [p, POOL_LABEL[p]]), r.pool || 'normal'), cnt = num(r.count || 1, 1, 99);
          const sync = () => { amt.style.display = kind.value === 'coins' ? '' : 'none'; pool.style.display = cnt.style.display = kind.value === 'coins' ? 'none' : ''; };
          kind.addEventListener('change', sync); sync();
          const row = el('div', 'adLine'); row.append(kind, amt, pool, cnt, btn('REMOVE', '', () => { rows.splice(i, 1); drawRows(); }));
          r.get = () => (kind.value === 'coins' ? { kind: 'coins', amount: Number(amt.value) } : { kind: 'ability', pool: pool.value, count: Number(cnt.value) });
          list.appendChild(row);
        });
        add.disabled = rows.length >= MAX_REWARDS;
      };
      const add = btn('ADD REWARD', '', () => { rows.push({ kind: 'coins', amount: 100 }); drawRows(); });
      rows.push(...t.tiers[k].rewards.map((r) => ({ ...r }))); drawRows();
      body.append(el('b', '', k.toUpperCase()), field(`WEIGHT (${lo}-${hi})`, w), list, add);
    }
    for (const [key, label, lo, hi] of RULES) { ruleIn[key] = num(t[key], lo, hi); body.appendChild(field(label, ruleIn[key])); }
    ruleIn.unlimitedOdds.addEventListener('input', showChance);
    const extra = num(Math.round(t.extraChance * 1e4) / 100, 0, 100, 0.01); ruleIn.extra = extra; body.appendChild(field('EXTRA DROP CHANCE % (PER MATCH)', extra));
    body.append(chance); showChance();
    read = () => {
      const o = { tiers: {}, extraChance: Number(extra.value) / 100 };
      for (const k of TIERS) o.tiers[k] = { weight: Number(tierIn[k].w.value), rewards: tierIn[k].rows.map((r) => r.get()) };
      for (const [key] of RULES) o[key] = Number(ruleIn[key].value);
      return o;
    };
    body.append(btn('SAVE', 'primary', async () => {
      const v = validateDrops(read()); if (!v) return say(ADMIN_ERR.bad_drops, 'bad');
      say('...'); const r = await call('dset', { drops: v });
      if (!r.ok) return say(ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad');
      t = r.drops; draw(); say('SAVED', 'ok');
    }), btn('RESET TO DEFAULT', '', async () => {
      say('...'); const r = await call('dreset', {});
      if (!r.ok) return say(ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad');
      t = r.drops; draw(); say('RESET', 'ok');
    }));
  }

  (async () => { say('...'); const r = await call('dget', {}); if (!r.ok) return say(ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad'); t = r.drops; say(''); draw(); })();
}
registerAdminTab('drops', 'DROPS', mountDrops);
