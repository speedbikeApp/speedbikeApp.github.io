// POST /auth/login: "log in with username". The browser cannot turn a username into an email (emails are private and must never be
// exposed), so this trusted server does it: username -> uid (Firestore usernames/{lowercase}) -> email (Admin SDK), verifies the password with the
// Firebase Auth REST API and hands back a Firebase CUSTOM TOKEN for signInWithCustomToken. The email and the REST id/refresh tokens never leave here.
//
// Everything that touches the outside world is injected (lookup, verifyPassword, createToken, now, sleep) so the module is unit-testable offline.
// banOf(uid) -> active ban | null (server/admin.js): banned accounts get 403 {code:'banned', until, permanent} after a correct password.
// Failure policy: unknown user / wrong password / disabled account / malformed username all give the SAME 401 {ok:false, code:'invalid_credentials'}
// after the same minimum delay, so neither the body nor the timing tells whether a username exists.

import { firebaseConfig } from '../js/firebase-config.js'; // public web API key (default for FIREBASE_WEB_API_KEY)

export const MAX_BODY = 2048;             // bytes
export const NAME_RE = /^[A-Za-z0-9 _-]{3,12}$/; // same charset/length as js/auth.js validateUsername (after trim + whitespace collapse)
export const MAX_PASSWORD = 128;

// Sliding-window counter per key. Only allowed attempts are recorded (a blocked caller does not extend its own lockout).
export class WindowLimiter {
  constructor(max, windowMs, now = () => Date.now(), maxKeys = 20000) { this.max = max; this.windowMs = windowMs; this.now = now; this.maxKeys = maxKeys; this.map = new Map(); }
  prune(t) { for (const [k, a] of this.map) { while (a.length && a[0] <= t - this.windowMs) a.shift(); if (!a.length) this.map.delete(k); } }
  /** -> {ok:true} (and records the attempt) or {ok:false, retryAfter: seconds}. */
  hit(key) {
    const t = this.now();
    let a = this.map.get(key);
    if (a) while (a.length && a[0] <= t - this.windowMs) a.shift();
    else {
      if (this.map.size >= this.maxKeys) { this.prune(t); if (this.map.size >= this.maxKeys) return { ok: false, retryAfter: Math.ceil(this.windowMs / 1000) }; } // memory guard: fail closed
      a = []; this.map.set(key, a);
    }
    if (a.length >= this.max) return { ok: false, retryAfter: Math.max(1, Math.ceil((a[0] + this.windowMs - t) / 1000)) };
    a.push(t); return { ok: true };
  }
}

export const normalizeLoginName = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
/** Lowercase Firestore key for a login name, or '' when it cannot be a valid username. */
export function usernameKey(v) { const n = normalizeLoginName(v); return NAME_RE.test(n) ? n.toLowerCase() : ''; }

/** Client IP: Cloudflare's CF-Connecting-IP (Render sits behind Cloudflare, which overwrites it, so clients can't spoof it),
 *  else first hop of x-forwarded-for (spoofable; local/other proxies only), else the socket address. */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
  const xff = req.headers['x-forwarded-for'];
  const first = typeof cf === 'string' && cf ? cf.trim() : typeof xff === 'string' ? xff.split(',')[0].trim() : '';
  if (first && first.length <= 64 && /^[0-9a-fA-F:.]+$/.test(first)) return first;
  return req.socket?.remoteAddress || 'unknown';
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export const originAllowed = (origin, allowedOrigins, production) => allowedOrigins.includes(origin) || (!production && LOCAL_ORIGIN.test(origin));

export function createLoginHandler(opts = {}) {
  const {
    enabled = false, lookup, verifyPassword, createToken, banOf, allowedOrigins = [], production = false,
    now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    minFailMs = 700,                       // every failure takes at least this long (incl. unknown usernames)
    ipMax = 10, ipWindowMs = 5 * 60 * 1000, nameMax = 10, nameWindowMs = 15 * 60 * 1000,
    bodyTimeoutMs = 5000, log = () => {},
  } = opts;
  const ipLimit = new WindowLimiter(ipMax, ipWindowMs, now), nameLimit = new WindowLimiter(nameMax, nameWindowMs, now);

  const INVALID = { status: 401, body: { ok: false, code: 'invalid_credentials' } };
  const tooMany = (retryAfter) => ({ status: 429, body: { ok: false, code: 'rate_limited', retryAfter }, retryAfter });

  // Core, no HTTP: -> {status, body, retryAfter?}
  async function attempt(ip, username, password) {
    if (!enabled) return { status: 503, body: { ok: false, code: 'unavailable' } };
    const rl = ipLimit.hit('ip:' + ip);
    if (!rl.ok) return tooMany(rl.retryAfter);
    const key = usernameKey(username);
    if (key) { const nl = nameLimit.hit(key); if (!nl.ok) return tooMany(nl.retryAfter); }
    const t0 = now();
    const fail = async (res = INVALID) => { const left = minFailMs - (now() - t0); if (left > 0) await sleep(left); return res; };
    try {
      if (!key || typeof password !== 'string' || !password || password.length > MAX_PASSWORD) return await fail();
      const rec = await lookup(key);                     // {uid, email} | null
      if (!rec || !rec.uid || !rec.email) return await fail();
      const v = await verifyPassword(rec.email, password); // {ok:true} | {ok:false, code:'invalid'|'too_many'}
      if (!v.ok) return v.code === 'too_many' ? await fail(tooMany(300)) : await fail();
      const ban = banOf ? await banOf(rec.uid) : null; // only after the password was right: a wrong guess never learns whether an account is banned
      if (ban) return { status: 403, body: { ok: false, code: 'banned', until: ban.until ?? null, permanent: ban.until == null, reason: ban.reason || '' } };
      const token = await createToken(rec.uid);
      return { status: 200, body: { ok: true, token } };
    } catch (e) {
      log('[login] backend error:', e && e.message);
      return await fail({ status: 503, body: { ok: false, code: 'unavailable' } });
    }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []; let n = 0, done = false;
      const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => end({ err: 408 }), bodyTimeoutMs);
      timer.unref?.();
      const cl = Number(req.headers['content-length']);
      if (Number.isFinite(cl) && cl > MAX_BODY) return end({ err: 413 });
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) end({ err: 413 }); else chunks.push(c); });
      req.on('end', () => end({ raw: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', () => end({ err: 400 }));
      req.on('close', () => end({ err: 400 }));
    });
  }

  return async function handle(req, res) {
    const origin = req.headers.origin;
    const send = (status, body, extra = {}) => {
      const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin', ...extra };
      if (origin && originAllowed(origin, allowedOrigins, production)) h['Access-Control-Allow-Origin'] = origin;
      if (status === 413) h.Connection = 'close';
      res.writeHead(status, h); res.end(JSON.stringify(body));
    };
    if (origin && !originAllowed(origin, allowedOrigins, production)) return send(403, { ok: false, code: 'forbidden_origin' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method !== 'POST') return send(405, { ok: false, code: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return send(415, { ok: false, code: 'unsupported_media_type' });
    if (!enabled) return send(503, { ok: false, code: 'unavailable' });

    const ip = clientIp(req);
    const b = await readBody(req);
    if (b.err) return send(b.err, { ok: false, code: b.err === 413 ? 'too_large' : b.err === 408 ? 'timeout' : 'bad_request' });
    let o;
    try { o = JSON.parse(b.raw); } catch { return send(400, { ok: false, code: 'bad_request' }); }
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.username !== 'string' || typeof o.password !== 'string' || o.username.length > 64) return send(400, { ok: false, code: 'bad_request' });

    const r = await attempt(ip, o.username, o.password);
    send(r.status, r.body, r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {});
  };
}

// ---- real dependencies ----

/** Firebase Auth REST password check. -> {ok:true} | {ok:false, code:'invalid'|'too_many'}; throws on anything unexpected (network, bad key, 5xx). */
export function createRestVerifier({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
  return async (email, password) => {
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(timeoutMs),
    });
    let j = null; try { j = await res.json(); } catch { /* not json */ }
    if (res.ok) return { ok: true }; // the id/refresh tokens in j are discarded on purpose
    const m = String(j?.error?.message || '');
    if (m.startsWith('TOO_MANY_ATTEMPTS')) return { ok: false, code: 'too_many' };
    if (/^(INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|USER_DISABLED|INVALID_EMAIL|MISSING_PASSWORD)/.test(m)) return { ok: false, code: 'invalid' };
    throw new Error('identitytoolkit ' + res.status + ' ' + m.slice(0, 60));
  };
}

/** Admin-SDK lookups. fb = { db (Firestore), auth (admin.auth()) } from createFirebaseAuth. */
export function createFirebaseLoginDeps(fb, env = process.env, fetchImpl) {
  return {
    async lookup(key) {
      const s = await fb.db.collection('usernames').doc(key).get();
      const uid = s.exists ? s.data().uid : null;
      if (typeof uid !== 'string' || !uid) return null;
      try {
        const u = await fb.auth.getUser(uid);
        return u.disabled || !u.email ? null : { uid, email: u.email };
      } catch (e) { if (e && e.code === 'auth/user-not-found') return null; throw e; }
    },
    verifyPassword: createRestVerifier({ apiKey: env.FIREBASE_WEB_API_KEY || firebaseConfig.apiKey, fetchImpl }),
    createToken: (uid) => fb.auth.createCustomToken(uid),
  };
}
