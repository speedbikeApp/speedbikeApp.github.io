// MAPS tab: custom maps (server-only storage) + the pool the rooms draw from. Ops (admin only, see admin.js):
//   mapList {}                 -> {maps:[{id, name, platforms, spawns, updatedAt}]}
//   mapGet {id}                -> {mapId, map, updatedAt}   (NOT `id`: the router would overwrite the reply's request id)
//   mapSave {id?, map}         -> {mapId, map}      (no id = new; the server generates it; `map` is re-validated and normalised: js/mapdef.js)
//   mapDelete {id}             -> {}
// Map `modes` (mapdef.js MODE_IDS): which mode pools the map joins (rooms: poolFor; single-player: GET /maps, createMapsHandler).
// codes: bad_id, not_found, bad_map (+ `why` text), too_many.
// Store interface (async): list() -> [{id, map, updatedAt}], get(id), set(id, {map, updatedAt, by}), remove(id), flush().
// Firestore: `maps/{id}` = {map, updatedAt, by}. Admin SDK only (no client rule in firestore.rules). JSON store = dev / tests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateMap } from '../js/mapdef.js';
import { MODES } from '../js/modes.js';
import { adminError as E } from './admin.js';
import { originAllowed } from './login.js';

export const MAX_MAPS = 100;
export const ID_RE = /^u[0-9a-f]{10}$/;

export function createJsonMapStore(file) {
  let d = {};
  if (file) { try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.warn(`[maps] could not read ${file} (${e.message}); starting empty`); } }
  let chain = Promise.resolve();
  const save = () => { if (file) chain = chain.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(d)); await fs.promises.rename(tmp, file);
  }).catch((e) => console.error('[maps] save failed:', e.message)); };
  return {
    kind: 'json',
    async list() { return Object.entries(d).map(([id, v]) => ({ id, ...structuredClone(v) })); },
    async get(id) { return d[id] ? { id, ...structuredClone(d[id]) } : null; },
    async set(id, v) { d[id] = structuredClone(v); save(); },
    async remove(id) { delete d[id]; save(); },
    flush: () => chain,
  };
}

export function createFirestoreMapStore(db) {
  const col = db.collection('maps');
  return {
    kind: 'firestore',
    async list() { return (await col.get()).docs.map((x) => ({ id: x.id, ...x.data() })); },
    async get(id) { const s = await col.doc(id).get(); return s.exists ? { id, ...s.data() } : null; },
    async set(id, v) { await col.doc(id).set(v); },
    async remove(id) { await col.doc(id).delete(); },
    flush: async () => {},
  };
}

/** In-memory pool of valid custom maps {id: def}, loaded from the store at startup and after every save / delete. */
export function createMapPool(store, log = () => {}) {
  const defs = {};
  const pool = {
    defs,
    ready: null,
    async load() {
      const rows = await store.list(), next = {};
      for (const r of rows) { const v = validateMap(r.map); if (v.ok) next[r.id] = { id: r.id, ...v.map }; else log(`[maps] skipping invalid stored map ${r.id}: ${v.why}`); }
      for (const k of Object.keys(defs)) delete defs[k];
      Object.assign(defs, next); return Object.keys(defs).length;
    },
    /** For a room of `modeId`: { map:[ids], maps:{id:def} } with the custom maps added to the mode's pool, or null (no custom maps apply). */
    poolFor(modeId) {
      const base = MODES[modeId];
      if (!base) return null;
      const ids = Object.keys(defs).filter((id) => modeId === 'multimap' || defs[id].modes.includes(modeId)); // multimap: every map
      return ids.length ? { map: [].concat(base.map, ids), maps: Object.fromEntries(ids.map((id) => [id, defs[id]])) } : null;
    },
  };
  pool.ready = pool.load().catch((e) => log('[maps] load failed:', e.message));
  return pool;
}

/** GET /maps: the public list single-player draws from (validated defs only): {ok, maps:[{id, name, modes, def}]}. Same CORS / cache style as /catalog. */
export function createMapsHandler({ pool, allowedOrigins = [], production = false }) {
  return async (req, res) => {
    const origin = req.headers.origin, h = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', Vary: 'Origin' };
    if (origin && originAllowed(origin, allowedOrigins, production)) h['Access-Control-Allow-Origin'] = origin;
    if (req.method !== 'GET') { res.writeHead(405, h); return res.end('{"ok":false}'); }
    await pool.ready;
    res.writeHead(200, h);
    res.end(JSON.stringify({ ok: true, maps: Object.values(pool.defs).map(({ id, ...def }) => ({ id, name: def.name, modes: def.modes, def })) }));
  };
}

export function registerMapOps({ admin, mapStore, pool, log = () => {} }) {
  const checkId = (id) => { if (typeof id !== 'string' || !ID_RE.test(id)) throw E('bad_id'); return id; };
  const refresh = () => pool.load().catch((e) => log('[maps] refresh failed:', e.message));

  admin.register('mapList', async () => {
    const rows = await mapStore.list();
    return { maps: rows.map((r) => ({ id: r.id, name: r.map?.name || '?', platforms: r.map?.platforms?.length || 0, spawns: r.map?.spawns?.length || 0, updatedAt: r.updatedAt || 0 })).sort((a, b) => a.name.localeCompare(b.name)) };
  });
  admin.register('mapGet', async (a) => {
    const r = await mapStore.get(checkId(a.id)); if (!r) throw E('not_found');
    return { mapId: r.id, map: r.map, updatedAt: r.updatedAt || 0 };
  });
  admin.register('mapSave', async (a, ctx) => {
    const v = validateMap(a.map); if (!v.ok) throw E('bad_map', { why: v.why });
    let id;
    if (a.id !== undefined && a.id !== null) { id = checkId(a.id); if (!(await mapStore.get(id))) throw E('not_found'); }
    else {
      if ((await mapStore.list()).length >= MAX_MAPS) throw E('too_many');
      id = 'u' + crypto.randomBytes(5).toString('hex');
    }
    await mapStore.set(id, { map: v.map, updatedAt: admin.now(), by: ctx.uid });
    await refresh(); log(`[maps] ${ctx.uid} saved ${id} "${v.map.name}"`);
    return { mapId: id, map: v.map };
  });
  admin.register('mapDelete', async (a, ctx) => {
    const id = checkId(a.id); if (!(await mapStore.get(id))) throw E('not_found');
    await mapStore.remove(id); await refresh(); log(`[maps] ${ctx.uid} deleted ${id}`);
    return {};
  });
}
