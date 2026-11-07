// Multiplayer WebSocket client (docs/MULTIPLAYER.md). No DOM, no three: the WebSocket constructor, clock and auth are injectable
// so it can be unit tested. Menus use it for presence (online count, announcements, queue); online.js drives matches.
//
//   const net = createNet({ url, getHello });  net.on('welcome', fn); net.on('status', fn); net.connect(); net.send({t:'queue',mode})
// Events: every server message type ('welcome','queued','lobby','start','ev','snap','crash','round','end','announce','rotation','pong','error')
// plus 'status' ({state, attempt, error}) and 'close'. State: 'idle' | 'connecting' | 'online' | 'offline' | 'denied'.
import { CFG } from './config.js';

// Server URL: ?server=ws://host:port wins over CFG.net.url.
export function serverUrl(search = '', cfg = CFG.net) {
  try {
    const q = new URLSearchParams(search).get('server');
    if (q && /^wss?:\/\/[^\s]+$/i.test(q)) return q;
  } catch { /* ignore */ }
  return cfg.url;
}

// Clock offset (server time - local time) from ping/pong: keeps the lowest-RTT samples (least queueing noise).
export class ClockSync {
  constructor(keep = 8) { this.keep = keep; this.samples = []; this.offset = 0; this.rtt = 0; this.have = false; }
  // sentMs / recvMs = local clock at ping send / pong receive, serverNow = server clock stamped in the pong.
  addPong(sentMs, recvMs, serverNow) {
    const rtt = Math.max(0, recvMs - sentMs);
    this.samples.push({ rtt, offset: serverNow + rtt / 2 - recvMs });
    if (this.samples.length > this.keep) this.samples.shift();
    const best = this.samples.reduce((a, s) => (s.rtt < a.rtt ? s : a));
    this.offset = best.offset; this.rtt = best.rtt; this.have = true;
    return this.offset;
  }
  // Seed from a message that carries serverNow but no round trip (welcome / lobby): coarse, replaced by ping samples.
  seed(recvMs, serverNow) { if (!this.have) { this.offset = serverNow - recvMs; this.have = true; } }
  serverNow(localMs) { return localMs + this.offset; }
  reset() { this.samples = []; this.offset = 0; this.rtt = 0; this.have = false; }
}

/** opts: {url, getHello: async () => hello message, WebSocket, now, setTimeout, clearTimeout, cfg}. */
export function createNet(opts = {}) {
  const cfg = opts.cfg || CFG.net;
  const WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const setT = opts.setTimeout || setTimeout, clearT = opts.clearTimeout || clearTimeout;
  const handlers = new Map();
  const clock = new ClockSync();
  const pings = new Map();
  let ws = null, state = 'idle', wanted = false, attempt = 0, retryTimer = null, pingTimer = null, helloTimer = null, seq = 0, gen = 0, lastError = '';
  let welcome = null, locked = false; // locked: in a match, do not reconnect (the match is lost anyway)

  function emit(type, msg) { for (const fn of [...(handlers.get(type) || [])]) { try { fn(msg); } catch (e) { if (typeof console !== 'undefined') console.error(e); } } }
  function setState(s, error = '') { state = s; lastError = error; emit('status', { state, attempt, error }); }
  const url = () => (typeof opts.url === 'function' ? opts.url() : opts.url || cfg.url);

  function cleanup() {
    clearT(retryTimer); clearT(pingTimer); clearT(helloTimer); retryTimer = pingTimer = helloTimer = null;
    pings.clear();
  }
  function schedule() {
    if (!wanted || locked || retryTimer) return;
    const list = cfg.reconnectMs, ms = list[Math.min(attempt, list.length - 1)];
    attempt++;
    retryTimer = setT(() => { retryTimer = null; open(); }, ms);
  }
  function pingLoop() {
    if (!ws || ws.readyState !== 1) return;
    const c = ++seq; pings.set(c, now());
    if (pings.size > 16) pings.delete(pings.keys().next().value);
    raw({ t: 'ping', c });
    pingTimer = setT(pingLoop, cfg.pingMs);
  }
  function raw(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; }

  async function open() {
    if (!WS || !wanted) return;
    cleanup();
    const my = ++gen;
    setState('connecting');
    let hello = null;
    try { hello = await opts.getHello(); } catch { hello = null; }
    if (my !== gen || !wanted) return;
    if (!hello) { setState('denied', 'Sign in to play online'); return; }
    let sock;
    try { sock = new WS(url()); } catch { setState('offline', 'Server offline'); schedule(); return; }
    ws = sock;
    sock.onopen = () => {
      if (my !== gen) return;
      raw(hello);
      helloTimer = setT(() => { if (my === gen && state !== 'online') { try { sock.close(); } catch { /* ignore */ } } }, cfg.helloTimeoutMs);
    };
    sock.onmessage = (e) => {
      if (my !== gen) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'welcome') {
        welcome = m; attempt = 0; clearT(helloTimer);
        if (typeof m.serverNow === 'number') clock.seed(now(), m.serverNow);
        setState('online'); pingLoop();
      } else if (m.t === 'pong') {
        const sent = pings.get(m.c); pings.delete(m.c);
        if (sent !== undefined && typeof m.serverNow === 'number') clock.addPong(sent, now(), m.serverNow);
      } else if (m.t === 'error' && (m.code === 'auth_failed' || m.code === 'not_authed') && state !== 'online') {
        wanted = false; setState('denied', 'Sign-in rejected by the server');
      } else if (m.t === 'error' && m.code === 'replaced') {
        wanted = false; setState('denied', 'Signed in from another place');
      }
      emit(m.t, m);
    };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => {
      if (my !== gen) return;
      const was = state;
      cleanup(); ws = null; welcome = null;
      emit('close', { was });
      if (state === 'denied') return;
      setState('offline', 'Server offline');
      schedule();
    };
  }

  return {
    on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type).delete(fn); },
    /** Start connecting (and keep reconnecting with backoff while wanted). */
    connect() { if (wanted && (state === 'online' || state === 'connecting')) return; wanted = true; attempt = 0; locked = false; open(); },
    /** Close and stop reconnecting (sign-out). */
    disconnect() { wanted = false; gen++; cleanup(); if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; } welcome = null; setState('idle'); },
    /** Drop the current socket and connect again (sign-in changed). */
    reconnect() { this.disconnect(); this.connect(); },
    /** Retry now (menu "retry" / entering the multiplayer screen while offline). */
    retryNow() { if (!wanted || state === 'online' || state === 'connecting') return; clearT(retryTimer); retryTimer = null; attempt = 0; open(); },
    lock(v) { locked = !!v; if (locked) { clearT(retryTimer); retryTimer = null; } if (!locked && wanted && state === 'offline') schedule(); },
    send(obj) { return raw(obj); },
    get state() { return state; },
    get online() { return state === 'online'; },
    get welcome() { return welcome; },
    get error() { return lastError; },
    clock,
    /** Estimated server clock (ms epoch) now. */
    serverNow() { return clock.serverNow(now()); },
    get rtt() { return clock.rtt; },
  };
}

// hello message for the current auth backend: dev hello for ?backend=mock, Firebase ID token otherwise, null when signed out.
export async function buildHello(auth) {
  const u = auth.currentUser();
  if (!u) return null;
  if (auth.status().mode === 'mock') return { t: 'hello', dev: true, uid: u.uid, username: u.username };
  const token = await auth.getIdToken();
  return token ? { t: 'hello', token } : null;
}
