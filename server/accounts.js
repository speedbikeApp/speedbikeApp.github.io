// Account e-mail flows (JSON POST, CORS/limits like login.js):
//   /auth/signup/start {email,password}       -> 6-digit code by mail (account is NOT created yet)
//   /auth/signup/verify {email,password,code} -> creates the Firebase user (email verified) -> {ok, token} (custom token)
//   /auth/forgot/password {email}             -> mails a one-time reset link (email OR username accepted); generic answer always
//   /auth/forgot/username {email}             -> mails the username; generic answer always
//   /auth/reset {token,password}              -> sets the new password, kills the token + all sessions
// Passwords are never stored: pending sign-ups keep only {salted code hash, expiry, attempts}; the client re-sends the password with the code.
// Pending sign-ups and reset tokens live in server memory (a restart just means "request a new code/link").
// Everything outside is injected: mailer.send, deps {userByEmail, userByName, usernameOf, createUser, createToken, setPassword}, now, sleep.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { WindowLimiter, clientIp, originAllowed, usernameKey, MAX_BODY, MAX_PASSWORD } from './login.js';

export const CODE_TTL = 10 * 60e3, RESEND_MS = 60e3, MAX_ATTEMPTS = 5, RESET_TTL = 3 * 60e3, PASSWORD_MIN = 8, MAX_PENDING = 5000;
export const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
export const validEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const validPassword = (p) => typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= MAX_PASSWORD;
const sha = (...p) => createHash('sha256').update(p.join('\0')).digest('hex');
const eq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const R = (status, code, extra = {}) => ({ status, body: { ok: false, code, ...extra }, retryAfter: extra.retryAfter });
const OK = (extra = {}) => ({ status: 200, body: { ok: true, ...extra } });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (title, lines) => `<div style="font-family:sans-serif;max-width:480px"><h2>${esc(title)}</h2>${lines.map((l) => `<p>${l}</p>`).join('')}<p style="color:#888;font-size:12px">SpeedBike</p></div>`;

export function createAccountsHandler(opts = {}) {
  const {
    enabled = false, mailer, deps = {}, allowedOrigins = [], production = false, publicUrl = 'https://speedbikeapp.github.io',
    now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minMs = 700, bodyTimeoutMs = 5000, log = () => {},
  } = opts;
  const L = (max, win) => new WindowLimiter(max, win, now);
  const lim = {
    startIp: L(8, 10 * 60e3), startMail: L(5, 3600e3), verifyIp: L(20, 10 * 60e3), verifyMail: L(15, 3600e3),
    forgotIp: L(10, 10 * 60e3), forgotId: L(3, 15 * 60e3), resetIp: L(20, 10 * 60e3), ...opts.limits,
  };
  const pending = new Map();              // email -> {salt, codeHash, exp, sentAt, attempts}
  const tokens = new Map(), byUid = new Map(); // sha(token) -> {uid, ipHash, exp}; uid -> sha(token) (one active token per account)
  const pepper = randomBytes(16).toString('hex'); // so stored IP hashes can't be brute-forced from a leaked memory dump / log
  const ipHash = (ip) => sha(pepper, ip);
  const limited = (...rs) => { const r = rs.find((x) => !x.ok); return r ? R(429, 'rate_limited', { retryAfter: r.retryAfter }) : null; };
  const baseUrl = (origin) => (!production && origin && originAllowed(origin, [], false) ? origin : publicUrl).replace(/\/+$/, '');
  const sendBg = (mail) => { Promise.resolve().then(() => mailer.send(mail)).catch((e) => log('[mail] send failed:', e && e.message)); };

  function prune(t) {
    for (const [k, p] of pending) if (p.exp <= t) pending.delete(k);
    for (const [h, r] of tokens) if (r.exp <= t) { tokens.delete(h); if (byUid.get(r.uid) === h) byUid.delete(r.uid); }
  }

  async function floor(t0) { const left = minMs - (now() - t0); if (left > 0) await sleep(left); }

  const routes = {
    async '/auth/signup/start'(ip, o) {
      const email = normEmail(o.email);
      const rl = limited(lim.startIp.hit('ip:' + ip)); if (rl) return rl;
      if (!validEmail(email)) return R(400, 'invalid_email');
      if (!validPassword(o.password)) return R(400, 'weak_password');
      const t = now(), old = pending.get(email);
      if (old && old.exp > t && t - old.sentAt < RESEND_MS) return R(429, 'cooldown', { retryAfter: Math.ceil((old.sentAt + RESEND_MS - t) / 1000) });
      const rm = limited(lim.startMail.hit(email)); if (rm) return rm;
      if (await deps.userByEmail(email)) return R(409, 'email_in_use');
      if (pending.size >= MAX_PENDING) { prune(t); if (pending.size >= MAX_PENDING) return R(503, 'unavailable'); }
      const code = String(randomInt(0, 1e6)).padStart(6, '0'), salt = randomBytes(8).toString('hex');
      try {
        await mailer.send({
          to: email, subject: 'Your SpeedBike verification code',
          text: `Your SpeedBike verification code is ${code}\n\nIt expires in 10 minutes. If you did not try to sign up, ignore this email.`,
          html: page('Your SpeedBike code', [`Your verification code is <b style="font-size:24px;letter-spacing:4px">${code}</b>`, 'It expires in 10 minutes. If you did not try to sign up, ignore this email.']),
        });
      } catch (e) { log('[signup] mail failed:', e && e.message); return R(503, 'mail_failed'); }
      pending.set(email, { salt, codeHash: sha(salt, email, code), exp: t + CODE_TTL, sentAt: t, attempts: 0 });
      return OK({ resendIn: RESEND_MS / 1000, expiresIn: CODE_TTL / 1000 });
    },

    async '/auth/signup/verify'(ip, o) {
      const email = normEmail(o.email), code = typeof o.code === 'string' ? o.code.trim() : '';
      const rl = limited(lim.verifyIp.hit('ip:' + ip)); if (rl) return rl;
      if (!validEmail(email)) return R(400, 'invalid_email');
      if (!validPassword(o.password)) return R(400, 'weak_password');
      const rm = limited(lim.verifyMail.hit(email)); if (rm) return rm;
      const p = pending.get(email), t = now();
      if (!p || p.exp <= t) { pending.delete(email); return R(400, 'code_expired'); }
      if (!eq(p.codeHash, sha(p.salt, email, code))) {
        if (++p.attempts >= MAX_ATTEMPTS) { pending.delete(email); return R(400, 'code_voided'); }
        return R(400, 'code_invalid', { attemptsLeft: MAX_ATTEMPTS - p.attempts });
      }
      pending.delete(email); // single use
      try {
        if (await deps.userByEmail(email)) return R(409, 'email_in_use');
        const uid = await deps.createUser(email, o.password);
        return OK({ token: await deps.createToken(uid) });
      } catch (e) {
        if (e && e.code === 'auth/email-already-exists') return R(409, 'email_in_use');
        pending.set(email, p); throw e; // transient failure: the code stays usable
      }
    },

    async '/auth/forgot/password'(ip, o) {
      const t0 = now(), id = typeof o.email === 'string' ? o.email.trim().toLowerCase() : '';
      const rl = limited(lim.forgotIp.hit('ip:' + ip)); if (rl) return rl;
      if (!id || id.length > 254) return R(400, 'bad_request');
      const rm = limited(lim.forgotId.hit('pw:' + id)); if (rm) return rm;
      try {
        const rec = id.includes('@') ? (validEmail(id) ? await deps.userByEmail(id) : null) : usernameKey(id) ? await deps.userByName(usernameKey(id)) : null;
        if (rec && rec.uid && rec.email) {
          prune(now());
          const token = randomBytes(32).toString('base64url'), h = sha(token), prev = byUid.get(rec.uid);
          if (prev) tokens.delete(prev);
          tokens.set(h, { uid: rec.uid, ipHash: ipHash(ip), exp: now() + RESET_TTL }); byUid.set(rec.uid, h);
          const link = `${baseUrl(o._origin)}/?reset=${token}`;
          sendBg({
            to: rec.email, subject: 'Reset your SpeedBike password',
            text: `Open this link to choose a new SpeedBike password:\n${link}\n\nThe link works once, for 3 minutes, and only on the same network (IP address) you requested it from. If you did not ask for this, ignore this email.`,
            html: page('Reset your password', [`<a href="${esc(link)}">Choose a new password</a>`, 'The link works once, for 3 minutes, and only on the same network (IP address) you requested it from.', 'If you did not ask for this, ignore this email.']),
          });
        }
      } catch (e) { log('[forgot] backend error:', e && e.message); }
      await floor(t0);
      return OK();
    },

    async '/auth/forgot/username'(ip, o) {
      const t0 = now(), email = normEmail(o.email);
      const rl = limited(lim.forgotIp.hit('ip:' + ip)); if (rl) return rl;
      if (!email || email.length > 254) return R(400, 'bad_request');
      const rm = limited(lim.forgotId.hit('un:' + email)); if (rm) return rm;
      try {
        const rec = validEmail(email) ? await deps.userByEmail(email) : null, name = rec && rec.uid ? await deps.usernameOf(rec.uid) : null;
        if (name) sendBg({
          to: rec.email, subject: 'Your SpeedBike username',
          text: `Your SpeedBike username is: ${name}\n\nIf you did not ask for this, you can ignore this email.`,
          html: page('Your SpeedBike username', [`Your username is <b>${esc(name)}</b>`, 'If you did not ask for this, you can ignore this email.']),
        });
      } catch (e) { log('[forgot] backend error:', e && e.message); }
      await floor(t0);
      return OK();
    },

    async '/auth/reset'(ip, o) {
      const rl = limited(lim.resetIp.hit('ip:' + ip)); if (rl) return rl;
      if (typeof o.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(o.token)) return R(400, 'invalid_token');
      if (!validPassword(o.password)) return R(400, 'weak_password');
      const h = sha(o.token), r = tokens.get(h);
      if (!r || r.exp <= now()) { if (r) { tokens.delete(h); byUid.delete(r.uid); } return R(400, 'invalid_token'); }
      if (!eq(r.ipHash, ipHash(ip))) return R(403, 'ip_mismatch'); // token stays valid so the user can retry from the right network
      tokens.delete(h); byUid.delete(r.uid); // one-time
      try { await deps.setPassword(r.uid, o.password); } catch (e) { tokens.set(h, r); byUid.set(r.uid, h); throw e; }
      return OK();
    },
  };

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []; let n = 0, done = false;
      const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => end({ err: 408 }), bodyTimeoutMs); timer.unref?.();
      const cl = Number(req.headers['content-length']);
      if (Number.isFinite(cl) && cl > MAX_BODY) return end({ err: 413 });
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) end({ err: 413 }); else chunks.push(c); });
      req.on('end', () => end({ raw: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', () => end({ err: 400 })); req.on('close', () => end({ err: 400 }));
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
    const route = routes[req.url.split('?')[0]];
    if (!route) return send(404, { ok: false, code: 'not_found' });
    if (origin && !originAllowed(origin, allowedOrigins, production)) return send(403, { ok: false, code: 'forbidden_origin' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}), 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method !== 'POST') return send(405, { ok: false, code: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return send(415, { ok: false, code: 'unsupported_media_type' });
    if (!enabled) return send(503, { ok: false, code: 'unavailable' });
    const b = await readBody(req);
    if (b.err) return send(b.err, { ok: false, code: b.err === 413 ? 'too_large' : b.err === 408 ? 'timeout' : 'bad_request' });
    let o; try { o = JSON.parse(b.raw); } catch { return send(400, { ok: false, code: 'bad_request' }); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return send(400, { ok: false, code: 'bad_request' });
    o._origin = origin; // trusted: set after parsing, can't come from the body
    let r;
    try { r = await route(clientIp(req), o); } catch (e) { log('[accounts] backend error:', e && e.message); r = R(503, 'unavailable'); }
    send(r.status, r.body, r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {});
  };
}

/** Admin-SDK dependencies. fb = { db (Firestore), auth (admin.auth()) }. */
export function createFirebaseAccountDeps(fb) {
  const gone = (e) => e && e.code === 'auth/user-not-found';
  const rec = (u) => (u && u.email ? { uid: u.uid, email: u.email } : null);
  return {
    async userByEmail(email) { try { return rec(await fb.auth.getUserByEmail(email)); } catch (e) { if (gone(e)) return null; throw e; } },
    async userByName(key) {
      const s = await fb.db.collection('usernames').doc(key).get(), uid = s.exists ? s.data().uid : null;
      if (typeof uid !== 'string' || !uid) return null;
      try { return rec(await fb.auth.getUser(uid)); } catch (e) { if (gone(e)) return null; throw e; }
    },
    async usernameOf(uid) { const s = await fb.db.collection('users').doc(uid).get(), n = s.exists ? s.data().username : null; return typeof n === 'string' && n ? n : null; },
    async createUser(email, password) { return (await fb.auth.createUser({ email, password, emailVerified: true })).uid; },
    createToken: (uid) => fb.auth.createCustomToken(uid),
    async setPassword(uid, password) { await fb.auth.updateUser(uid, { password }); await fb.auth.revokeRefreshTokens(uid); },
  };
}
