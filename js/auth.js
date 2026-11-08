// Account adapter: one API, two backends (Firebase Auth + Firestore, or a localStorage DEV MOCK via ?backend=mock).
// No DOM. Never logs passwords. All failures are Errors with .code and a friendly .message.
//
// User object everywhere: { uid, email, username }.
// Firestore data model: users/{uid} = {username, createdAt, progress}; progress = synced save fields (see cloudsave.js); usernames/{lowercaseName} = {uid, createdAt}.
import { sanitizeName, NAME_MAX } from './save.js';
import { firebaseConfig, isConfigured, FIREBASE_VERSION } from './firebase-config.js';
import { CFG } from './config.js';
import { banMessage } from './admin-core.js';

export const USERNAME_MIN = 3;
export const PASSWORD_MIN = 8;

const MESSAGES = {
  unconfigured: 'Online accounts not configured',
  unavailable: 'Could not reach the account service. Check your connection.',
  'not-signed-in': 'You are not signed in',
  'invalid-email': 'That email address is not valid',
  'invalid-username': 'Invalid username',
  'weak-password': `Password must be at least ${PASSWORD_MIN} characters`,
  'username-taken': 'That username is already taken',
  'email-in-use': 'An account with that email already exists',
  'invalid-credential': 'Wrong email or password',
  'invalid-login': 'Wrong username or password',
  'login-unavailable': 'Login server unavailable — try logging in with your email',
  'wrong-password': 'Current password is incorrect',
  'too-many-requests': 'Too many attempts. Try again later',
  'user-disabled': 'This account has been disabled',
  'recent-login': 'Please log out and log in again, then retry',
  denied: 'Not allowed (check the Firestore rules are published)',
  'code-invalid': 'That code is not right',
  'code-expired': 'That code expired or was never sent. Request a new one',
  'code-voided': 'Too many wrong codes. Request a new one',
  cooldown: 'Please wait a moment before requesting another code',
  'rate-limited': 'Too many attempts. Try again later',
  'invalid-token': 'This reset link is invalid, already used or expired. Request a new one',
  'ip-mismatch': 'Open the link on the same network/device you requested it from',
  'mail-failed': 'Could not send the email. Try again later',
  unknown: 'Something went wrong. Try again',
};
export function fail(code) { const e = new Error(MESSAGES[code] || MESSAGES.unknown); e.code = MESSAGES[code] ? code : 'unknown'; e.ours = true; return e; }

// ---- validation (each returns an error string, '' when fine) ----
export function validateEmail(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return 'Enter your email';
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? '' : MESSAGES['invalid-email'];
}
export function validatePassword(v) {
  const s = typeof v === 'string' ? v : '';
  if (s.length < PASSWORD_MIN) return `At least ${PASSWORD_MIN} characters`;
  return s.length > 128 ? 'At most 128 characters' : '';
}
// Same charset / length rules as save.js sanitizeName; names must already be clean (no silent rewriting) and 3+ chars.
export const normalizeUsername = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
export function validateUsername(v) {
  const t = normalizeUsername(v);
  if (t.length < USERNAME_MIN) return `At least ${USERNAME_MIN} characters`;
  if (t.length > NAME_MAX) return `At most ${NAME_MAX} characters`;
  if (sanitizeName(t) !== t) return 'Letters, numbers, space, _ and - only';
  return '';
}
const nameKey = (name) => normalizeUsername(name).toLowerCase();

// ---- adapter state ----
let backend = null, mode = 'none', user = null, readyErr = '';
const listeners = new Set();
const emit = (u) => { user = u ? { uid: u.uid, email: u.email, username: u.username } : null; for (const cb of [...listeners]) { try { cb(user ? { ...user } : null); } catch { /* listener bug must not break auth */ } } };

/** Choose and start a backend. opts.backend: 'mock' | 'firebase' (default: ?backend=mock in the URL, else firebase if configured). */
export async function init(opts = {}) {
  let want = opts.backend;
  if (!want) { try { want = new URLSearchParams(globalThis.location?.search || '').get('backend') === 'mock' ? 'mock' : 'firebase'; } catch { want = 'firebase'; } }
  backend = null; mode = 'none'; readyErr = ''; user = null;
  if (want === 'mock') { backend = createMock(emit, opts.storage); mode = 'mock'; }
  else if (isConfigured(opts.config || firebaseConfig)) {
    try { backend = await createFirebase(emit, opts.config || firebaseConfig); mode = 'firebase'; } catch { mode = 'error'; readyErr = MESSAGES.unavailable; }
  }
  if (backend) await backend.start();
  return status();
}
/** {mode: 'firebase'|'mock'|'none'|'error', configured, error} */
export const status = () => ({ mode, configured: mode === 'firebase' || mode === 'mock', error: readyErr });
export const currentUser = () => (user ? { ...user } : null);
/** Firebase ID token of the signed-in user for the multiplayer server hello (null for the mock backend / signed out). */
export async function getIdToken() { try { return (user && backend && backend.idToken) ? await backend.idToken() : null; } catch { return null; } }
/** cb(user|null) is called now and on every change. Returns an unsubscribe function. */
export function onAuthChange(cb) { listeners.add(cb); try { cb(currentUser()); } catch { /* ignore */ } return () => listeners.delete(cb); }

function need() { if (!backend) throw fail(mode === 'error' ? 'unavailable' : 'unconfigured'); return backend; }
function needUser() { const b = need(); if (!user) throw fail('not-signed-in'); return b; }

export async function register(email, password, username) { // mock backend only: the real flow is signupStart -> signupVerify -> chooseUsername
  const b = need(); if (!b.register) throw fail('unavailable');
  const un = validateUsername(username); if (un) { const e = fail('invalid-username'); e.message = un; throw e; }
  if (validateEmail(email)) throw fail('invalid-email');
  if (validatePassword(password)) throw fail('weak-password');
  await b.register(String(email).trim(), password, normalizeUsername(username));
  return currentUser();
}
/** True when the login identifier is an email address (contains '@'; usernames can never contain it). */
export const isEmailIdentifier = (v) => typeof v === 'string' && v.includes('@');

/** HTTP(S) URL of the game server's login endpoint, derived from the WebSocket URL (ws->http, wss->https). '' when it cannot be derived. */
export function loginServerUrl(wsUrl = serverWsUrl()) {
  try {
    const u = new URL(String(wsUrl));
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return '';
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/auth/login'; u.search = ''; u.hash = ''; u.username = ''; u.password = '';
    return u.toString();
  } catch { return ''; }
}
function serverWsUrl() { // same rule as net.js serverUrl: ?server=ws://... wins over CFG.net.url
  try { const q = new URLSearchParams(globalThis.location?.search || '').get('server'); if (q && /^wss?:\/\/[^\s]+$/i.test(q)) return q; } catch { /* ignore */ }
  return CFG.net.url;
}

/** URL of another /auth/... endpoint of the game server (same host rule as loginServerUrl). */
export const authServerUrl = (path, wsUrl) => { const u = loginServerUrl(wsUrl); return u ? u.replace('/auth/login', path) : ''; };
/** The one-time password-reset token in a page query string (?reset=...), '' if absent / malformed. */
export const resetTokenOf = (search) => { try { const t = new URLSearchParams(search).get('reset') || ''; return /^[\w-]{43}$/.test(t) ? t : ''; } catch { return ''; } };

const SERVER_CODES = { invalid_email: 'invalid-email', weak_password: 'weak-password', email_in_use: 'email-in-use', code_invalid: 'code-invalid', code_expired: 'code-expired', code_voided: 'code-voided', invalid_token: 'invalid-token', ip_mismatch: 'ip-mismatch', mail_failed: 'mail-failed', unavailable: 'login-unavailable', bad_request: 'unknown' };
/** POST JSON to an account-mail endpoint -> response body ({ok:true,...}). Waits (like fetchLoginToken) while the sleeping server wakes up.
 *  Throws friendly errors; cooldown / rate limits carry .retryAfter, wrong codes .attemptsLeft. deps: {fetch, sleep, now, onStatus, wakeMs, retryMs, timeoutMs}. */
export async function callAuth(url, payload, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch, now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const wakeMs = deps.wakeMs ?? LOGIN_WAKE_MS, retryMs = deps.retryMs ?? 2500, timeoutMs = deps.timeoutMs ?? 15000;
  if (!url || typeof doFetch !== 'function') throw fail('login-unavailable');
  const deadline = now() + wakeMs;
  let waking = false;
  for (;;) {
    let res = null, body = null;
    try {
      res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store', credentials: 'omit', signal: globalThis.AbortSignal?.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
      try { body = await res.json(); } catch { body = null; }
    } catch { res = null; }
    if (res && body && typeof body === 'object') {
      if (body.ok === true) return body;
      const secs = Number(body.retryAfter) || Number(res.headers?.get?.('retry-after')) || 60;
      if (body.code === 'cooldown') { const e = fail('cooldown'); e.retryAfter = secs; e.message = `Please wait ${secs} s before requesting another code`; throw e; }
      if (body.code === 'rate_limited') { const e = fail('rate-limited'); e.retryAfter = secs; e.message = `Too many attempts, try again in ${Math.max(1, Math.ceil(secs / 60))} min`; throw e; }
      if (res.status < 500 || body.code === 'unavailable' || body.code === 'mail_failed') {
        const e = fail(SERVER_CODES[body.code] || 'unknown');
        if (body.code === 'code_invalid' && body.attemptsLeft >= 0) { e.attemptsLeft = body.attemptsLeft; e.message = `That code is not right (${body.attemptsLeft} ${body.attemptsLeft === 1 ? 'try' : 'tries'} left)`; }
        throw e;
      }
    }
    if (now() >= deadline) throw fail('login-unavailable');
    if (!waking) { waking = true; try { deps.onStatus && deps.onStatus('waking'); } catch { /* ignore */ } }
    await sleep(retryMs);
  }
}

export const LOGIN_WAKE_MS = 60000; // how long we keep retrying while the (sleeping) login server wakes up

/** POST {username,password} to the login server -> custom token string. Retries network errors / 5xx for up to LOGIN_WAKE_MS (Render free tier sleeps).
 *  deps: {fetch, sleep, now, onStatus('waking'), wakeMs, retryMs, timeoutMs}. Throws fail('invalid-login' | 'rate-limited' | 'login-unavailable'). */
export async function fetchLoginToken(url, username, password, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch, now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const wakeMs = deps.wakeMs ?? LOGIN_WAKE_MS, retryMs = deps.retryMs ?? 2500, timeoutMs = deps.timeoutMs ?? 15000;
  if (!url || typeof doFetch !== 'function') throw fail('login-unavailable');
  const deadline = now() + wakeMs;
  let waking = false;
  for (;;) {
    let res = null, body = null;
    try {
      res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), cache: 'no-store', credentials: 'omit', signal: globalThis.AbortSignal?.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
      try { body = await res.json(); } catch { body = null; }
    } catch { res = null; } // unreachable / asleep (no CORS headers on the proxy's wake-up page) / timed out
    if (res) {
      if (res.status === 200 && body && body.ok === true && typeof body.token === 'string' && body.token) return body.token;
      if (res.status === 403 && body && body.code === 'banned') { const e = fail('login-unavailable'); e.code = 'banned'; e.message = banMessage(body); throw e; } // only sent after a correct password
      if (res.status === 401 || res.status === 400) throw fail('invalid-login');
      if (res.status === 429) {
        const secs = Number(body && body.retryAfter) || Number(res.headers?.get?.('retry-after')) || 60;
        const e = fail('too-many-requests'); e.code = 'rate-limited'; e.retryAfter = secs;
        e.message = `Too many attempts, try again in ${Math.max(1, Math.ceil(secs / 60))} min`; throw e;
      }
      if (body && body.code === 'unavailable') throw fail('login-unavailable'); // the server itself says it cannot do username login: do not wait
    }
    if (now() >= deadline) throw fail('login-unavailable');
    if (!waking) { waking = true; try { deps.onStatus && deps.onStatus('waking'); } catch { /* ignore */ } }
    await sleep(retryMs);
  }
}

/** Log in with an email (contains '@') or a username. opts.onStatus('waking') fires if the login server is asleep. */
export async function login(identifier, password, opts = {}) {
  const b = need();
  const id = typeof identifier === 'string' ? identifier.trim() : '';
  if (typeof password !== 'string' || !password) throw fail(isEmailIdentifier(id) ? 'invalid-credential' : 'invalid-login');
  if (isEmailIdentifier(id)) {
    if (validateEmail(id)) throw fail('invalid-email');
    await b.login(id, password);
  } else {
    if (validateUsername(id) || password.length > 128) throw fail('invalid-login'); // malformed name: same generic error, no request
    await b.loginUsername(normalizeUsername(id), password, opts);
  }
  return currentUser();
}
/** Re-read the signed-in user's profile (an admin may have renamed the account). */
export async function refreshUser() { if (backend && backend.refresh) await backend.refresh(); }
export async function logout() { if (backend) await backend.logout(); }
export async function changeUsername(name) {
  const b = needUser();
  const msg = validateUsername(name); if (msg) { const e = fail('invalid-username'); e.message = msg; throw e; }
  await b.changeUsername(normalizeUsername(name));
  return currentUser();
}
export async function changePassword(currentPw, newPw) {
  const b = needUser();
  if (validatePassword(newPw)) throw fail('weak-password');
  await b.changePassword(String(currentPw ?? ''), newPw);
}
/** Cloud progress of the signed-in user: object, or null when none stored yet. Throws on network errors. */
export async function loadProgress() { const b = needUser(); return b.loadProgress(); }
/** Store progress (plain JSON object) in the signed-in user's own doc. */
export async function saveProgress(p) { const b = needUser(); await b.saveProgress(p); }
export async function deleteAccount(currentPw) { const b = needUser(); await b.deleteAccount(String(currentPw ?? '')); }

// ---- e-mail flows (server/accounts.js). Sign-up: signupStart (mails a code) -> signupVerify (creates the account, signs in) -> chooseUsername. opts.onStatus('waking') as in login. ----
/** -> {resendIn: seconds}. The password is only kept in memory by the caller and sent again with the code. */
export async function signupStart(email, password, opts = {}) {
  const b = need();
  if (validateEmail(email)) throw fail('invalid-email');
  if (validatePassword(password)) throw fail('weak-password');
  return b.signupStart(String(email).trim(), password, opts);
}
export async function signupVerify(email, password, code, opts = {}) {
  const b = need();
  if (!/^\d{6}$/.test(String(code).trim())) throw fail('code-invalid');
  await b.signupVerify(String(email).trim(), password, String(code).trim(), opts);
  return currentUser(); // username is '' until chooseUsername
}
/** First username of a signed-in account that has none yet (a user whose profile has no username must pick one before anything else). */
export async function chooseUsername(name) {
  const b = needUser();
  const msg = validateUsername(name); if (msg) { const e = fail('invalid-username'); e.message = msg; throw e; }
  await b.chooseUsername(normalizeUsername(name));
  return currentUser();
}
/** Generic by design: resolves for unknown accounts too. identifier = email or username. */
export async function forgotPassword(identifier, opts = {}) {
  const b = need(), id = typeof identifier === 'string' ? identifier.trim() : '';
  if (!id) throw fail('invalid-email');
  if (id.includes('@') ? validateEmail(id) : validateUsername(id)) throw fail('invalid-email');
  await b.forgotPassword(id, opts);
}
export async function forgotUsername(email, opts = {}) {
  const b = need();
  if (validateEmail(email)) throw fail('invalid-email');
  await b.forgotUsername(String(email).trim(), opts);
}
/** Set a new password with the one-time token from the mailed link. */
export async function resetPassword(token, newPw, opts = {}) {
  const b = need();
  if (validatePassword(newPw)) throw fail('weak-password');
  if (!resetTokenOf('?reset=' + token)) throw fail('invalid-token');
  await b.resetPassword(token, newPw, opts);
}

// ======================= MOCK backend (dev / tests only; passwords stored in plain text on purpose) =======================
const MOCK_KEY = 'speedbike.mock.auth.v1';
function createMock(emitUser, storage) {
  const mem = new Map();
  const store = storage || (() => { try { return globalThis.localStorage || null; } catch { return null; } })() || { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const load = () => { try { const d = JSON.parse(store.getItem(MOCK_KEY)); if (d && d.users && d.names) return d; } catch { /* fresh */ } return { users: {}, names: {}, session: null }; };
  const save = (d) => { try { store.setItem(MOCK_KEY, JSON.stringify(d)); } catch { /* ignore */ } };
  const pub = (d, uid) => { const u = d.users[uid]; return u ? { uid, email: u.email, username: u.username } : null; };
  const byEmail = (d, email) => Object.keys(d.users).find((id) => d.users[id].email.toLowerCase() === email.toLowerCase());
  return {
    async start() { const d = load(); emitUser(d.session ? pub(d, d.session) : null); },
    async register(email, password, username) {
      const d = load();
      if (byEmail(d, email)) throw fail('email-in-use');
      const k = nameKey(username);
      if (d.names[k]) throw fail('username-taken');
      const uid = 'mock-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      d.users[uid] = { email, password, username, createdAt: Date.now() }; d.names[k] = uid; d.session = uid; save(d);
      emitUser(pub(d, uid));
    },
    async login(email, password) {
      const d = load(), uid = byEmail(d, email);
      if (!uid || d.users[uid].password !== password) throw fail('invalid-credential');
      d.session = uid; save(d); emitUser(pub(d, uid));
    },
    async loginUsername(username, password) { // same generic failure for unknown name and wrong password
      const d = load(), uid = d.names[nameKey(username)];
      if (!uid || !d.users[uid] || d.users[uid].password !== password) throw fail('invalid-login');
      d.session = uid; save(d); emitUser(pub(d, uid));
    },
    async logout() { const d = load(); d.session = null; save(d); emitUser(null); },
    async changeUsername(name) {
      const d = load(), uid = d.session, k = nameKey(name);
      if (!uid || !d.users[uid]) throw fail('not-signed-in');
      if (d.names[k] && d.names[k] !== uid) throw fail('username-taken');
      delete d.names[nameKey(d.users[uid].username)]; d.names[k] = uid; d.users[uid].username = name; save(d);
      emitUser(pub(d, uid));
    },
    async changePassword(currentPw, newPw) {
      const d = load(), uid = d.session;
      if (!uid || !d.users[uid]) throw fail('not-signed-in');
      if (d.users[uid].password !== currentPw) throw fail('wrong-password');
      d.users[uid].password = newPw; save(d);
    },
    async deleteAccount(currentPw) {
      const d = load(), uid = d.session;
      if (!uid || !d.users[uid]) throw fail('not-signed-in');
      if (d.users[uid].password !== currentPw) throw fail('wrong-password');
      delete d.names[nameKey(d.users[uid].username)]; delete d.users[uid]; if (d.progress) delete d.progress[uid]; d.session = null; save(d);
      emitUser(null);
    },
    async loadProgress() { const d = load(), p = d.progress && d.progress[d.session]; return p ? JSON.parse(JSON.stringify(p)) : null; },
    async saveProgress(p) { const d = load(); (d.progress ||= {})[d.session] = JSON.parse(JSON.stringify(p)); save(d); },
    // e-mail flows: the mock "mails" the fixed code 123456; reset tokens are 'mock:<email>'
    async signupStart(email) { const d = load(); if (byEmail(d, email)) throw fail('email-in-use'); (d.pending ||= {})[email.toLowerCase()] = 1; save(d); return { resendIn: 60 }; },
    async signupVerify(email, password, code) {
      const d = load(), k = email.toLowerCase();
      if (!d.pending || !d.pending[k]) throw fail('code-expired');
      if (code !== '123456') throw fail('code-invalid');
      if (byEmail(d, email)) throw fail('email-in-use');
      const uid = 'mock-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      delete d.pending[k]; d.users[uid] = { email, password, username: '', createdAt: Date.now() }; d.session = uid; save(d); emitUser(pub(d, uid));
    },
    async chooseUsername(name) {
      const d = load(), uid = d.session;
      if (!uid || !d.users[uid]) throw fail('not-signed-in');
      if (d.names[nameKey(name)]) throw fail('username-taken');
      d.names[nameKey(name)] = uid; d.users[uid].username = name; save(d); emitUser(pub(d, uid));
    },
    async forgotPassword() { /* pretend an email was sent, same answer for unknown accounts */ },
    async forgotUsername() { /* same */ },
    async resetPassword(token, pw) {
      const d = load(), uid = token.startsWith('mock:') ? byEmail(d, token.slice(5)) : null;
      if (!uid) throw fail('invalid-token');
      d.users[uid].password = pw; save(d);
    },
    _dump: () => load(),
  };
}
export const _mockDump = () => backend?._dump?.();

// ======================= FIREBASE backend =======================
const FB_CODES = {
  'auth/invalid-email': 'invalid-email', 'auth/user-not-found': 'invalid-credential', 'auth/wrong-password': 'invalid-credential',
  'auth/invalid-credential': 'invalid-credential', 'auth/invalid-login-credentials': 'invalid-credential', 'auth/email-already-in-use': 'email-in-use',
  'auth/weak-password': 'weak-password', 'auth/too-many-requests': 'too-many-requests', 'auth/network-request-failed': 'unavailable',
  'auth/requires-recent-login': 'recent-login', 'auth/user-disabled': 'user-disabled', 'permission-denied': 'denied', unavailable: 'unavailable',
  'failed-precondition': 'unavailable', 'auth/operation-not-allowed': 'unconfigured', 'auth/invalid-custom-token': 'unavailable', 'auth/custom-token-mismatch': 'unavailable',
};
export function mapFirebaseError(err, reauth = false) {
  if (err && err.ours) return err; // already one of ours
  if (err && err.code === 'username-taken') return fail('username-taken');
  let c = FB_CODES[err && err.code] || 'unknown';
  if (reauth && c === 'invalid-credential') c = 'wrong-password';
  return fail(c);
}

async function createFirebase(emitUser, cfg) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
  const [appM, authM, fsM] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  const app = appM.initializeApp(cfg), auth = authM.getAuth(app), db = fsM.getFirestore(app);
  const uref = (uid) => fsM.doc(db, 'users', uid), nref = (name) => fsM.doc(db, 'usernames', nameKey(name));
  let busy = false; // register / delete in progress: onAuthStateChanged must not publish half-made accounts
  const wrap = async (fn, reauth) => { try { return await fn(); } catch (e) { throw mapFirebaseError(e, reauth); } };
  async function publish(u) {
    if (!u) { emitUser(null); return; }
    let username = null; // null = could not read the profile
    try { const s = await fsM.getDoc(uref(u.uid)); username = (s.exists() && s.data().username) || ''; } catch { /* offline: fall back below */ }
    emitUser({ uid: u.uid, email: u.email || '', username: username ?? sanitizeName((u.email || '').split('@')[0]) }); // '' = no username yet: the UI asks for one
  }
  const reauthenticate = (pw) => authM.reauthenticateWithCredential(auth.currentUser, authM.EmailAuthProvider.credential(auth.currentUser.email, pw));
  return {
    async start() {
      await new Promise((res) => { let first = true; authM.onAuthStateChanged(auth, async (u) => { if (!busy) await publish(u); if (first) { first = false; res(); } }); });
    },
    // Sign-up goes through the game server (e-mail code); the client never calls createUserWithEmailAndPassword.
    signupStart: (email, password, opts) => wrap(async () => { const r = await callAuth(authServerUrl('/auth/signup/start'), { email, password }, { onStatus: opts && opts.onStatus }); return { resendIn: Number(r.resendIn) || 60 }; }),
    signupVerify: (email, password, code, opts) => wrap(async () => {
      const r = await callAuth(authServerUrl('/auth/signup/verify'), { email, password, code }, { onStatus: opts && opts.onStatus });
      if (typeof r.token !== 'string' || !r.token) throw fail('unavailable');
      await authM.signInWithCustomToken(auth, r.token);
    }),
    chooseUsername: (name) => wrap(async () => {
      const uid = auth.currentUser.uid;
      await fsM.runTransaction(db, async (tx) => {
        const taken = await tx.get(nref(name));
        if (taken.exists()) { const e = new Error('taken'); e.code = 'username-taken'; throw e; }
        tx.set(nref(name), { uid, createdAt: fsM.serverTimestamp() });
        tx.set(uref(uid), { username: name, createdAt: fsM.serverTimestamp() }, { merge: true });
      });
      emitUser({ ...user, username: name });
    }),
    forgotPassword: (id, opts) => wrap(async () => { await callAuth(authServerUrl('/auth/forgot/password'), { email: id }, { onStatus: opts && opts.onStatus }); }),
    forgotUsername: (email, opts) => wrap(async () => { await callAuth(authServerUrl('/auth/forgot/username'), { email }, { onStatus: opts && opts.onStatus }); }),
    resetPassword: (token, password, opts) => wrap(async () => { await callAuth(authServerUrl('/auth/reset'), { token, password }, { onStatus: opts && opts.onStatus }); }),
    login: (email, password) => wrap(async () => { await authM.signInWithEmailAndPassword(auth, email, password); }),
    // Username login: the game server checks the password and returns a custom token (the email never reaches the browser).
    loginUsername: (username, password, opts) => wrap(async () => {
      const token = await fetchLoginToken(loginServerUrl(), username, password, { onStatus: opts && opts.onStatus });
      await authM.signInWithCustomToken(auth, token);
    }),
    refresh: async () => { if (auth.currentUser) await publish(auth.currentUser); },
    logout: () => wrap(async () => { await authM.signOut(auth); }),
    changeUsername: (name) => wrap(async () => {
      const uid = auth.currentUser.uid, old = user.username;
      await fsM.runTransaction(db, async (tx) => {
        const target = await tx.get(nref(name));
        if (target.exists() && target.data().uid !== uid) { const e = new Error('taken'); e.code = 'username-taken'; throw e; }
        if (nameKey(old) !== nameKey(name)) { // pure case change keeps the same reservation
          tx.set(nref(name), { uid, createdAt: fsM.serverTimestamp() });
          tx.delete(nref(old));
        }
        tx.update(uref(uid), { username: name });
      });
      emitUser({ ...user, username: name });
    }),
    changePassword: (currentPw, newPw) => wrap(async () => {
      await wrap(() => reauthenticate(currentPw), true);
      await authM.updatePassword(auth.currentUser, newPw);
    }),
    deleteAccount: (currentPw) => wrap(async () => {
      await wrap(() => reauthenticate(currentPw), true);
      const uid = auth.currentUser.uid, name = user.username;
      busy = true;
      try {
        const batch = fsM.writeBatch(db); batch.delete(nref(name)); batch.delete(uref(uid)); await batch.commit();
        await authM.deleteUser(auth.currentUser);
      } finally { busy = false; }
      emitUser(null);
    }),
    // users/{uid}.progress (own doc, covered by the existing owner rule); merge keeps username / createdAt
    loadProgress: () => wrap(async () => { const s = await fsM.getDoc(uref(auth.currentUser.uid)); return s.exists() && s.data().progress ? s.data().progress : null; }),
    saveProgress: (p) => wrap(async () => { await fsM.setDoc(uref(auth.currentUser.uid), { progress: p }, { merge: true }); }),
    idToken: () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)),
  };
}
