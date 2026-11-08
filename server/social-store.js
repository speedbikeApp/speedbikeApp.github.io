// Social storage: friendships + a user directory (uid -> display name, prefix search).
// Interface (all async, the server is the only writer):
//   getLinks(uid)            -> { friends:[uid], incoming:[uid], outgoing:[uid] }
//   update(uids, fn)         -> runs fn(Map uid->links) atomically on those users; fn mutates the links and returns a result. If the result
//                               is { ok:false } nothing is written. Returns fn's result.
//   getUsers(uids)           -> Map uid -> { username } | null (null = the account no longer exists). THROWS on backend errors (never treat
//                               an error as "deleted").
//   findByPrefix(lower, n)   -> [{ uid, username }]  (usernames whose lowercase starts with `lower`)
//   listUsers(after, n)      -> [{ uid, username, key }] up to n users ordered by key (= lowercase username) after the cursor `after` ('' = start)
//   noteUser(uid, username)  -> dev mode only: remembers who connected (Firestore has users/{uid} + usernames/{lowercase} already)
//   deleteLinks(uid)         -> drops the friendship doc of a deleted account
//   flush()
// Firestore model: `friends/{uid}` = { friends:[uid], incoming:[uid], outgoing:[uid] } (Admin SDK only: firestore.rules has no rule for it, so clients are denied).
import fs from 'node:fs';
import path from 'node:path';

const emptyLinks = () => ({ friends: [], incoming: [], outgoing: [] });
const cleanList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);
export const normalizeLinks = (raw) => (raw && typeof raw === 'object' ? { friends: cleanList(raw.friends), incoming: cleanList(raw.incoming), outgoing: cleanList(raw.outgoing) } : emptyLinks());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Dev / tests: one JSON file (or memory only when `file` is falsy), same semantics as the Firestore store.
export function createJsonSocialStore(file) {
  const links = new Map(), users = new Map();
  if (file) {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [uid, v] of Object.entries(o.links || {})) links.set(uid, normalizeLinks(v));
      for (const [uid, v] of Object.entries(o.users || {})) if (v && typeof v.username === 'string') users.set(uid, { username: v.username });
    } catch (e) {
      if (e.code !== 'ENOENT') { console.warn(`[social] could not read ${file} (${e.message}); starting empty`); try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch { /* ignore */ } }
    }
  }
  let chain = Promise.resolve();
  const save = () => { if (!file) return chain; return (chain = chain.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ links: Object.fromEntries(links), users: Object.fromEntries(users) }, null, 1));
    await fs.promises.rename(tmp, file);
  }).catch((e) => console.error('[social] save failed:', e.message))); };
  const get = (uid) => links.get(uid) || emptyLinks();
  return {
    kind: 'json',
    async getLinks(uid) { return structuredClone(get(uid)); },
    async update(uids, fn) { // no awaits between read and write: atomic within the single process
      const m = new Map(uids.map((u) => [u, structuredClone(get(u))]));
      const res = await fn(m);
      if (res && res.ok === false) return res;
      for (const [u, l] of m) links.set(u, l);
      save();
      return res;
    },
    async getUsers(uids) { return new Map(uids.map((u) => [u, users.get(u) ? { ...users.get(u) } : null])); },
    async findByPrefix(lower, limit = 10) {
      const out = [];
      for (const [uid, u] of users) if (u.username.toLowerCase().startsWith(lower)) out.push({ uid, username: u.username });
      return out.sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase())).slice(0, limit);
    },
    async listUsers(after, limit = 20) {
      return [...users].map(([uid, u]) => ({ uid, username: u.username, key: u.username.toLowerCase() })).filter((u) => u.key > after).sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, limit);
    },
    async noteUser(uid, username) { if (!users.has(uid) || users.get(uid).username !== username) { users.set(uid, { username }); save(); } },
    async deleteUser(uid) { users.delete(uid); links.delete(uid); save(); }, // tests (simulates account deletion)
    async deleteLinks(uid) { links.delete(uid); save(); },
    flush: () => chain,
  };
}

export function createFirestoreSocialStore(db, FieldPath) {
  const col = db.collection('friends'), users = db.collection('users'), names = db.collection('usernames');
  return {
    kind: 'firestore',
    async getLinks(uid) { const s = await col.doc(uid).get(); return s.exists ? normalizeLinks(s.data()) : emptyLinks(); },
    async update(uids, fn) {
      const refs = uids.map((u) => col.doc(u));
      return db.runTransaction(async (tx) => {
        const snaps = await tx.getAll(...refs);
        const m = new Map(uids.map((u, i) => [u, normalizeLinks(snaps[i].exists ? snaps[i].data() : null)]));
        const before = new Map([...m].map(([u, l]) => [u, structuredClone(l)]));
        const res = await fn(m);
        if (res && res.ok === false) return res;
        uids.forEach((u, i) => { if (!same(before.get(u), m.get(u))) tx.set(refs[i], m.get(u)); });
        return res;
      });
    },
    async getUsers(uids) {
      const out = new Map();
      for (let i = 0; i < uids.length; i += 100) {
        const part = uids.slice(i, i + 100);
        if (!part.length) continue;
        const snaps = await db.getAll(...part.map((u) => users.doc(u)));
        const got = snaps.map((s) => (s.exists ? (typeof s.data().username === 'string' ? s.data().username : '') : null));
        // users/{uid}.username is client-writable: show it only if usernames/{key} is reserved for this uid (else a player could pose as anyone, e.g. the admin)
        const keyOf = (n) => n.trim().replace(/\s+/g, ' ').toLowerCase(), check = got.map((n, k) => (n && n.length <= 32 ? k : -1)).filter((k) => k >= 0);
        const res = check.length ? await db.getAll(...check.map((k) => names.doc(keyOf(got[k])))) : [];
        const ok = new Set(check.filter((k, j) => res[j].exists && res[j].data().uid === part[k]));
        got.forEach((n, k) => out.set(part[k], n === null ? null : { username: ok.has(k) ? n : 'PLAYER' }));
      }
      return out;
    },
    async findByPrefix(lower, limit = 10) {
      const q = await names.where(FieldPath.documentId(), '>=', lower).where(FieldPath.documentId(), '<', lower + '\uf8ff').limit(limit).get();
      const found = q.docs.map((d) => ({ uid: d.data().uid, key: d.id })).filter((d) => typeof d.uid === 'string');
      const info = await this.getUsers(found.map((f) => f.uid));
      return found.filter((f) => info.get(f.uid)).map((f) => ({ uid: f.uid, username: info.get(f.uid).username }));
    },
    async listUsers(after, limit = 20) {
      let q = names.orderBy(FieldPath.documentId()); if (after) q = q.startAfter(after);
      const found = (await q.limit(limit).get()).docs.map((d) => ({ uid: d.data().uid, key: d.id })).filter((d) => typeof d.uid === 'string');
      const info = await this.getUsers(found.map((f) => f.uid));
      return found.filter((f) => info.get(f.uid)).map((f) => ({ uid: f.uid, username: info.get(f.uid).username, key: f.key }));
    },
    async noteUser() {},
    async deleteLinks(uid) { await col.doc(uid).delete(); },
    flush: async () => {},
  };
}
