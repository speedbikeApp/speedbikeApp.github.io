// SpeedBike game server: HTTP (/health) + WebSocket. Protocol: docs/MULTIPLAYER.md.
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { featuredMode, nextRotation, FIXED_MODES, FEATURED_CYCLE } from '../js/rotation.js';
import { parseClientMessage, RateLimiter, MAX_ADMIN } from './protocol.js';
import { resolveAuthMode, createDevAuth, createFirebaseAuth, sanitizeName } from './auth.js';
import { createJsonStore, createFirestoreStore } from './store.js';
import { createJsonSocialStore, createFirestoreSocialStore } from './social-store.js';
import { Social } from './social.js';
import { Admin, banActive, banView } from './admin.js';
import { createJsonAdminStore, createFirestoreAdminStore } from './admin-store.js';
import { registerPlayerOps } from './admin-players.js';
import { registerGameOps } from './admin-games.js';
import { createJsonMapStore, createFirestoreMapStore, createMapPool, registerMapOps, createMapsHandler } from './admin-maps.js';
import { createJsonCatalogStore, createFirestoreCatalogStore } from './catalog-store.js';
import { createCatalog, registerItemOps, createCatalogHandler } from './admin-items.js';
import { Parties } from './party.js';
import { Matchmaker, LOBBY_MAX } from './matchmaker.js';
import { Room } from './room.js';
import { makeBots } from './bots.js';
import { settleMatch } from './ranking.js';
import { createLoginHandler, createFirebaseLoginDeps, clientIp, WindowLimiter } from './login.js';
import { createAccountsHandler, createFirebaseAccountDeps } from './accounts.js';
import { createMailer } from './email.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// opts: { maps (custom map store, default: in memory), auth, store, social (social store, default: in memory), admin (admin store, default: in memory), adminUsernames (ADMIN_USERNAMES: comma string or array), port, timeScale (TEST ONLY: speeds the sim up), countdownMs, allowedOrigins:[...] , log, loopMs (scheduler interval, default 16), healthToken (HEALTH_TOKEN: unlocks /health?detail=), maxConnsPerIp (default 20), connRatePerMin (new sockets per IP per minute, default 30) }
export function createGameServer(opts) {
  const { auth, store, timeScale = 1, allowedOrigins = [], log = console.log } = opts;
  // POST /auth/login (server/login.js). Without opts.login (dev auth / tests) the endpoint answers 503 {code:'unavailable'}.
  const loginHandler = opts.login || createLoginHandler({ enabled: false, allowedOrigins, production: !!opts.production });
  // /auth/signup/*, /auth/forgot/*, /auth/reset (server/accounts.js); disabled (503) without opts.accounts.
  const accountsHandler = opts.accounts || createAccountsHandler({ enabled: false, allowedOrigins, production: !!opts.production });
  const socialStore = opts.social || createJsonSocialStore(null);
  const adminStore = opts.admin || createJsonAdminStore(null, socialStore);
  const mapStore = opts.maps || createJsonMapStore(null), mapPool = createMapPool(mapStore, log); // custom maps (admin-maps.js): rooms draw from mapPool
  const catalog = createCatalog(opts.catalog || createJsonCatalogStore(null));
  const mapsHandler = createMapsHandler({ pool: mapPool, allowedOrigins, production: !!opts.production });
  const catalogHandler = createCatalogHandler({ catalog, allowedOrigins, production: !!opts.production, log });
  const sessions = new Set(), byUid = new Map(), rooms = new Map();
  // Featured mode: the hourly rotation unless an admin pinned one (override, persisted in the catalog store so it survives restarts).
  let override = null, featured = featuredMode(Date.now()), onlineTimer = null, nextRoomId = 0;
  const featuredNow = (now) => override || featuredMode(now);
  const rotationInfo = (now) => ({ featured, nextRotation: override ? 0 : nextRotation(now), manual: !!override }); // nextRotation 0 = no countdown (clients show "set by admin")
  const applyFeatured = (now = Date.now()) => { featured = featuredNow(now); broadcastAll({ t: 'rotation', ...rotationInfo(now) }); };
  catalog.getFeatured().then((m) => { if (FEATURED_CYCLE.includes(m)) { override = m; applyFeatured(); } }).catch((e) => log('[catalog] featured read failed:', e.message));

  const broadcastAll = (msg) => { for (const s of sessions) if (s.authed) s.send(msg); };
  const online = () => { let n = 0; for (const s of sessions) if (s.authed) n++; return n; };
  const announceOnline = () => { // throttled: at most one update per 2 s
    if (onlineTimer) return;
    onlineTimer = setTimeout(() => { onlineTimer = null; broadcastAll({ t: 'online', online: online() }); }, 2000);
    onlineTimer.unref?.();
  };

  // Friends + presence (server/social.js). Presence = a live authenticated session in byUid.
  const social = new Social({
    store: socialStore, log, getRank: (uid) => store.getRank(uid),
    liveRank: (uid) => byUid.get(uid)?.rank, isOnline: (uid) => !!byUid.get(uid)?.authed,
    send: (uid, m) => byUid.get(uid)?.send(m),
  });

  // Admin console (server/admin.js): ops are registered by module; PLAYERS in admin-players.js. Other modules: `admin.register(op, handler)` (exposed on the returned object).
  const admin = new Admin({ store: adminStore, names: opts.adminUsernames, log });
  const kick = (uid, msg) => { const s = byUid.get(uid); if (!s) return; s.send(msg); cleanup(s); s.ws.close(4003, String(msg.code || msg.t)); };
  registerItemOps({ admin, catalog, log }); // GARAGE tab (server/admin-items.js)
  registerPlayerOps({ admin, catalog, adminStore, socialStore, social, rankStore: store, send: (uid, m) => byUid.get(uid)?.send(m), kick, sessionOf: (uid) => byUid.get(uid), log });

  registerMapOps({ admin, mapStore, pool: mapPool, log }); // MAPS tab

  const queued = (s) => s.where?.type === 'queue' || s.where?.type === 'lobby';
  // Parties (server/party.js): in-memory. isBusy = queued / in a lobby / in a match.
  const parties = new Parties({
    log, send: (uid, m) => byUid.get(uid)?.send(m), isOnline: (uid) => !!byUid.get(uid)?.authed, isFriend: (a, b) => social.isFriend(a, b),
    isBusy: (uid) => { const s = byUid.get(uid); return !!s && (!!s.where || !!s.room); },
    info: (uid) => { const s = byUid.get(uid); return s && s.authed ? { username: s.username, rank: s.rank } : null; },
    onMemberOut: (uid) => { const s = byUid.get(uid); if (s && queued(s)) { mm.leave(s); s.send({ t: 'unqueued', reason: 'party' }); } },
    onDisband: (uid) => { const s = byUid.get(uid); if (s && s.where) s.group = null; }, // a lone leftover in a queue / lobby is a normal ranked solo again
  });

  const mm = new Matchmaker({
    countdownMs: opts.countdownMs,
    allowed: (mode, now) => FIXED_MODES.includes(mode) || mode === featuredNow(now),
    onStart: (lobby) => {
      // The lobby starts with 2..4 humans (countdown over, or full): free slots are filled with bots (server/bots.js).
      const humans = lobby.players.map((s) => ({ uid: s.uid, username: s.username, rank: s.rank, colorIdx: s.colorIdx, send: s.send, session: s, party: s.group != null, loadout: s.loadout, admin: s.admin }));
      const room = new Room({
        id: ++nextRoomId, mode: lobby.mode, timeScale, mapPool: mapPool.poolFor(lobby.mode),
        players: [...humans, ...makeBots(humans, LOBBY_MAX)],
        onLeave: handleLeave, onEnd: handleEnd,
      });
      rooms.set(room.id, room);
      for (const p of room.players) if (!p.bot) { p.session.room = room; p.session.bikeId = p.id; p.session.group = null; }
      log(`[room ${room.id}] ${lobby.mode} started: ${room.players.map((p) => p.username).join(', ')}`);
    },
  });

  registerGameOps({ admin, mm, rooms, log, featured: { // GAMES tab
    view: () => ({ current: featured, override }),
    set: async (m) => { await catalog.putFeatured(m); override = m; applyFeatured(); },
  } });

  // A player quit / dropped mid-match: settle the loss right away so they can't dodge it by reconnecting.
  function handleLeave(p) {
    if (p.party) return; // party games are unranked: nothing to settle
    p.leavePromise = settleMatch(store, [{ id: p.id, uid: p.uid, username: p.username, place: 0, won: false }])
      .then(({ ranks }) => {
        const r = ranks[0];
        const s = p.session;
        if (byUid.get(p.uid) === s || s.uid === p.uid) { s.rank = r.rankAfter; s.send({ t: 'rank', rank: r.rankAfter }); }
        social.noteRank(p.uid, r.rankAfter);
        return r;
      }).catch((e) => { log('[rank] leave settle failed:', e.message); return null; });
  }

  async function handleEnd(room, { reason, results }) {
    try {
      const stay = reason === 'stopped' ? [] : results.filter((r) => !r.left && !r.bot && !r.unranked && !room.players[r.id].party); // party members and unranked wins (Room #results) are not settled; an admin stop settles nobody
      const { ranks, announcements } = stay.length ? await settleMatch(store, stay) : { ranks: [], announcements: [] };
      const byId = new Map(ranks.map((r) => [r.id, r]));
      const out = [];
      for (const r of results) {
        const p = room.players[r.id];
        if (r.bot) { out.push({ id: r.id, uid: null, username: r.username, place: r.place, won: r.won, left: false, scores: r.scores, rankBefore: null, rankAfter: null, change: 'none', bot: true }); continue; }
        let entry = byId.get(r.id);
        if (!entry) { const l = p.leavePromise && await p.leavePromise; entry = { id: r.id, uid: r.uid, rankBefore: l?.rankBefore || p.rank, rankAfter: l?.rankAfter || p.rank, change: l?.change || 'none' }; }
        out.push({ id: r.id, uid: r.uid, username: r.username, place: r.place, won: r.won, left: r.left, scores: r.scores, rankBefore: entry.rankBefore, rankAfter: entry.rankAfter, change: entry.change, ...(p.party ? { party: true } : {}), ...(r.unranked ? { unranked: true } : {}), ...(p.admin ? { admin: true } : {}) });
      }
      for (const p of room.players) {
        const s = p.session;
        if (p.left || p.bot) continue;
        s.room = null; s.where = null;
        s.rank = out[p.id].rankAfter; social.noteRank(p.uid, s.rank);
        s.send({ t: 'end', mode: room.mode, reason, ranks: out });
      }
      for (const a of announcements) broadcastAll({ t: 'announce', ...a });
      log(`[room ${room.id}] ended (${reason}): ${out.map((r) => `${r.username}#${r.place}${r.change !== 'none' ? ' ' + r.change : ''}`).join(' ')}`);
    } catch (e) {
      log(`[room ${room.id}] rank update failed:`, e.message);
      for (const p of room.players) if (!p.left && !p.bot) { p.session.room = null; p.session.where = null; p.session.send({ t: 'error', code: 'rank_failed', message: 'could not save ranks' }); }
    } finally { rooms.delete(room.id); }
  }

  // ---- connection handling ----
  function cleanup(s) {
    if (s.dead) return;
    s.dead = true; sessions.delete(s);
    if (s.uid && byUid.get(s.uid) === s) { byUid.delete(s.uid); if (s.authed && !s.replaced) { social.onDisconnect(s.uid); parties.onDisconnect(s.uid); } }
    mm.leave(s);
    if (s.room) { s.room.leave(s.bikeId); s.room = null; }
    if (s.authed) announceOnline();
  }

  async function onHello(s, msg) {
    s.helloPending = true;
    try {
      const id = await auth.verify(msg);
      if (s.dead) return;
      const ban = await admin.activeBan(id.uid); // banned accounts never get a welcome (js/net.js shows the message)
      if (s.dead) return;
      if (ban) { s.send({ t: 'banned', ...banView(ban) }); log(`[admin] refused banned ${id.uid}`); s.ws.close(4003, 'banned'); return; }
      s.admin = await admin.isAdmin(id.uid, id.username); s.ban = null;
      if (s.dead) return;
      const old = byUid.get(id.uid);
      if (old && old !== s) { old.send({ t: 'error', code: 'replaced', message: 'signed in from another place' }); old.replaced = true; cleanup(old); old.ws.close(4002, 'replaced'); }
      s.uid = id.uid; s.username = id.username; s.rank = await store.getRank(id.uid);
      if (s.dead) return;
      s.authed = true; byUid.set(s.uid, s);
      s.send({ t: 'welcome', uid: s.uid, username: s.username, rank: s.rank, serverNow: Date.now(), ...rotationInfo(Date.now()), online: online(), admin: s.admin });
      announceOnline(); sendSping(s);
      parties.onConnect(s.uid);
      social.onConnect(s.uid, s.username).catch((e) => log('[social] connect failed:', e.message));
    } catch (e) {
      s.send({ t: 'error', code: 'auth_failed', message: 'authentication failed' });
      log('[auth] rejected:', e.message);
      s.ws.close(4001, 'auth failed');
    } finally { s.helloPending = false; }
  }

  let spingN = 0;
  const sendSping = (s) => { s.sping = { n: ++spingN, at: performance.now() }; s.send({ t: 'sping', n: s.sping.n }); }; // RTT per session (Room clamps lag-comp rewinds to it)
  const spingTimer = setInterval(() => { for (const s of sessions) if (s.authed) sendSping(s); }, 4000);

  function onMessage(s, data) {
    const r = parseClientMessage(data);
    if (!r.ok) return s.send({ t: 'error', code: r.code, message: r.message });
    const msg = r.msg;
    if (!(msg.t === 'in' ? s.inLimiter : s.limiter).take()) { // dropped; persistent flooding disconnects
      if (++s.violations > 300) s.ws.close(1008, 'rate limit');
      return;
    }
    if (msg.t === 'hello') { if (!s.authed && !s.helloPending) onHello(s, msg); return; }
    if (!s.authed) return s.send({ t: 'error', code: 'not_authed', message: 'send hello first' });
    switch (msg.t) {
      case 'spong': if (s.sping && s.sping.n === msg.n) { const rtt = performance.now() - s.sping.at; s.rtt = s.rtt == null ? rtt : s.rtt * 0.7 + rtt * 0.3; s.sping = null; } return;
      case 'ping': return s.send({ t: 'pong', c: msg.c, serverNow: Date.now() });
      case 'queue': if (banActive(s.ban)) { s.send({ t: 'banned', ...banView(s.ban) }); return void s.ws.close(4003, 'banned'); }
        if (msg.loadout) s.loadout = msg.loadout; return void onQueue(s, msg.mode);
      case 'loadout': if (s.room) s.room.setLoadout(s.bikeId, msg.abilities); else s.loadout = msg.abilities; return;
      case 'leaveQueue': return void onLeaveQueue(s);
      case 'leave':
        if (s.room) { s.room.leave(s.bikeId); s.room = null; s.where = null; } else mm.leave(s);
        return;
      case 'admin': return void admin.handle(s, msg);
      case 'in': if (s.room) s.room.input(s.bikeId, msg); return;
      case 'pinvite': case 'paccept': case 'pdecline': case 'pkick': case 'ptransfer': case 'pleave': case 'plist': return void onParty(s, msg);
      default: return void onSocial(s, msg);
    }
  }

  const PARTY_ERR = {
    not_leader: 'ONLY THE PARTY LEADER CAN DO THAT', party_offline: 'NOT ENOUGH PARTY MEMBERS ONLINE', member_busy: 'A PARTY MEMBER IS IN A MATCH OR QUEUE',
  };
  // queue / leaveQueue: a party's leader moves the whole party (one matchmaker entry, one room); other members cannot queue on their own.
  function onQueue(s, mode) {
    const g = parties.forQueue(s.uid), err = (code, message) => s.send({ t: 'error', code, message });
    if (!g.ok) return err(g.code, PARTY_ERR[g.code]);
    if (!g.party) { const q = mm.queue(s, mode); if (!q.ok) err(q.code, q.message); return; }
    if (s.where) return err('busy', 'already queued or in a match');
    const members = g.members.map((u) => byUid.get(u));
    if (members.some((m) => m.room || m.where?.type === 'match')) return err('member_busy', PARTY_ERR.member_busy);
    for (const m of members) if (m.where) mm.leave(m); // stale queue / lobby entry of a member (e.g. the leader reconnected): start over as one group
    const q = mm.queueGroup(members, mode, g.party.id);
    if (!q.ok) err(q.code, q.message);
  }
  function onLeaveQueue(s) {
    const P = parties.partyOf(s.uid);
    if (!P) return void mm.leave(s);
    if (P.leader !== s.uid) return void s.send({ t: 'error', code: 'not_leader', message: PARTY_ERR.not_leader });
    for (const m of P.members) { const t = byUid.get(m.uid); if (t && queued(t)) { mm.leave(t); if (t !== s) t.send({ t: 'unqueued', reason: 'leader' }); } } // members are told, they did not ask
  }

  // Party protocol (docs/MULTIPLAYER.md "Party"). Intents are validated in party.js and answered with `pres`; state goes out as `party` / `pinvites`.
  function onParty(s, msg) {
    const op = msg.t, res = (o) => s.send({ t: 'pres', op, ...(msg.uid ? { uid: msg.uid } : {}), ...o });
    if (!s.partyLimiter.take()) return res({ ok: false, code: 'rate_limited' });
    switch (op) {
      case 'plist': parties.onConnect(s.uid); return;
      case 'pinvite': return res(parties.invite(s.uid, msg.uid));
      case 'paccept': return res(parties.accept(s.uid, msg.uid));
      case 'pdecline': return res(parties.decline(s.uid, msg.uid));
      case 'pleave': return res(parties.leave(s.uid));
      case 'pkick': return res(parties.kick(s.uid, msg.uid));
      case 'ptransfer': return res(parties.transfer(s.uid, msg.uid));
    }
  }

  // Friends protocol (docs/MULTIPLAYER.md "Social"). Every intent is validated + rate limited per connection; results come back as `fres`.
  async function onSocial(s, msg) {
    const op = msg.t, res = (o) => s.send({ t: 'fres', op, ...(msg.uid ? { uid: msg.uid } : {}), ...o });
    const limiter = op === 'fsearch' || op === 'flist' ? s.searchLimiter : s.socialLimiter;
    if (!limiter.take()) return res({ ok: false, code: 'rate_limited' });
    try {
      switch (op) {
        case 'fsearch': { const r = await social.search(s.uid, msg.q); return void s.send({ t: 'fresults', q: msg.q, results: r.results }); }
        case 'flist': return void await social.push(s.uid);
        case 'frefresh': {
          const name = await social.refreshName(s.uid, auth.mode === 'dev' && msg.username ? sanitizeName(msg.username) : undefined);
          if (name) s.username = name;
          return res({ ok: !!name, ...(name ? { username: name } : { code: 'not_found' }) });
        }
        case 'fadd': return res(await social.request(s.uid, msg.uid));
        case 'faccept': return res(await social.accept(s.uid, msg.uid));
        case 'fdecline': return res(await social.decline(s.uid, msg.uid));
        case 'fcancel': return res(await social.cancel(s.uid, msg.uid));
        case 'fremove': return res(await social.remove(s.uid, msg.uid));
      }
    } catch (e) {
      log(`[social] ${op} failed:`, e.message);
      res({ ok: false, code: 'unavailable' });
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/auth/login') return void loginHandler(req, res).catch((e) => { log('[login] crashed:', e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
    if (req.url.startsWith('/auth/') && req.url.split('?')[0] !== '/auth/login') return void accountsHandler(req, res).catch((e) => { log('[accounts] crashed:', e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
    if (req.url.split('?')[0] === '/catalog') return void catalogHandler(req, res);
    if (req.url.split('?')[0] === '/maps') return void mapsHandler(req, res).catch((e) => { log('[maps] failed:', e.message); if (!res.headersSent) res.writeHead(503); res.end(); });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.split('?')[0] === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const o = { ok: true, online: online(), featured }, tok = new URL(req.url, 'http://x').searchParams.get('detail');
      const h = (v) => createHash('sha256').update(String(v)).digest(); // equal-length digests for the constant-time compare
      if (opts.healthToken && tok && timingSafeEqual(h(tok), h(opts.healthToken)))
        Object.assign(o, { auth: auth.mode, store: store.kind, rooms: rooms.size, ...mm.stats(), uptime: Math.round(process.uptime()), loop: loopView(), roomStats: [...rooms.values()].map((r) => r.statsView()) });
      return res.end(JSON.stringify(o));
    }
    res.writeHead(req.url === '/' ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(req.url === '/' ? 'SpeedBike game server\n' : 'not found\n');
  });
  const wss = new WebSocketServer({
    server, maxPayload: MAX_ADMIN,
    verifyClient: ({ origin }) => !allowedOrigins.length || allowedOrigins.includes(origin),
  });
  const ipConns = new Map(), connRate = new WindowLimiter(opts.connRatePerMin ?? 30, 60000), maxConns = opts.maxConnsPerIp ?? 20; // per client IP: open sockets + new sockets per minute
  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    if ((ipConns.get(ip) || 0) >= maxConns || !connRate.hit(ip).ok) return ws.close(1013, 'too many connections');
    ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
    const s = {
      ws, uid: null, username: '', rank: null, where: null, authed: false, helloPending: false, dead: false, alive: true, violations: 0,
      room: null, bikeId: -1, colorIdx: 0, group: null, rtt: null, sping: null, loadout: [], admin: false, ban: null,
      limiter: new RateLimiter(20, 30), searchLimiter: new RateLimiter(0.7, 5), socialLimiter: new RateLimiter(1, 10), partyLimiter: new RateLimiter(2, 12), inLimiter: new RateLimiter(30, 30),
      send: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
    };
    sessions.add(s);
    const authTimer = setTimeout(() => { if (!s.authed) ws.close(4001, 'hello timeout'); }, 10000);
    ws.on('pong', () => { s.alive = true; });
    ws.on('message', (data, isBinary) => { if (!isBinary) onMessage(s, data); });
    ws.on('close', () => { clearTimeout(authTimer); cleanup(s); const n = ipConns.get(ip) - 1; if (n > 0) ipConns.set(ip, n); else ipConns.delete(ip); });
    ws.on('error', () => {});
  });

  // One shared loop for every room (drift-free per room, see Room.update: each wake-up runs as many 120 Hz ticks as are due), the lobby
  // countdowns, rotation and heartbeat. A coarse interval (16 ms, ~4x fewer wake-ups than the old 4 ms) keeps CPU low on small hosts.
  // loopView() (in /health): wake-up interval stats, share of CPU used by the process (user+system over the last ~5 s), per-room timing.
  const LOOP_MS = opts.loopMs ?? 16;
  let lastSlow = 0, lastWake = 0, ivAvg = LOOP_MS, ivMax = 0, ivPrev = 0, ivWin = 0, cpuPct = 0, cpuLast = process.cpuUsage(), cpuAt = performance.now();
  const loopView = () => ({ intervalMs: LOOP_MS, avgIntervalMs: Math.round(ivAvg * 100) / 100, maxIntervalMs: Math.round(Math.max(ivMax, ivPrev) * 10) / 10, cpuPct: Math.round(cpuPct * 10) / 10 });
  const loop = setInterval(() => {
    const t = performance.now();
    if (lastWake) { // wake-up spacing: a max far above LOOP_MS means the host starved the process (CPU throttling / GC)
      const iv = t - lastWake; ivAvg = ivAvg * 0.98 + iv * 0.02;
      if (t - ivWin > 10000) { ivPrev = ivMax; ivMax = 0; ivWin = t; }
      if (iv > ivMax) ivMax = iv;
    }
    lastWake = t;
    if (t - cpuAt >= 5000) { const u = process.cpuUsage(), used = (u.user - cpuLast.user + u.system - cpuLast.system) / 1000; cpuPct = 100 * used / (t - cpuAt); cpuLast = u; cpuAt = t; }
    for (const room of rooms.values()) room.update(t);
    const now = Date.now();
    mm.tick(now); parties.tick(now);
    if (t - lastSlow >= 1000) {
      lastSlow = t;
      if (featuredNow(now) !== featured) applyFeatured(now);
    }
  }, LOOP_MS);
  const beat = setInterval(() => {
    for (const s of sessions) { if (!s.alive) { s.ws.terminate(); continue; } s.alive = false; try { s.ws.ping(); } catch { /* closing */ } }
  }, 15000);

  return {
    server, wss, mm, rooms, sessions, parties, admin, adminStore, mapStore, mapPool,
    listen: (port = opts.port ?? 8787) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    async close() {
      clearInterval(loop); clearInterval(beat); clearInterval(spingTimer); clearTimeout(onlineTimer);
      for (const s of sessions) s.ws.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
      await store.flush?.(); await socialStore.flush?.(); await adminStore.flush?.(); await opts.catalog?.flush?.(); await mapStore.flush?.();
    },
  };
}

// ---- run directly: node index.js ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const mode = resolveAuthMode(env);
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean), production = env.NODE_ENV === 'production';
  let auth, store, login, accounts, social, adminStore, catalogStore, mapStore;
  if (mode === 'firebase') {
    const fb = await createFirebaseAuth(env); auth = fb.auth; store = createFirestoreStore(fb.db); social = createFirestoreSocialStore(fb.db, fb.FieldPath);
    adminStore = createFirestoreAdminStore(fb.db, fb.fbAuth); catalogStore = createFirestoreCatalogStore(fb.db); mapStore = createFirestoreMapStore(fb.db);
    login = createLoginHandler({ enabled: true, allowedOrigins, production, log: console.log, banOf: async (uid) => { const b = await adminStore.getBan(uid); return banActive(b) ? b : null; }, ...createFirebaseLoginDeps({ db: fb.db, auth: fb.fbAuth }, env) });
    accounts = createAccountsHandler({ enabled: true, allowedOrigins, production, log: console.log, publicUrl: env.PUBLIC_URL || undefined, mailer: createMailer(env, { production }), deps: createFirebaseAccountDeps({ db: fb.db, auth: fb.fbAuth }) });
  }
  else { auth = createDevAuth(); store = createJsonStore(env.RANKS_FILE || path.join(HERE, 'data', 'ranks.json')); social = createJsonSocialStore(env.SOCIAL_FILE || path.join(HERE, 'data', 'social.json')); adminStore = createJsonAdminStore(env.ADMIN_FILE || path.join(HERE, 'data', 'admin.json'), social); }
  mapStore ||= createJsonMapStore(env.MAPS_FILE || path.join(HERE, 'data', 'maps.json'));
  catalogStore ||= createJsonCatalogStore(env.CATALOG_FILE || path.join(HERE, 'data', 'catalog.json'));
  console.log(`[server] auth=${auth.mode} ranks=${store.kind}`);
  const app = createGameServer({
    auth, store, social, admin: adminStore, catalog: catalogStore, maps: mapStore, adminUsernames: env.ADMIN_USERNAMES, timeScale: Number(env.TIME_SCALE) || 1, // TIME_SCALE is for tests only
    countdownMs: Number(env.LOBBY_COUNTDOWN_MS) || undefined,
    allowedOrigins, login, accounts, production, healthToken: env.HEALTH_TOKEN,
  });
  const port = await app.listen(Number(env.PORT) || 8787);
  console.log(`[server] listening on :${port}  (health: http://localhost:${port}/health)`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  // Safety net: one bad handler must not drop every match. Log the error only, never message payloads.
  process.on('unhandledRejection', (e) => console.error('[fatal] unhandledRejection:', e && e.message, e && e.stack));
  process.on('uncaughtException', (e) => console.error('[fatal] uncaughtException:', e && e.message, e && e.stack));
}
