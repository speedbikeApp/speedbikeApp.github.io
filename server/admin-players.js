// PLAYERS tab ops. args are untrusted (admin.js already verified the sender is an admin). Ops:
//   psearch {q} -> {results:[{uid,username,online,admin}]}   plist {after?, limit<=50} -> {players:[{uid,username,online,admin}], next?} (by username)
//       pget {uid} -> {player}
//   pban {uid, minutes | permanent:true, reason?}   punban {uid}   padmin {uid, on}
//   prename {uid, username}   ppassword {uid, password}   pedit {uid, coins?, stats?:{key:number}}   pdelete {uid, confirm:<their username>}
import { normalizeQuery, isUid } from './protocol.js';
import { NAME_RE, normalizeLoginName, MAX_PASSWORD } from './login.js';
import { PASSWORD_MIN } from './accounts.js';
import { adminError as E, banActive, banView } from './admin.js';

export const STAT_KEYS = ['matches', 'wins', 'winStreak', 'bestStreak', 'kills', 'distance', 'boosts', 'jumps', 'bestRoundBoosts', 'bestRoundJumps', 'dmFlawless', 'wins3d', 'winsHyper']; // js/save.js stats
export const MAX_VALUE = 1e9, MAX_BAN_MIN = 60 * 24 * 365 * 10;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_VALUE ? Math.floor(v) : null);

// deps: { admin, adminStore, socialStore, social, rankStore, send(uid,msg), kick(uid,msg), sessionOf(uid), log }
export function registerPlayerOps(deps) {
  const { admin, adminStore, socialStore, social, rankStore, send, kick, sessionOf, log } = deps;
  const now = () => admin.now();
  const target = async (a) => {
    if (!isUid(a.uid)) throw E('bad_uid');
    const u = (await socialStore.getUsers([a.uid])).get(a.uid);
    if (!u) throw E('not_found');
    return { uid: a.uid, username: u.username };
  };
  const act = (ctx, what, t, extra = '') => log(`[admin] ${ctx.uid} ${what} ${t.uid} (${t.username}) ${extra}`.trim());

  admin.register('psearch', async (a) => {
    const q = normalizeQuery(a.q); if (!q) throw E('bad_query');
    const [found, admins] = await Promise.all([socialStore.findByPrefix(q, 20), adminStore.adminUids()]);
    return { results: found.map((f) => ({ uid: f.uid, username: f.username, online: !!sessionOf(f.uid), admin: admins.has(f.uid) || admin.isBootstrap(f.username) })) };
  });

  admin.register('plist', async (a) => {
    if (a.after !== undefined && (typeof a.after !== 'string' || a.after.length > 64)) throw E('bad_query');
    const limit = Number.isInteger(a.limit) ? Math.min(50, Math.max(1, a.limit)) : 50;
    const [rows, admins] = await Promise.all([socialStore.listUsers(a.after || '', limit + 1), adminStore.adminUids()]); // +1 row tells whether more follow
    const page = rows.slice(0, limit);
    return { players: page.map((f) => ({ uid: f.uid, username: f.username, online: !!sessionOf(f.uid), admin: admins.has(f.uid) || admin.isBootstrap(f.username) })), ...(rows.length > limit ? { next: page[page.length - 1].key } : {}) };
  });

  admin.register('pget', async (a) => {
    const t = await target(a);
    const [isAdm, ban, rank, prog] = await Promise.all([adminStore.isAdmin(t.uid), adminStore.getBan(t.uid), rankStore.getRank(t.uid), adminStore.getProgress(t.uid)]);
    const stats = {}; for (const k of STAT_KEYS) stats[k] = Number(prog?.stats?.[k]) || 0;
    return { player: {
      ...t, online: !!sessionOf(t.uid), admin: isAdm || admin.isBootstrap(t.username), adminLocked: admin.isBootstrap(t.username),
      ban: banActive(ban, now()) ? { ...banView(ban), by: ban.by || '' } : null,
      rank: rank ? { tier: rank.tier, div: rank.div, wins: rank.wins, matches: rank.matches, totalWins: rank.totalWins } : null,
      progress: { synced: !!prog, coins: Number(prog?.coins) || 0, updatedAt: Number(prog?.updatedAt) || 0, stats, achievements: prog?.unlocks?.achievements?.length || 0 },
    } };
  });

  admin.register('pban', async (a, ctx) => {
    const t = await target(a);
    if (t.uid === ctx.uid || admin.isBootstrap(t.username)) throw E('protected');
    const permanent = a.permanent === true;
    let until = null;
    if (!permanent) { const m = a.minutes; if (typeof m !== 'number' || !Number.isFinite(m) || m < 1 || m > MAX_BAN_MIN) throw E('bad_minutes'); until = now() + Math.floor(m) * 60000; }
    const ban = { until, by: ctx.uid, reason: typeof a.reason === 'string' ? a.reason.slice(0, 100) : '', at: now() };
    await adminStore.setBan(t.uid, ban);
    act(ctx, 'ban', t, until == null ? 'permanent' : `until ${new Date(until).toISOString()}`);
    const s = sessionOf(t.uid); if (s) s.ban = ban;
    kick(t.uid, { t: 'banned', ...banView(ban) });
    return { ban: banView(ban) };
  });

  admin.register('punban', async (a, ctx) => {
    const t = await target(a);
    await adminStore.setBan(t.uid, null); act(ctx, 'unban', t);
    return {};
  });

  admin.register('padmin', async (a, ctx) => {
    const t = await target(a), on = a.on === true;
    if (!on && (t.uid === ctx.uid || admin.isBootstrap(t.username))) throw E('protected');
    await adminStore.setAdmin(t.uid, on, ctx.uid); act(ctx, on ? 'make-admin' : 'remove-admin', t);
    const s = sessionOf(t.uid);
    if (s) { s.admin = on || admin.isBootstrap(s.username); send(t.uid, { t: 'adminstate', admin: s.admin }); }
    return { admin: on };
  });

  admin.register('prename', async (a, ctx) => {
    const t = await target(a), name = normalizeLoginName(a.username);
    if (!NAME_RE.test(name)) throw E('bad_name');
    const r = await adminStore.rename(t.uid, name);
    if (!r.ok) throw E(r.code);
    try { const rk = await rankStore.getRank(t.uid); await rankStore.setRank(t.uid, rk, name); } catch (e) { log('[admin] rank username update failed:', e.message); }
    const s = sessionOf(t.uid); if (s) s.username = name;
    await social.refreshName(t.uid, name).catch(() => {});
    act(ctx, 'rename', t, `-> ${name}`);
    send(t.uid, { t: 'resync', username: name });
    return { username: name };
  });

  admin.register('ppassword', async (a, ctx) => {
    const t = await target(a);
    if (t.uid !== ctx.uid && (admin.isBootstrap(t.username) || await adminStore.isAdmin(t.uid))) throw E('protected'); // no taking over other admins
    if (typeof a.password !== 'string' || a.password.length < PASSWORD_MIN || a.password.length > MAX_PASSWORD) throw E('bad_password');
    await adminStore.setPassword(t.uid, a.password);
    act(ctx, 'set-password', t); // never log the password
    if (t.uid !== ctx.uid) kick(t.uid, { t: 'error', code: 'signed_out', message: 'password changed - sign in again' });
    return {};
  });

  admin.register('pedit', async (a, ctx) => {
    const t = await target(a), p = (await adminStore.getProgress(t.uid)) || {};
    const next = { ...p, stats: { ...(p.stats || {}) } };
    if (a.coins !== undefined) { const c = num(a.coins); if (c == null) throw E('bad_value'); next.coins = c; }
    if (a.stats !== undefined) {
      if (!a.stats || typeof a.stats !== 'object' || Array.isArray(a.stats)) throw E('bad_value');
      for (const [k, v] of Object.entries(a.stats)) { const n = num(v); if (!STAT_KEYS.includes(k) || n == null) throw E('bad_value'); next.stats[k] = n; }
    }
    next.updatedAt = Math.max(now(), (Number(p.updatedAt) || 0) + 1); // newer than the player's save: coins follow the newer updatedAt (js/cloudsave.js mergeProgress)
    await adminStore.setProgress(t.uid, next);
    act(ctx, 'edit', t, JSON.stringify({ coins: a.coins, stats: a.stats }));
    send(t.uid, { t: 'resync', force: true });
    return { progress: { coins: Number(next.coins) || 0, updatedAt: next.updatedAt } };
  });

  admin.register('pdelete', async (a, ctx) => {
    const t = await target(a);
    if (t.uid === ctx.uid || admin.isBootstrap(t.username)) throw E('protected');
    if (typeof a.confirm !== 'string' || a.confirm.trim().toLowerCase() !== t.username.toLowerCase()) throw E('confirm_mismatch');
    act(ctx, 'DELETE', t);
    kick(t.uid, { t: 'error', code: 'deleted', message: 'account deleted' });
    const links = await socialStore.getLinks(t.uid), others = [...new Set([...links.friends, ...links.incoming, ...links.outgoing])];
    for (const o of others) {
      await socialStore.update([o, t.uid], (m) => { for (const k of ['friends', 'incoming', 'outgoing']) { const l = m.get(o)[k], i = l.indexOf(t.uid); if (i >= 0) l.splice(i, 1); } return { ok: true }; });
      social.push(o).catch(() => {});
    }
    await socialStore.deleteLinks(t.uid);
    await rankStore.deleteRank?.(t.uid);
    await adminStore.remove(t.uid);
    return { deleted: true };
  });
}
