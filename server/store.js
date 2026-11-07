// Rank storage. Interface: async getRank(uid) -> rank record, async setRank(uid, rank, username).
// JSON file (dev / no credentials) or Firestore `ranks/{uid}` through the Admin SDK (clients can only read, see firestore.rules).
import fs from 'node:fs';
import path from 'node:path';
import { defaultRank, normalizeRank, migrateRank } from '../js/ranks.js';
// Stored records carry `v` (js/ranks.js RANK_VERSION). Reads migrate old records (no `v`: divisions were numbered backwards); the next setRank writes the new version.

export function createJsonStore(file) {
  const data = new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [uid, v] of Object.entries(obj)) data.set(uid, { ...migrateRank(v), username: typeof v.username === 'string' ? v.username : '' });
  } catch (e) {
    if (e.code !== 'ENOENT') { // corrupt file: keep it for inspection, start empty
      console.warn(`[store] could not read ${file} (${e.message}); starting empty`);
      try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
    }
  }
  let chain = Promise.resolve();
  // Write to a temp file then rename: a crash mid-write never leaves a truncated ranks.json. Writes are serialized.
  const save = () => (chain = chain.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(data), null, 1));
    await fs.promises.rename(tmp, file);
  }).catch((e) => console.error('[store] save failed:', e.message)));
  return {
    kind: 'json',
    async getRank(uid) { const v = data.get(uid); return v ? migrateRank(v) : defaultRank(); },
    async setRank(uid, rank, username = '') { data.set(uid, { ...normalizeRank(rank), username }); await save(); },
    flush: () => chain,
  };
}

export function createFirestoreStore(db) {
  const col = db.collection('ranks');
  return {
    kind: 'firestore',
    async getRank(uid) { const s = await col.doc(uid).get(); return s.exists ? migrateRank(s.data()) : defaultRank(); },
    async setRank(uid, rank, username = '') { await col.doc(uid).set({ ...normalizeRank(rank), username }); },
    flush: async () => {},
  };
}
