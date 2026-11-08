// Admin foundation: who is an admin, bans, and a message router that other modules register handlers into.
//   admin.register('mapSave', async (args, ctx) => ({ ...result }))   // ctx = { uid, username, session, admin }; throw adminError('code') for a clean { ok:false, code }
// Client sends { t:'admin', op, id?, a:{...args} }; the server answers { t:'ares', op, id, ok:true, ...result } or { ok:false, code }.
// EVERY op is checked here (never in the handlers): the sender must be an admin right now (ADMIN_USERNAMES bootstrap or admins/{uid}).
export const banActive = (ban, now = Date.now()) => !!ban && (ban.until == null || ban.until > now);
export const banView = (ban) => ({ until: ban.until ?? null, permanent: ban.until == null, reason: ban.reason || '' });
export const adminError = (code, extra) => Object.assign(new Error(code), { adminCode: code, extra });
export const parseAdminNames = (v) => new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean));

// opts: { store (admin store), names (ADMIN_USERNAMES string | array), log, now }
export class Admin {
  constructor({ store, names, log = () => {}, now = () => Date.now() }) {
    this.store = store; this.bootstrap = parseAdminNames(names); this.log = log; this.now = now; this.ops = new Map();
  }
  register(op, handler) { if (!/^[A-Za-z]\w{0,31}$/.test(op)) throw new Error('bad admin op name'); this.ops.set(op, handler); }
  isBootstrap(username) { return typeof username === 'string' && this.bootstrap.has(username.trim().toLowerCase()); }
  async isAdmin(uid, username) { return this.isBootstrap(username) || (await this.store.isAdmin(uid)); }
  /** Active ban of a uid or null (expired bans are ignored). */
  async activeBan(uid) { const b = await this.store.getBan(uid); return banActive(b, this.now()) ? b : null; }

  async handle(s, msg) {
    const reply = (o) => s.send({ t: 'ares', op: msg.op, ...(msg.id !== undefined ? { id: msg.id } : {}), ...o });
    let ok = false;
    try { ok = s.authed && await this.isAdmin(s.uid, s.username); } catch (e) { this.log('[admin] check failed:', e.message); return reply({ ok: false, code: 'unavailable' }); }
    s.admin = ok;
    if (!ok) { this.log(`[admin] DENIED ${s.uid} ${msg.op}`); return reply({ ok: false, code: 'forbidden' }); }
    const h = this.ops.get(msg.op);
    if (!h) return reply({ ok: false, code: 'unknown_op' });
    this.log(`[admin] ${s.uid} (${s.username}) ${msg.op} target=${msg.a && (msg.a.uid || msg.a.q || msg.a.id) || '-'}`);
    try { reply({ ok: true, ...(await h(msg.a || {}, { uid: s.uid, username: s.username, session: s, admin: this })) }); }
    catch (e) {
      if (e && e.adminCode) return reply({ ok: false, code: e.adminCode, ...(e.extra || {}) });
      this.log(`[admin] ${msg.op} failed:`, e && e.message);
      try { reply({ ok: false, code: 'unavailable' }); } catch { /* socket gone */ }
    }
  }
}
