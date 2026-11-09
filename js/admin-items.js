// GIVE ITEMS section of the PLAYERS detail view (laid out like the garage): one tab per part category (tiles, click = give / take) plus a POWERUPS tab
// (amount 0..99 + SET, UNLIMITED toggle). The server validates and saves (server/admin-players.js `pitems`) and resyncs an online player. DOM only.
import { CATS, CAT_LABEL, partList, isFreePart } from './parts.js';
import { ABILITIES, ABILITY_IDS } from './abilities.js';
import { STACK_MAX } from './save.js';
import { ADMIN_ERR } from './admin-core.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };

/** p = pget player; call(op, args) -> result. Appends to `box`; `say(text, kind)` reports results. */
export function mountItems(box, p, call, say) {
  let tab = 'body'; const pr = p.progress;
  const parts = pr.parts, count = pr.abilityCount, inf = new Set(pr.abilityInf);
  const tabs = el('div', 'adLine'), list = el('div');
  box.append(tabs, list);
  const send = async (args) => {
    say('...'); const r = await call('pitems', { uid: p.uid, ...args });
    if (!r.ok) return say(ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad');
    Object.assign(parts, r.parts); for (const k of Object.keys(count)) delete count[k]; Object.assign(count, r.abilityCount);
    inf.clear(); for (const id of r.abilityInf) inf.add(id);
    say('SAVED - THE PLAYER IS UPDATED IF ONLINE', 'ok'); draw();
  };
  function draw() {
    tabs.textContent = ''; list.textContent = '';
    for (const c of [...CATS, 'power']) tabs.appendChild(btn(c === 'power' ? 'POWERUPS' : CAT_LABEL[c], c === tab ? 'sel' : '', () => { tab = c; draw(); }));
    if (tab !== 'power') {
      for (const it of partList(tab)) {
        const free = isFreePart(it), own = free || (parts[tab] || []).includes(it.id);
        const b = btn(`${own ? '[OWNED] ' : ''}${it.name.toUpperCase()}${it.custom ? ' (CUSTOM)' : ''}${free ? ' - FREE' : ''}`, own ? 'sel' : '', () => send({ part: { cat: tab, id: it.id, own: !own } }));
        b.disabled = free; list.appendChild(b);
      }
      return;
    }
    for (const id of ABILITY_IDS) {
      const d = ABILITIES[id], free = d.price === 0, row = el('div', 'adLine');
      const amt = el('input'); amt.type = 'number'; amt.min = 0; amt.max = STACK_MAX; amt.step = 1; amt.value = count[id] || 0;
      const state = free ? 'ALWAYS UNLIMITED' : inf.has(id) ? 'UNLIMITED' : `${count[id] || 0} OWNED`;
      const set = btn('SET', 'primary', () => send({ ability: { id, count: Number(amt.value) } })), un = btn(inf.has(id) ? 'REMOVE UNLIMITED' : 'UNLIMITED', inf.has(id) ? 'sel' : '', () => send({ ability: { id, inf: !inf.has(id) } }));
      amt.disabled = set.disabled = un.disabled = free;
      row.append(el('span', '', `${d.name.toUpperCase()} [${state}] `), amt, set, un); list.appendChild(row);
    }
  }
  draw();
}
