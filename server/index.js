// SpeedBike game server: HTTP (/health) + WebSocket. Protocol: docs/MULTIPLAYER.md.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { featuredMode, nextRotation, isMultiplayerMode } from '../js/rotation.js';
import { parseClientMessage, RateLimiter } from './protocol.js';
import { resolveAuthMode, createDevAuth, createFirebaseAuth, sanitizeName } from './auth.js';
import { createJsonStore, createFirestoreStore } from './store.js';
import { createJsonSocialStore, createFirestoreSocialStore } from './social-store.js';
import { Social } from './social.js';
import { Parties } from './party.js';
import { Matchmaker, LOBBY_MAX } from './matchmaker.js';
import { Room } from './room.js';
import { makeBots } from './bots.js';
import { settleMatch } from './ranking.js';
import { createLoginHandler, createFirebaseLoginDeps } from './login.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// opts: { auth, store, social (social store, default: in memory), port, timeScale (TEST ONLY: speeds the sim up), countdownMs, allowedOrigins:[...] , log, loopMs (scheduler interval, default 16) }
export function createGameServer(opts) {
  const { auth, store, timeScale = 1, allowedOrigins = [], log = console.log } = opts;
  // POST /auth/login (server/login.js). Without opts.login (dev auth / tests) the endpoint answers 503 {code:'unavailable'}.
  const loginHandler = opts.login || createLoginHandler({ enabled: false, allowedOrigins, production: !!opts.production });
  const socialStore = opts.social || createJsonSocialStore(null);
  const sessions = new Set(), byUid = new Map(), rooms = new Map();
  let featured = featuredMode(Date.now()), onlineTimer = null, nextRoomId = 0;

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
    allowed: (mode, now) => isMultiplayerMode(mode, now),
    onStart: (lobby) => {
      // The lobby starts with 2..4 humans (countdown over, or full): free slots are filled with bots (server/bots.js).
      const humans = lobby.players.map((s) => ({ uid: s.uid, username: s.username, rank: s.rank, colorIdx: s.colorIdx, send: s.send, session: s, party: s.group != null, loadout: s.loadout }));
      const room = new Room({
        id: ++nextRoomId, mode: lobby.mode, timeScale,
        players: [...humans, ...makeBots(humans, LOBBY_MAX)],
        onLeave: handleLeave, onEnd: handleEnd,
      });
      rooms.set(room.id, room);
      for (const p of room.players) if (!p.bot) { p.session.room = room; p.session.bikeId = p.id; p.session.group = null; }
      log(`[room ${room.id}] ${lobby.mode} started: ${room.players.map((p) => p.username).join(', ')}`);
    },
  });

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
      const stay = results.filter((r) => !r.left && !r.bot && !room.players[r.id].party); // party members are unranked
      const { ranks, announcements } = await settleMatch(store, stay);
      const byId = new Map(ranks.map((r) => [r.id, r]));
      const out = [];
      for (const r of results) {
        const p = room.players[r.id];
        if (r.bot) { out.push({ id: r.id, uid: null, username: r.username, place: r.place, won: r.won, left: false, scores: r.scores, rankBefore: null, rankAfter: null, change: 'none', bot: true }); continue; }
        let entry = byId.get(r.id);
        if (!entry) { const l = p.leavePromise && await p.leavePromise; entry = { id: r.id, uid: r.uid, rankBefore: l?.rankBefore || p.rank, rankAfter: l?.rankAfter || p.rank, change: l?.change || 'none' }; }
        out.push({ id: r.id, uid: r.uid, username: r.username, place: r.place, won: r.won, left: r.left, scores: r.scores, rankBefore: entry.rankBefore, rankAfter: entry.rankAfter, change: entry.change, ...(p.party ? { party: true } : {}) });
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
      const old = byUid.get(id.uid);
      if (old && old !== s) { old.send({ t: 'error', code: 'replaced', message: 'signed in from another place' }); old.replaced = true; cleanup(old); old.ws.close(4002, 'replaced'); }
      s.uid = id.uid; s.username = id.username; s.rank = await store.getRank(id.uid);
      if (s.dead) return;
      s.authed = true; byUid.set(s.uid, s);
      s.send({ t: 'welcome', uid: s.uid, username: s.username, rank: s.rank, serverNow: Date.now(), featured: featuredMode(Date.now()), nextRotation: nextRotation(Date.now()), online: online() });
      announceOnline();
      parties.onConnect(s.uid);
      social.onConnect(s.uid, s.username).catch((e) => log('[social] connect failed:', e.message));
    } catch (e) {
      s.send({ t: 'error', code: 'auth_failed', message: 'authentication failed' });
      log('[auth] rejected:', e.message);
      s.ws.close(4001, 'auth failed');
    } finally { s.helloPending = false; }
  }

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
      case 'ping': return s.send({ t: 'pong', c: msg.c, serverNow: Date.now() });
      case 'queue': if (msg.loadout) s.loadout = msg.loadout; return void onQueue(s, msg.mode);
      case 'loadout': if (s.room) s.room.setLoadout(s.bikeId, msg.abilities); else s.loadout = msg.abilities; return;
      case 'leaveQueue': return void onLeaveQueue(s);
      case 'leave':
        if (s.room) { s.room.leave(s.bikeId); s.room = null; s.where = null; } else mm.leave(s);
        return;
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, auth: auth.mode, store: store.kind, online: online(), rooms: rooms.size, ...mm.stats(), featured, uptime: Math.round(process.uptime()),
        loop: loopView(), roomStats: [...rooms.values()].map((r) => r.statsView()) }));
    }
    res.writeHead(req.url === '/' ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(req.url === '/' ? 'SpeedBike game server\n' : 'not found\n');
  });
  const wss = new WebSocketServer({
    server, maxPayload: 4096,
    verifyClient: ({ origin }) => !allowedOrigins.length || allowedOrigins.includes(origin),
  });
  wss.on('connection', (ws) => {
    const s = {
      ws, uid: null, username: '', rank: null, where: null, authed: false, helloPending: false, dead: false, alive: true, violations: 0,
      room: null, bikeId: -1, colorIdx: 0, group: null, loadout: [],
      limiter: new RateLimiter(20, 30), searchLimiter: new RateLimiter(0.7, 5), socialLimiter: new RateLimiter(1, 10), partyLimiter: new RateLimiter(2, 12), inLimiter: new RateLimiter(30, 30),
      send: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
    };
    sessions.add(s);
    const authTimer = setTimeout(() => { if (!s.authed) ws.close(4001, 'hello timeout'); }, 10000);
    ws.on('pong', () => { s.alive = true; });
    ws.on('message', (data, isBinary) => { if (!isBinary) onMessage(s, data); });
    ws.on('close', () => { clearTimeout(authTimer); cleanup(s); });
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
      const f = featuredMode(now);
      if (f !== featured) { featured = f; broadcastAll({ t: 'rotation', featured, nextRotation: nextRotation(now) }); }
    }
  }, LOOP_MS);
  const beat = setInterval(() => {
    for (const s of sessions) { if (!s.alive) { s.ws.terminate(); continue; } s.alive = false; try { s.ws.ping(); } catch { /* closing */ } }
  }, 15000);

  return {
    server, wss, mm, rooms, sessions, parties,
    listen: (port = opts.port ?? 8787) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    async close() {
      clearInterval(loop); clearInterval(beat); clearTimeout(onlineTimer);
      for (const s of sessions) s.ws.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
      await store.flush?.(); await socialStore.flush?.();
    },
  };
}

// ---- run directly: node index.js ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const mode = resolveAuthMode(env);
  if (mode === 'dev' && env.NODE_ENV === 'production' && env.DEV_AUTH !== '1') throw new Error('refusing dev auth in production; set Firebase credentials (or DEV_AUTH=1 to force)');
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean), production = env.NODE_ENV === 'production';
  let auth, store, login, social;
  if (mode === 'firebase') {
    const fb = await createFirebaseAuth(env); auth = fb.auth; store = createFirestoreStore(fb.db); social = createFirestoreSocialStore(fb.db, fb.FieldPath);
    login = createLoginHandler({ enabled: true, allowedOrigins, production, log: console.log, ...createFirebaseLoginDeps({ db: fb.db, auth: fb.fbAuth }, env) });
  }
  else { auth = createDevAuth(); store = createJsonStore(env.RANKS_FILE || path.join(HERE, 'data', 'ranks.json')); social = createJsonSocialStore(env.SOCIAL_FILE || path.join(HERE, 'data', 'social.json')); }
  console.log(`[server] auth=${auth.mode} ranks=${store.kind}`);
  const app = createGameServer({
    auth, store, social, timeScale: Number(env.TIME_SCALE) || 1, // TIME_SCALE is for tests only
    countdownMs: Number(env.LOBBY_COUNTDOWN_MS) || undefined,
    allowedOrigins, login, production,
  });
  const port = await app.listen(Number(env.PORT) || 8787);
  console.log(`[server] listening on :${port}  (health: http://localhost:${port}/health)`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
