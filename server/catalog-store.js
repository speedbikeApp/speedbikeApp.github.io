// Garage catalog storage (server-only). Interface (async): all() -> {items:[custom item], overrides:{builtinId:{name?,price?,ach?}}}, put(id, doc), del(id), flush().
// Custom items have ids 'c_...' (js/parts.js isCustomId); any other id is an override of a built-in part.
// Drop table (loot boxes): getDrops() -> table|null (null = defaults), putDrops(t). Firestore `config/drops` (one doc), JSON key `__drops`. Same Admin-SDK-only rule.
// Firestore: `items/{id}` = the item / override document. Admin SDK only: firestore.rules has no rule for it, so clients are denied (they read GET /catalog).
import fs from 'node:fs';
import path from 'node:path';

const split = (docs) => { const items = [], overrides = {}; for (const [id, d] of Object.entries(docs)) if (id === '__drops') continue; else if (id.startsWith('c_')) items.push({ ...d, id }); else overrides[id] = d; return { items, overrides }; };

export function createJsonCatalogStore(file) {
  let d = {};
  if (file) { try { d = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT') console.warn(`[catalog] could not read ${file} (${e.message}); starting empty`); } }
  let chain = Promise.resolve();
  const save = () => { if (file) chain = chain.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(d, null, 1)); await fs.promises.rename(tmp, file);
  }).catch((e) => console.error('[catalog] save failed:', e.message)); };
  return {
    kind: 'json',
    async all() { return split(structuredClone(d)); },
    async put(id, doc) { d[id] = structuredClone(doc); save(); },
    async del(id) { delete d[id]; save(); },
    async getDrops() { return d.__drops ? structuredClone(d.__drops) : null; },
    async putDrops(t) { d.__drops = structuredClone(t); save(); },
    flush: () => chain,
  };
}

export function createFirestoreCatalogStore(db) {
  const col = db.collection('items');
  return {
    kind: 'firestore',
    async all() { return split(Object.fromEntries((await col.get()).docs.map((x) => [x.id, x.data()]))); },
    async put(id, doc) { await col.doc(id).set(doc); },
    async del(id) { await col.doc(id).delete(); },
    async getDrops() { const x = await db.doc('config/drops').get(); return x.exists ? x.data() : null; },
    async putDrops(t) { await db.doc('config/drops').set(t); },
    flush: async () => {},
  };
}
