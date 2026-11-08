// Admin storage (server-only). Interface (all async):
//   adminUids() -> Set(uid)       isAdmin(uid) -> bool        setAdmin(uid, bool)
//   getBan(uid) -> {until:ms|null, by, reason, at} | null    setBan(uid, ban | null)
//   getProgress(uid) -> object | null (users/{uid}.progress)  setProgress(uid, progress)
//   rename(uid, name) -> {ok:true} | {ok:false, code:'taken'|'not_found'}   keeps the usernames/{lower} reservation consistent
//   remove(uid) -> deletes the auth user, users/{uid}, its usernames reservation, bans/{uid}, admins/{uid} (friends + ranks are removed by the caller)
//   flush()
// Firestore model: `admins/{uid}` = {at, by} and `bans/{uid}` = {until, by, reason, at}. Admin SDK only: firestore.rules has no rule for them, so clients are denied.
// The JSON store (dev / tests) keeps usernames in the social store's user directory (`social`), progress + admins + bans in its own file.
import fs from 'node:fs';
import path from 'node:path';

export function createJsonAdminStore(file, social) {
  let d = { admins: {}, bans: {}, progress: {} };
  if (file) { try { d = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') console.warn(`[admin] could not read ${file} (${e.message}); starting empty`); } }
  let chain = Promise.resolve();
  const save = () => { if (file) chain = chain.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(d, null, 1)); await fs.promises.rename(tmp, file);
  }).catch((e) => console.error('[admin] save failed:', e.message)); };
  return {
    kind: 'json',
    async adminUids() { return new Set(Object.keys(d.admins)); },
    async isAdmin(uid) { return !!d.admins[uid]; },
    async setAdmin(uid, on, by) { if (on) d.admins[uid] = { at: Date.now(), by }; else delete d.admins[uid]; save(); },
    async getBan(uid) { return d.bans[uid] ? { ...d.bans[uid] } : null; },
    async setBan(uid, ban) { if (ban) d.bans[uid] = { ...ban }; else delete d.bans[uid]; save(); },
    async getProgress(uid) { return d.progress[uid] ? structuredClone(d.progress[uid]) : null; },
    async setProgress(uid, p) { d.progress[uid] = structuredClone(p); save(); },
    async rename(uid, name) {
      const lower = name.toLowerCase(), cur = (await social.getUsers([uid])).get(uid);
      if (!cur) return { ok: false, code: 'not_found' };
      const hit = (await social.findByPrefix(lower, 50)).find((u) => u.username.toLowerCase() === lower);
      if (hit && hit.uid !== uid) return { ok: false, code: 'taken' };
      await social.noteUser(uid, name); return { ok: true };
    },
    async remove(uid) { delete d.admins[uid]; delete d.bans[uid]; delete d.progress[uid]; await social.deleteUser?.(uid); save(); },
    flush: () => chain,
  };
}

export function createFirestoreAdminStore(db, fbAuth) {
  const admins = db.collection('admins'), bans = db.collection('bans'), users = db.collection('users'), names = db.collection('usernames');
  return {
    kind: 'firestore',
    async adminUids() { return new Set((await admins.get()).docs.map((x) => x.id)); },
    async isAdmin(uid) { return (await admins.doc(uid).get()).exists; },
    async setAdmin(uid, on, by) { if (on) await admins.doc(uid).set({ at: Date.now(), by: by || '' }); else await admins.doc(uid).delete(); },
    async getBan(uid) { const s = await bans.doc(uid).get(); return s.exists ? s.data() : null; },
    async setBan(uid, ban) { if (ban) await bans.doc(uid).set(ban); else await bans.doc(uid).delete(); },
    async getProgress(uid) { const s = await users.doc(uid).get(); return s.exists && s.data().progress ? s.data().progress : null; },
    async setProgress(uid, p) { await users.doc(uid).set({ progress: p }, { merge: true }); },
    async rename(uid, name) {
      const nref = (n) => names.doc(n.toLowerCase()), uref = users.doc(uid);
      return db.runTransaction(async (tx) => {
        const [u, target] = await Promise.all([tx.get(uref), tx.get(nref(name))]);
        if (!u.exists) return { ok: false, code: 'not_found' };
        if (target.exists && target.data().uid !== uid) return { ok: false, code: 'taken' };
        const old = u.data().username;
        const oldDoc = typeof old === 'string' && old.toLowerCase() !== name.toLowerCase() ? await tx.get(nref(old)) : null;
        tx.set(nref(name), { uid, createdAt: Date.now() });
        if (oldDoc && oldDoc.exists && oldDoc.data().uid === uid) tx.delete(nref(old));
        tx.update(uref, { username: name });
        return { ok: true };
      });
    },
    async remove(uid) {
      const u = await users.doc(uid).get(), old = u.exists ? u.data().username : null;
      try { await fbAuth.deleteUser(uid); } catch (e) { if (!e || e.code !== 'auth/user-not-found') throw e; }
      const b = db.batch();
      if (typeof old === 'string') { const n = await names.doc(old.toLowerCase()).get(); if (n.exists && n.data().uid === uid) b.delete(n.ref); }
      b.delete(users.doc(uid)); b.delete(bans.doc(uid)); b.delete(admins.doc(uid));
      await b.commit();
    },
    flush: async () => {},
  };
}
