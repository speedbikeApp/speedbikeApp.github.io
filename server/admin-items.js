// GARAGE tab ops + the public catalog. args are untrusted (admin.js already verified the sender is an admin). Ops:
// (results never use the key `id`: the router uses it to correlate replies)
//   itemList {} -> {items:[custom], overrides:{id:{name?,price?,ach?}}}
//   itemSave {id?, item}  no id: create custom {cat, name, price, ach?, base (built-in id, or 'none' for body / tire / rim), shapes? (js/shapedef.js; null clears), color?} -> {item}; id 'c_..': update (cat fixed; hidden:bool allowed); built-in id: override {name?, price?, ach?:id|null}
//   itemDelete {id}       custom: hide it (owners keep it; never really deleted); built-in: remove its override
// DROPS: dget / dset / dreset (see below). LEVELS: lget {} / lset {levels} / lreset {} -> {levels} (js/leveldef.js).
// QUESTS: qget {} / qset {quests} / qreset {} -> {quests} (js/questdef.js validateQuestConfig). EVENTS: eget {} -> {events}; eset {event} (create / replace by id) -> {event, events}; edel {id} -> {events}.
// GET /catalog -> {ok, items:[custom], overrides, drops, levels, quests, event (the one running now or null)} for everybody (js/catalog.js). The catalog is cached in memory (this process is the only writer).
import crypto from 'node:crypto';
import { BUILTIN_PARTS, CATS, isCustomId } from '../js/parts.js';
import { isAchievementId } from '../js/achievements.js';
import { DEFAULT_DROPS, validateDrops } from '../js/dropdef.js';
import { DEFAULT_LEVELS, validateLevels } from '../js/leveldef.js';
import { DEFAULT_QUESTS, validateQuestConfig, validateEvent, eventActive } from '../js/questdef.js';
import { validateShapes } from '../js/shapedef.js';
import { adminError as E } from './admin.js';
import { originAllowed } from './login.js';

export const MAX_EVENTS = 50, MAX_ITEMS = 200, MAX_PRICE = 1000000, NAME_OK = /^[A-Za-z0-9 _.'-]{1,20}$/;
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
  if (typeof it.base !== 'string' || !(it.base === 'none' && it.cat !== 'glow' || BUILTIN_PARTS[it.cat].some((p) => p.id === it.base))) throw E('bad_base');
  const sh = validateShapes(it.cat, it.shapes); if (!sh.ok || (it.base === 'none' && !sh.shapes.length)) throw E('bad_shapes');
  const o = { id: it.id, cat: it.cat, name: name(it.name), price: price(it.price), base: it.base };
  if (sh.shapes.length) o.shapes = sh.shapes;
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
  let cache = null, drops, levels, quests, events;
  const get = async () => cache || (cache = await store.all());
  return {
    get,
    // drop table: only validated tables are served; missing / invalid stored doc = defaults
    async getDrops() { if (!drops) drops = validateDrops(await store.getDrops()) || structuredClone(DEFAULT_DROPS); return drops; },
    async putDrops(t) { await store.putDrops(t); drops = t; },
    async getLevels() { if (!levels) { const v = validateLevels(await store.getLevels()); levels = v.ok ? v.levels : { ...DEFAULT_LEVELS }; } return levels; },
    async putLevels(t) { await store.putLevels(t); levels = t; },
    async getQuests() { if (!quests) { const v = validateQuestConfig(await store.getQuests()); quests = v.ok ? v.config : structuredClone(DEFAULT_QUESTS); } return quests; },
    async putQuests(c) { await store.putQuests(c); quests = c; },
    async getEvents() { if (!events) events = (await store.getEvents()).map((e) => validateEvent(e)).filter((v) => v.ok).map((v) => v.event); return events; },
    async putEvents(l) { await store.putEvents(l); events = l; },
    /** The event to serve: the one running at `now` (latest start wins when two overlap), else the soonest upcoming one, else null. */
    async activeEvent(now = Date.now()) {
      const l = await this.getEvents();
      return l.filter((e) => eventActive(e, now)).sort((a, b) => b.start - a.start)[0] || l.filter((e) => e.start > now).sort((a, b) => a.start - b.start)[0] || null;
    },
    getFeatured: () => store.getFeatured(),
    putFeatured: (m) => store.putFeatured(m),
    getBots: () => store.getBots(),
    putBots: (on) => store.putBots(on),
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
  admin.register('lget', async () => ({ levels: await catalog.getLevels() }));
  admin.register('lset', async (a, ctx) => {
    const v = validateLevels(a.levels); if (!v.ok) throw E('bad_levels');
    await catalog.putLevels(v.levels); log(`[admin] ${ctx.uid} levels set`); return { levels: v.levels };
  });
  admin.register('lreset', async (a, ctx) => { const t = { ...DEFAULT_LEVELS }; await catalog.putLevels(t); log(`[admin] ${ctx.uid} levels reset`); return { levels: t }; });
  admin.register('qget', async () => ({ quests: await catalog.getQuests() }));
  admin.register('qset', async (a, ctx) => {
    const v = validateQuestConfig(a.quests); if (!v.ok) throw E('bad_quests');
    await catalog.putQuests(v.config); log(`[admin] ${ctx.uid} quests set`); return { quests: v.config };
  });
  admin.register('qreset', async (a, ctx) => { const c = structuredClone(DEFAULT_QUESTS); await catalog.putQuests(c); log(`[admin] ${ctx.uid} quests reset`); return { quests: c }; });
  admin.register('eget', async () => ({ events: await catalog.getEvents() }));
  admin.register('eset', async (a, ctx) => {
    const v = validateEvent(a.event); if (!v.ok) throw E('bad_event');
    const list = (await catalog.getEvents()).filter((e) => e.id !== v.event.id);
    if (list.length >= MAX_EVENTS) throw E('too_many');
    list.push(v.event); list.sort((x, y) => x.start - y.start);
    await catalog.putEvents(list); log(`[admin] ${ctx.uid} event set ${v.event.id}`); return { event: v.event, events: list };
  });
  admin.register('edel', async (a, ctx) => {
    const all = await catalog.getEvents(), list = all.filter((e) => e.id !== a.id);
    if (list.length === all.length) throw E('not_found');
    await catalog.putEvents(list); log(`[admin] ${ctx.uid} event delete ${a.id}`); return { events: list };
  });
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
    try { const c = await catalog.get(), drops = await catalog.getDrops(), levels = await catalog.getLevels(), quests = await catalog.getQuests(), event = await catalog.activeEvent(); res.writeHead(200, h); res.end(JSON.stringify({ ok: true, items: c.items, overrides: c.overrides, drops, levels, quests, event })); }
    catch (e) { log('[catalog] failed:', e.message); res.writeHead(503, { ...h, 'Cache-Control': 'no-store' }); res.end('{"ok":false,"code":"unavailable"}'); }
  };
}
