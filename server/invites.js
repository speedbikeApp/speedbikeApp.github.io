// Invite links: one standing code per player (code -> uid), "<game address>?invite=CODE". Opening it makes the two players friends, puts the opener in the
// inviter's party when the inviter is free, and pays both once the opener finishes their first online match since then (capped per inviter).
// Pure over injected deps like party.js. Storage: social-store.js (getInv / updInv / getCode / putCode / delCode). Protocol: docs/MULTIPLAYER.md "Invite links".
import { randomBytes } from 'node:crypto';

export const INVITE = { rewardCoins: 500, rewardCap: 20, newAccountMs: 7 * 86400000 }; // only accounts younger than newAccountMs can earn the reward (an old player opening a link is not a new player)
const fail = (code) => ({ ok: false, code });

// deps: { store, social: { befriend(a, b) }, isNew(uid) -> Promise<bool> (account younger than INVITE.newAccountMs; default true), parties: { invite, accept }, isOnline(uid), isBusy(uid), nameOf(uid) -> Promise<string>, send(uid, msg), log, rand() -> code, rewardCoins, rewardCap }
export class Invites {
  constructor(deps) {
    this.d = { log: () => {}, isNew: async () => true, rand: () => randomBytes(9).toString('base64url'), ...deps };
    this.d.rewardCoins ??= INVITE.rewardCoins; this.d.rewardCap ??= INVITE.rewardCap; // (undefined from an unset option)
    this.by = new Map(); // invitee uid -> inviter uid while the reward is open ('' = nothing to pay): saves a read per match
  }

  async codeOf(uid) { return (await this.d.store.getInv(uid)).code || this.#issue(uid, ''); }
  reset(uid) { return this.d.store.getInv(uid).then((i) => this.#issue(uid, i.code)); }
  async #issue(uid, old) {
    const s = this.d.store;
    for (let i = 0; i < 5; i++) {
      const code = this.d.rand();
      if (!(await s.putCode(code, uid))) continue;
      await s.updInv([uid], (m) => { m.get(uid).code = code; return { ok: true }; });
      if (old) await s.delCode(old).catch(() => {});
      return code;
    }
    throw new Error('no free invite code');
  }
  async #owner(code) { const uid = await this.d.store.getCode(code); return uid && (await this.d.store.getInv(uid)).code === code ? uid : null; } // a reset code is dead

  /** Public lookup for the sign-up page: -> username | null. */
  async who(code) { const uid = await this.#owner(code); return uid ? this.d.nameOf(uid) : null; }

  /** `me` opened a link. -> { ok:true, username, joined } | { ok:false, code } (unknown | own | already_friends | limit_friends | target_limit_friends). */
  async use(me, code) {
    const owner = await this.#owner(code);
    if (!owner) return fail('unknown');
    if (owner === me) return fail('own');
    const f = await this.d.social.befriend(owner, me);
    if (!f.ok) return fail(f.code);
    if (await this.d.isNew(me).catch(() => false)) await this.d.store.updInv([me], (m) => { const a = m.get(me); if (!a.invitedBy) a.invitedBy = owner; return { ok: true }; }); // the first link wins; old accounts: friends only, no reward
    this.by.delete(me);
    let joined = false;
    if (this.d.isOnline(owner) && !this.d.isBusy(owner) && !this.d.isBusy(me)) joined = this.d.parties.invite(owner, me).ok && this.d.parties.accept(me, owner).ok;
    if (!joined) this.d.send(owner, { t: 'pevent', kind: 'invlink', username: await this.d.nameOf(me) });
    return { ok: true, username: await this.d.nameOf(owner), joined };
  }

  /** A human finished (did not leave) an online match. Pays both once if they were invited and the inviter is under the cap. */
  async onMatchEnd(uid) {
    const s = this.d.store;
    let by = this.by.get(uid);
    if (by === undefined) { const i = await s.getInv(uid); by = i.invitedBy && !i.done ? i.invitedBy : ''; this.by.set(uid, by); }
    if (!by) return;
    this.by.set(uid, '');
    try {
      const [nMe, nBy] = await Promise.all([this.d.nameOf(uid), this.d.nameOf(by)]), coins = this.d.rewardCoins, cap = this.d.rewardCap;
      const r = await s.updInv([uid, by], (m) => {
        const a = m.get(uid), b = m.get(by);
        if (a.done) return { ok: false };
        a.done = true;
        if (b.rewarded >= cap) return { ok: true, paid: false };
        b.rewarded++; a.pending.push({ coins, name: nBy }); b.pending.push({ coins, name: nMe });
        return { ok: true, paid: true };
      });
      if (r.paid) await Promise.all([this.deliver(uid), this.deliver(by)]);
    } catch (e) { this.by.set(uid, by); throw e; }
  }

  /** Send the rewards waiting for `uid` (earned while offline, or right now). */
  async deliver(uid) {
    if (!this.d.isOnline(uid)) return;
    const r = await this.d.store.updInv([uid], (m) => { const a = m.get(uid); if (!a.pending.length) return { ok: false }; const out = a.pending; a.pending = []; return { ok: true, out }; });
    for (const x of r.out || []) this.d.send(uid, { t: 'invreward', coins: x.coins, name: x.name });
  }
}
