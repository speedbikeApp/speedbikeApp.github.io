// Parties: up to 4 friends who queue and play TOGETHER (same room) and play UNRANKED. In-memory only (lost on restart, by design).
// Pure state machine over injected deps, like social.js: no sockets, no timers (the host calls tick(now)), so it is testable with a fake clock.
// Protocol: docs/MULTIPLAYER.md "Party". A party always has >= 2 members; it dissolves when one is left.
// Invites are stored per invitee (a party need not exist yet): accepting creates the party with the inviter as leader, or joins the inviter's
// CURRENT party. Anyone in a party may invite (their own friends only).
export const PARTY = { max: 4, inviteTtlMs: 60000, graceMs: 30000, maxInvitesPerUser: 10 };

const pubRank = (r) => (r && typeof r === 'object' ? { tier: r.tier, div: r.div, wins: r.wins } : null);
const fail = (code) => ({ ok: false, code });

// deps: { send(uid,msg), isOnline(uid), isFriend(a,b), isBusy(uid) (queued / in lobby / in a match), info(uid) -> {username, rank} | null,
//         onMemberOut(uid, party) (left / kicked / timed out: pull them out of queue / lobby), onDisband(uid) (the party is gone), log, now }
export class Parties {
  constructor(deps) {
    this.d = { log: () => {}, now: () => Date.now(), onMemberOut: () => {}, onDisband: () => {}, ...deps };
    this.parties = new Map();   // id -> { id, leader, members:[{uid, username, rank, seq, offlineAt}] }   (members in join order)
    this.byUid = new Map();     // uid -> party
    this.invites = new Map();   // invitee uid -> Map(from uid -> { from, username, expires })
    this.seq = 0; this.nextId = 0;
  }

  partyOf(uid) { return this.byUid.get(uid) || null; }
  busyParty(P) { return P.members.some((m) => this.d.isBusy(m.uid)); }

  view(P) { // the `party` payload
    return {
      id: P.id, leader: P.leader, max: PARTY.max,
      members: P.members.map((m) => {
        const i = this.d.info(m.uid);
        if (i) { m.username = i.username; m.rank = pubRank(i.rank); }
        return { uid: m.uid, username: m.username, rank: m.rank, online: this.d.isOnline(m.uid) };
      }),
    };
  }
  #push(P) { const v = this.view(P); for (const m of P.members) this.d.send(m.uid, { t: 'party', party: v }); }
  #pushInvites(uid) {
    const now = this.d.now(), list = [...(this.invites.get(uid) || new Map()).values()].filter((i) => i.expires > now);
    this.d.send(uid, { t: 'pinvites', invites: list.map((i) => ({ uid: i.from, username: i.username, ttl: i.expires - now })) });
  }
  #event(uids, kind, username) { for (const u of uids) this.d.send(u, { t: 'pevent', kind, username }); }
  #nameOf(uid) { return this.d.info(uid)?.username || this.byUid.get(uid)?.members.find((m) => m.uid === uid)?.username || '?'; }

  // ---- connection lifecycle ----
  onConnect(uid) { // (re)connected: resend our party + invites, clear the grace timer
    const P = this.partyOf(uid);
    if (P) { P.members.find((m) => m.uid === uid).offlineAt = null; this.#push(P); } else this.d.send(uid, { t: 'party', party: null });
    this.#pushInvites(uid);
  }
  onDisconnect(uid) { // the last session of this uid is gone: keep the seat for graceMs
    const P = this.partyOf(uid);
    if (!P) return;
    P.members.find((m) => m.uid === uid).offlineAt = this.d.now();
    this.#push(P);
  }

  // ---- intents: { ok:true } | { ok:false, code } ----
  invite(me, target) {
    if (me === target) return fail('self');
    if (!this.d.isFriend(me, target)) return fail('not_friend');
    if (!this.d.isOnline(target)) return fail('offline');
    const P = this.partyOf(me);
    if (P) {
      if (this.busyParty(P)) return fail('busy');
      if (P.members.length >= PARTY.max) return fail('party_full');
      if (this.partyOf(target) === P) return fail('already_in_party');
    } else if (this.d.isBusy(me)) return fail('busy');
    this.#expire();
    let box = this.invites.get(target);
    if (!box) this.invites.set(target, box = new Map());
    if (!box.has(me) && box.size >= PARTY.maxInvitesPerUser) return fail('invite_limit');
    const username = this.#nameOf(me);
    box.set(me, { from: me, username, expires: this.d.now() + PARTY.inviteTtlMs });
    this.#pushInvites(target);
    this.#event([target], 'invite', username);
    return { ok: true };
  }

  accept(me, from) {
    this.#expire();
    const box = this.invites.get(me), inv = box && box.get(from);
    if (!inv) return fail('no_invite');
    const drop = () => { box.delete(from); if (!box.size) this.invites.delete(me); this.#pushInvites(me); };
    if (!this.d.isOnline(from)) { drop(); return fail('offline'); }
    if (!this.d.isFriend(me, from)) { drop(); return fail('not_friend'); }
    if (this.d.isBusy(me)) return fail('busy');
    const Pme = this.partyOf(me);
    let Pf = this.partyOf(from);
    if (Pme && Pme === Pf) { drop(); return { ok: true }; }
    if (Pf) {
      if (this.busyParty(Pf)) return fail('busy');
      if (Pf.members.length >= PARTY.max) return fail('party_full');
    } else if (this.d.isBusy(from)) return fail('busy');
    if (Pme) this.#remove(me, 'left'); // joining another party leaves the current one first
    Pf = this.partyOf(from); // the old party may have dissolved around `from` (we were the only other member)
    const mem = (uid) => ({ uid, username: this.#nameOf(uid), rank: pubRank(this.d.info(uid)?.rank), seq: ++this.seq, offlineAt: null });
    let others;
    if (Pf) { others = Pf.members.map((m) => m.uid); Pf.members.push(mem(me)); }
    else {
      Pf = { id: ++this.nextId, leader: from, members: [mem(from), mem(me)] };
      this.parties.set(Pf.id, Pf); this.byUid.set(from, Pf); others = [from];
    }
    this.byUid.set(me, Pf);
    const b = this.invites.get(me); // the invites of everybody who is in this party now are used up
    if (b) { for (const m of Pf.members) b.delete(m.uid); if (!b.size) this.invites.delete(me); }
    this.#pushInvites(me); this.#push(Pf);
    this.#event(others, 'joined', this.#nameOf(me));
    return { ok: true };
  }

  decline(me, from) {
    const box = this.invites.get(me);
    if (box) { box.delete(from); if (!box.size) this.invites.delete(me); }
    this.#pushInvites(me);
    return { ok: true };
  }

  leave(me) {
    if (!this.partyOf(me)) return fail('not_in_party');
    this.#remove(me, 'left');
    return { ok: true };
  }
  kick(me, target) {
    const P = this.partyOf(me);
    if (!P) return fail('not_in_party');
    if (P.leader !== me) return fail('not_leader');
    if (target === me) return fail('self');
    if (this.partyOf(target) !== P) return fail('not_member');
    this.#remove(target, 'kicked');
    return { ok: true };
  }
  transfer(me, target) {
    const P = this.partyOf(me);
    if (!P) return fail('not_in_party');
    if (P.leader !== me) return fail('not_leader');
    if (target === me) return fail('self');
    if (this.partyOf(target) !== P) return fail('not_member');
    if (!this.d.isOnline(target)) return fail('offline');
    P.leader = target;
    this.#push(P); this.#event(P.members.map((m) => m.uid), 'leader', this.#nameOf(target));
    return { ok: true };
  }

  // Leader-only gate for starting a game: -> { ok, party:null } (not in a party) | { ok, party, members:[online uids] } | { ok:false, code }.
  forQueue(me) {
    const P = this.partyOf(me);
    if (!P) return { ok: true, party: null };
    if (P.leader !== me) return fail('not_leader');
    const online = P.members.filter((m) => this.d.isOnline(m.uid)).map((m) => m.uid);
    if (online.length < 2) return fail('party_offline');
    return { ok: true, party: P, members: online };
  }

  tick(now = this.d.now()) {
    this.#expire(now);
    for (const P of [...this.parties.values()]) {
      for (const m of [...P.members]) if (m.offlineAt !== null && now - m.offlineAt >= PARTY.graceMs && this.partyOf(m.uid) === P) this.#remove(m.uid, 'timeout');
    }
  }
  #expire(now = this.d.now()) {
    for (const [to, box] of [...this.invites]) {
      let changed = false;
      for (const [from, i] of [...box]) if (i.expires <= now) { box.delete(from); changed = true; }
      if (!box.size) this.invites.delete(to);
      if (changed && this.d.isOnline(to)) this.#pushInvites(to);
    }
  }

  // Take `uid` out. The leader leaving hands the lead to the earliest remaining joiner (online ones first); < 2 members left = dissolve.
  #remove(uid, reason) {
    const P = this.partyOf(uid);
    if (!P) return;
    const gone = P.members.find((m) => m.uid === uid);
    P.members.splice(P.members.indexOf(gone), 1); this.byUid.delete(uid);
    this.d.send(uid, { t: 'party', party: null, reason });
    this.d.onMemberOut(uid, P);
    const rest = P.members.map((m) => m.uid);
    this.#event(rest, reason === 'kicked' ? 'kicked' : 'left', gone.username);
    if (rest.length < 2) {
      this.parties.delete(P.id);
      for (const u of rest) { this.byUid.delete(u); this.d.send(u, { t: 'party', party: null, reason: 'disbanded' }); this.d.onDisband(u); }
      return;
    }
    if (P.leader === uid) {
      const next = P.members.find((m) => this.d.isOnline(m.uid)) || P.members[0]; // members are in join order = earliest joiner first
      P.leader = next.uid;
      this.#event(rest, 'leader', next.username);
    }
    this.#push(P);
  }
}
