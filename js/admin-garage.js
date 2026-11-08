// ADMIN > GARAGE tab: create / edit custom garage items (a built-in model + name, price or achievement, colour tint) and edit name / price / achievement
// of built-in ones. The server is the only authority (server/admin-items.js); after every change the list is re-read and merged into PARTS (js/catalog.js).
// User text only via textContent / values. DOM only.
import { registerAdminTab } from './admin-core.js';
import { CATS, CAT_LABEL, BUILTIN_PARTS, partList, isCustomId } from './parts.js';
import { ACHIEVEMENTS } from './achievements.js';
import { useCatalog } from './catalog.js';

const ERR = { bad_name: 'NAME: 1-20 LETTERS, NUMBERS, SPACE _ . \' -', bad_price: 'PRICE: WHOLE NUMBER 0-1,000,000', bad_ach: 'UNKNOWN ACHIEVEMENT', bad_base: 'BAD BASE MODEL', bad_cat: 'BAD CATEGORY', bad_color: 'BAD COLOUR', bad_item: 'BAD ITEM', too_many: 'TOO MANY CUSTOM ITEMS' };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };
const field = (label, node) => { const l = el('label', 'adLine'); l.append(el('span', '', label + ' '), node); return l; };
const select = (opts, val) => { const s = el('select'); for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; s.appendChild(o); } s.value = val; return s; };
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function mountGarage(root, { call }) {
  let cat = 'body', sel = null; // sel: part id | 'new'
  const msg = el('div', 'adMsg'), tabs = el('div', 'adLine'), list = el('div'), form = el('div');
  root.append(tabs, msg, list, form);
  const say = (t, kind) => { msg.textContent = t || ''; msg.className = 'adMsg' + (kind ? ' ' + kind : ''); };
  const run = async (op, args, ok) => {
    say('...'); const r = await call(op, args);
    if (!r.ok) { say(ERR[r.code] || String(r.code || 'ERROR').toUpperCase(), 'bad'); return r; }
    const c = await call('itemList', {}); if (c.ok) useCatalog(c); // merge the server list into PARTS (the shop shows it from the next load)
    say(ok || 'SAVED', 'ok'); draw(); return r;
  };

  function drawForm() {
    form.textContent = '';
    const p = sel === 'new' ? null : partList(cat).find((x) => x.id === sel);
    if (!p && sel !== 'new') return;
    const custom = sel === 'new' || isCustomId(sel);
    const name = el('input'); name.maxLength = 20; name.value = p ? p.name : '';
    const price = el('input'); price.type = 'number'; price.min = 0; price.max = 1000000; price.step = 1; price.value = p ? p.price : 0;
    const ach = select([['', 'NONE (PRICE)'], ...ACHIEVEMENTS.map((a) => [a.id, a.name.toUpperCase()])], p && p.ach || '');
    const base = select(BUILTIN_PARTS[cat].map((b) => [b.id, b.name.toUpperCase()]), p && p.base || BUILTIN_PARTS[cat][0].id); base.disabled = !custom;
    const tint = el('input'); tint.type = 'checkbox'; tint.checked = !!(p && p.color != null && p.custom);
    const col = el('input'); col.type = 'color'; col.value = hex(p && p.color != null ? p.color : 0xff5a1f);
    const hid = el('input'); hid.type = 'checkbox'; hid.checked = !!(p && p.hidden);
    form.append(el('b', '', sel === 'new' ? 'NEW ' + CAT_LABEL[cat] + ' ITEM' : (p.custom ? 'CUSTOM: ' : 'BUILT-IN: ') + p.id), field('NAME', name), field('PRICE', price), field('ACHIEVEMENT', ach));
    if (custom) form.append(field('SHAPE OF', base), field(cat === 'glow' ? 'COLOUR' : 'TINT', col), field(cat === 'glow' ? '' : 'USE TINT', tint), field('HIDDEN', hid));
    form.append(btn('SAVE', 'primary', async () => {
      const item = { name: name.value, price: Number(price.value), ach: ach.value || null };
      if (custom) Object.assign(item, { base: base.value, cat, color: tint.checked || cat === 'glow' ? parseInt(col.value.slice(1), 16) : null, hidden: hid.checked });
      const r = await run('itemSave', sel === 'new' ? { item } : { id: sel, item }, 'SAVED');
      if (r.ok && r.item) sel = r.item.id;
      draw();
    }));
    if (sel !== 'new') form.append(btn(custom ? 'HIDE FROM SHOP' : 'RESET TO DEFAULT', '', async () => { await run('itemDelete', { id: sel }, custom ? 'HIDDEN' : 'RESET'); }));
  }

  function draw() {
    tabs.textContent = ''; list.textContent = '';
    for (const c of CATS) { const b = btn(CAT_LABEL[c], c === cat ? 'sel' : '', () => { cat = c; sel = null; draw(); }); tabs.appendChild(b); }
    tabs.appendChild(btn('+ NEW', 'primary', () => { sel = 'new'; draw(); }));
    for (const p of partList(cat)) {
      const tag = [p.custom ? 'CUSTOM' : '', p.hidden ? 'HIDDEN' : '', p.ach ? 'ACH ' + p.ach : p.price + ' SBC'].filter(Boolean).join(' | ');
      const b = btn(`${p.name.toUpperCase()}  [${tag}]`, p.id === sel ? 'sel' : '', () => { sel = p.id; draw(); }); list.appendChild(b);
    }
    drawForm();
  }

  (async () => { say('...'); const r = await call('itemList', {}); if (r.ok) { useCatalog(r); say(''); } else say(ERR[r.code] || String(r.code).toUpperCase(), 'bad'); draw(); })();
}
registerAdminTab('garage', 'GARAGE', mountGarage);
