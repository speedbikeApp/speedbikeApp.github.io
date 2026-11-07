// Social layer (friends). The server is the only writer of friendships; clients send intents (fadd / faccept / ...) over their authenticated socket.
// Presence = "the uid has a live authenticated session" (index.js `byUid`); this class fans presence / rank / name changes out to online friends.
// A future party feature should hook in the same way: ask `isOnline(uid)`, push with `send(uid, msg)`, and use `friendsOf(uid)` for the friend set.
// Protocol: docs/MULTIPLAYER.md "Social". Storage: social-store.js (Firestore `friends/{uid}` or a dev JSON file).
export const LIMITS = { friends: 100, incoming: 50, outgoing: 50, search: 10 };
const TTL = 60000; // how long a resolved name / rank of an OFFLINE user is reused (online users are always live)

const pubRank = (r) => (r && typeof r === 'object' ? { tier: r.tier, div: r.div, wins: r.wins } : null);
const without = (list, v) => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); };

// deps: { store (social store), getRank(uid) -> rank, liveRank(uid) -> rank | undefined, isOnline(uid), send(uid, msg), log, now }
export class Social {
  constructor(deps) {
    this.d = { log: () => {}, now: () => Date.now(), ...deps };
    this.names = new Map();   // uid -> { username, at }
    this.ranks = new Map();   // uid -> { rank, at }
    this.sets = new Map();    // uid (connected) -> Set(friend uids), for presence fan-out without a read
  }

  // ---- resolution helpers ----
  async resolveNames(uids) { // -> { map: Map uid->username, missing: [uid] }; throws when the backend fails (never prunes on errors)
    const now = this.d.now(), map = new Map(), need = [];
    for (const u of uids) { const c = this.names.get(u); if (c && now - c.at < TTL) map.set(u, c.username); else need.push(u); }
    const missing = [];
    if (need.length) {
      const got = await this.d.store.getUsers(need);
      for (const u of need) { const g = got.get(u); if (g) { this.names.set(u, { username: g.username, at: now }); map.set(u, g.username); } else { this.names.delete(u); missing.push(u); } }
    }
    return { map, missing };
  }
  async rankOf(uid) {
    const live = this.d.liveRank(uid);
    if (live) return pubRank(live);
    const c = this.ranks.get(uid), now = this.d.now();
    if (c && now - c.at < TTL) return pubRank(c.rank);
    let r = null;
    try { r = await this.d.getRank(uid); } catch (e) { this.d.log('[social] rank read failed:', e.message); }
    if (r) this.ranks.set(uid, { rank: r, at: now });
    return pubRank(r);
  }
  friendsOf(uid) { return [...(this.sets.get(uid) || [])]; }
  isFriend(a, b) { return !!this.sets.get(a)?.has(b); } // a must be connected (the set is kept for connected users only)

  // Removes links to accounts that no longer exist (deleted users). Also drops their own friendship doc.
  async prune(uid, ghosts) {
    for (const g of ghosts) {
      await this.d.store.update([uid, g], (m) => { const a = m.get(uid), b = m.get(g); for (const k of ['friends', 'incoming', 'outgoing']) { without(a[k], g); b[k].length = 0; } return { ok: true }; });
      await this.d.store.deleteLinks(g).catch(() => {});
    }
  }

  // Full picture for one user: { friends:[{uid,username,rank,online}], incoming:[{uid,username,rank}], outgoing:[...] }
  async snapshot(uid) {
    let links = await this.d.store.getLinks(uid);
    const all = [...new Set([...links.friends, ...links.incoming, ...links.outgoing])];
    const { map, missing } = await this.resolveNames(all);
    if (missing.length) { await this.prune(uid, missing); links = await this.d.store.getLinks(uid); }
    const mk = async (u) => ({ uid: u, username: map.get(u) || '?', rank: await this.rankOf(u) });
    const friends = await Promise.all(links.friends.filter((u) => map.has(u)).map(async (u) => ({ ...(await mk(u)), online: this.d.isOnline(u) })));
    const incoming = await Promise.all(links.incoming.filter((u) => map.has(u)).map(mk));
    const outgoing = await Promise.all(links.outgoing.filter((u) => map.has(u)).map(mk));
    if (this.sets.has(uid)) this.sets.set(uid, new Set(links.friends));
    return { friends, incoming, outgoing };
  }
  async push(uid) { // send a fresh snapshot to a connected user
    if (!this.d.isOnline(uid)) return;
    try { this.d.send(uid, { t: 'friends', ...(await this.snapshot(uid)) }); } catch (e) { this.d.log('[social] snapshot failed:', e.message); }
  }

  // ---- presence ----
  async onConnect(uid, username) {
    await this.d.store.noteUser(uid, username);
    this.names.set(uid, { username, at: this.d.now() });
    const links = await this.d.store.getLinks(uid);
    this.sets.set(uid, new Set(links.friends));
    for (const f of links.friends) if (this.d.isOnline(f)) this.d.send(f, { t: 'fpresence', uid, online: true });
    await this.push(uid);
  }
  onDisconnect(uid) { // call after the uid's last session is gone
    const friends = this.sets.get(uid) || new Set();
    this.sets.delete(uid);
    for (const f of friends) if (this.d.isOnline(f)) this.d.send(f, { t: 'fpresence', uid, online: false });
  }
  noteRank(uid, rank) {
    this.ranks.set(uid, { rank, at: this.d.now() });
    for (const f of this.friendsOf(uid)) if (this.d.isOnline(f)) this.d.send(f, { t: 'frank', uid, rank: pubRank(rank) });
  }
  // The account's username may have changed (client asks after the account panel rename): re-read it (dev auth: `devName`), tell friends.
  async refreshName(uid, devName) {
    let name = devName;
    if (!name) { this.names.delete(uid); name = (await this.resolveNames([uid])).map.get(uid); }
    if (!name) return null;
    this.names.set(uid, { username: name, at: this.d.now() });
    if (devName) await this.d.store.noteUser(uid, name);
    for (const f of this.friendsOf(uid)) if (this.d.isOnline(f)) this.d.send(f, { t: 'fname', uid, username: name });
    return name;
  }

  // ---- search ----
  // lower: normalized lowercase prefix (protocol.js normalizeQuery). -> { ok, results:[{uid,username,rank,rel}] }
  async search(me, lower) {
    const [links, found] = await Promise.all([this.d.store.getLinks(me), this.d.store.findByPrefix(lower, LIMITS.search + 1)]);
    const rows = found.filter((f) => f.uid !== me).slice(0, LIMITS.search);
    const results = await Promise.all(rows.map(async (f) => ({
      uid: f.uid, username: f.username, rank: await this.rankOf(f.uid),
      rel: links.friends.includes(f.uid) ? 'friend' : links.incoming.includes(f.uid) ? 'incoming' : links.outgoing.includes(f.uid) ? 'outgoing' : 'none',
    })));
    return { ok: true, results };
  }

  // ---- mutations. Each returns { ok:true, state } or { ok:false, code }. ----
  async #run(me, other, fn) {
    if (me === other) return { ok: false, code: 'self' };
    const res = await this.d.store.update([me, other], fn);
    if (res.ok) await Promise.all([this.push(me), this.push(other)]);
    return res;
  }
  async request(me, target) {
    if (me === target) return { ok: false, code: 'self' };
    const { missing } = await this.resolveNames([target]);
    if (missing.length) return { ok: false, code: 'not_found' };
    const res = await this.#run(me, target, (m) => {
      const a = m.get(me), b = m.get(target);
      if (a.friends.includes(target)) return { ok: false, code: 'already_friends' };
      if (a.incoming.includes(target)) { // they already asked us: accept instead
        if (a.friends.length >= LIMITS.friends) return { ok: false, code: 'limit_friends' };
        if (b.friends.length >= LIMITS.friends) return { ok: false, code: 'target_limit_friends' };
        without(a.incoming, target); without(b.outgoing, me); a.friends.push(target); b.friends.push(me);
        return { ok: true, state: 'friends' };
      }
      if (a.outgoing.includes(target)) return { ok: false, code: 'already_sent' };
      if (a.friends.length >= LIMITS.friends) return { ok: false, code: 'limit_friends' };
      if (a.outgoing.length >= LIMITS.outgoing) return { ok: false, code: 'limit_outgoing' };
      if (b.incoming.length >= LIMITS.incoming) return { ok: false, code: 'target_limit_incoming' };
      a.outgoing.push(target); b.incoming.push(me);
      return { ok: true, state: 'sent' };
    });
    if (res.ok) this.#event(target, res.state === 'friends' ? 'accepted' : 'request', me);
    return res;
  }
  async accept(me, from) {
    const res = await this.#run(me, from, (m) => {
      const a = m.get(me), b = m.get(from);
      if (a.friends.includes(from)) return { ok: true, state: 'friends', already: true }; // idempotent (double click)
      if (!a.incoming.includes(from)) return { ok: false, code: 'no_request' };
      if (a.friends.length >= LIMITS.friends) return { ok: false, code: 'limit_friends' };
      if (b.friends.length >= LIMITS.friends) return { ok: false, code: 'target_limit_friends' };
      without(a.incoming, from); without(b.outgoing, me); a.friends.push(from); b.friends.push(me);
      return { ok: true, state: 'friends' };
    });
    if (res.ok && !res.already) this.#event(from, 'accepted', me);
    return res;
  }
  decline(me, from) {
    return this.#run(me, from, (m) => { const a = m.get(me), b = m.get(from); without(a.incoming, from); without(b.outgoing, me); return { ok: true, state: 'none' }; });
  }
  cancel(me, to) {
    return this.#run(me, to, (m) => { const a = m.get(me), b = m.get(to); without(a.outgoing, to); without(b.incoming, me); return { ok: true, state: 'none' }; });
  }
  remove(me, other) { // both sides, plus any stale pending request either way
    return this.#run(me, other, (m) => {
      const a = m.get(me), b = m.get(other);
      for (const k of ['friends', 'incoming', 'outgoing']) { without(a[k], other); without(b[k], me); }
      return { ok: true, state: 'none' };
    });
  }
  #event(uid, kind, from) { // small toast for the other side when online
    if (!this.d.isOnline(uid)) return;
    const username = this.names.get(from)?.username;
    if (username) this.d.send(uid, { t: 'fevent', kind, uid: from, username });
  }
}
