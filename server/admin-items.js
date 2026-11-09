// GARAGE tab ops + the public catalog. args are untrusted (admin.js already verified the sender is an admin). Ops:
// (results never use the key `id`: the router uses it to correlate replies)
//   itemList {} -> {items:[custom], overrides:{id:{name?,price?,ach?}}}
//   itemSave {id?, item}  no id: create custom {cat, name, price, ach?, base, color?} -> {item}; id 'c_..': update (cat fixed; hidden:bool allowed); built-in id: override {name?, price?, ach?:id|null}
//   itemDelete {id}       custom: hide it (owners keep it; never really deleted); built-in: remove its override
// DROPS: dget / dset / dreset (see below).
// GET /catalog -> {ok, items:[custom], overrides, drops} for everybody (js/catalog.js). The catalog is cached in memory (this process is the only writer).
import crypto from 'node:crypto';
import { BUILTIN_PARTS, CATS, isCustomId } from '../js/parts.js';
import { isAchievementId } from '../js/achievements.js';
import { DEFAULT_DROPS, validateDrops } from '../js/dropdef.js';
import { adminError as E } from './admin.js';
import { originAllowed } from './login.js';

export const MAX_ITEMS = 200, MAX_PRICE = 1000000, NAME_OK = /^[A-Za-z0-9 _.'-]{1,20}$/;
const isInt = (v) => Number.isInteger(v);
const builtin = (id) => CATS.find((c) => BUILTIN_PARTS[c].some((p) => p.id === id));
const ach = (v) => { if (typeof v !== 'string' || !isAchievementId(v)) throw E('bad_ach'); return v; };
const name = (v) => { const n = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''; if (!NAME_OK.test(n)) throw E('bad_name'); return n; };
const price = (v) => { if (!isInt(v) || v < 0 || v > MAX_PRICE) throw E('bad_price'); return v; };
const color = (v) => { if (!isInt(v) || v < 0 || v > 0xffffff) throw E('bad_color'); return v; };
const none = (v) => v === undefined || v === null || v === '';

/** Full custom item -> clean item or throws. */
export function cleanItem(it) {
  if (!it || typeof it !== 'object') throw E('bad_item');
  if (!CATS.includes(it.cat)) throw E('bad_cat');
  if (typeof it.base !== 'string' || !BUILTIN_PARTS[it.cat].some((p) => p.id === it.base)) throw E('bad_base');
  const o = { id: it.id, cat: it.cat, name: name(it.name), price: price(it.price), base: it.base };
  if (!none(it.ach)) o.ach = ach(it.ach);
  if (!none(it.color)) o.color = color(it.color);
  if (it.hidden === true) o.hidden = true;
  return o;
}
/** Override of a built-in part -> clean {name?, price?, ach?: id|null} or throws. */
export function cleanOverride(it) {
  if (!it || typeof it !== 'object') throw E('bad_item');
  const o = {};
  if (it.name !== undefined) o.name = name(it.name);
  if (it.price !== undefined) o.price = price(it.price);
  if (it.ach !== undefined) o.ach = none(it.ach) ? null : ach(it.ach);
  return o;
}

export function createCatalog(store) {
  let cache = null, drops;
  const get = async () => cache || (cache = await store.all());
  return {
    get,
    // drop table: only validated tables are served; missing / invalid stored doc = defaults
    async getDrops() { if (!drops) drops = validateDrops(await store.getDrops()) || structuredClone(DEFAULT_DROPS); return drops; },
    async putDrops(t) { await store.putDrops(t); drops = t; },
    getFeatured: () => store.getFeatured(),
    putFeatured: (m) => store.putFeatured(m),
    async putItem(it) { const c = await get(); await store.put(it.id, it); const i = c.items.findIndex((x) => x.id === it.id); if (i >= 0) c.items[i] = it; else c.items.push(it); },
    async putOverride(id, o) { const c = await get(); if (o) { await store.put(id, o); c.overrides[id] = o; } else { await store.del(id); delete c.overrides[id]; } },
  };
}

export function registerItemOps({ admin, catalog, log = () => {} }) {
  // DROPS tab: dget {} -> {drops}; dset {drops} -> {drops} (clean copy); dreset {} -> {drops} (defaults)
  admin.register('dget', async () => ({ drops: await catalog.getDrops() }));
  admin.register('dset', async (a, ctx) => {
    const t = validateDrops(a.drops); if (!t) throw E('bad_drops');
    await catalog.putDrops(t); log(`[admin] ${ctx.uid} drops set`); return { drops: t };
  });
  admin.register('dreset', async (a, ctx) => { const t = structuredClone(DEFAULT_DROPS); await catalog.putDrops(t); log(`[admin] ${ctx.uid} drops reset`); return { drops: t }; });
  admin.register('itemList', async () => catalog.get());
  admin.register('itemSave', async (a, ctx) => {
    const c = await catalog.get(), id = a.id, raw = a.item;
    if (id === undefined || id === null) {
      if (c.items.length >= MAX_ITEMS) throw E('too_many');
      const it = cleanItem({ ...raw, hidden: false, id: 'c_' + crypto.randomBytes(5).toString('hex') });
      await catalog.putItem(it); log(`[admin] ${ctx.uid} item create ${it.id} ${it.cat}/${it.base}`);
      return { item: it };
    }
    if (isCustomId(id)) {
      const old = c.items.find((x) => x.id === id); if (!old) throw E('not_found');
      if (!raw || typeof raw !== 'object') throw E('bad_item');
      const it = cleanItem({ ...old, ...raw, id, cat: old.cat });
      await catalog.putItem(it); log(`[admin] ${ctx.uid} item update ${id}`);
      return { item: it };
    }
    if (!builtin(id)) throw E('not_found');
    const o = cleanOverride(raw);
    await catalog.putOverride(id, { ...(c.overrides[id] || {}), ...o }); log(`[admin] ${ctx.uid} item override ${id} ${JSON.stringify(o)}`);
    return { override: c.overrides[id] };
  });
  admin.register('itemDelete', async (a, ctx) => {
    const c = await catalog.get(), id = a.id;
    if (isCustomId(id)) {
      const old = c.items.find((x) => x.id === id); if (!old) throw E('not_found');
      await catalog.putItem({ ...old, hidden: true }); log(`[admin] ${ctx.uid} item hide ${id}`); return { hidden: true };
    }
    if (!builtin(id)) throw E('not_found');
    await catalog.putOverride(id, null); log(`[admin] ${ctx.uid} item reset ${id}`);
    return { reset: true };
  });
}

/** GET /catalog handler. CORS: same allowed origins as POST /auth/login. */
export function createCatalogHandler({ catalog, allowedOrigins = [], production = false, log = () => {} }) {
  return async (req, res) => {
    const origin = req.headers.origin, h = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', Vary: 'Origin' };
    if (origin && originAllowed(origin, allowedOrigins, production)) h['Access-Control-Allow-Origin'] = origin;
    if (req.method !== 'GET') { res.writeHead(405, h); return res.end('{"ok":false}'); }
    try { const c = await catalog.get(), drops = await catalog.getDrops(); res.writeHead(200, h); res.end(JSON.stringify({ ok: true, items: c.items, overrides: c.overrides, drops })); }
    catch (e) { log('[catalog] failed:', e.message); res.writeHead(503, { ...h, 'Cache-Control': 'no-store' }); res.end('{"ok":false,"code":"unavailable"}'); }
  };
}
