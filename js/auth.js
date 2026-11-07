// Account adapter: one API, two backends (Firebase Auth + Firestore, or a localStorage DEV MOCK via ?backend=mock).
// No DOM. Never logs passwords. All failures are Errors with .code and a friendly .message.
//
// User object everywhere: { uid, email, username }.
// Firestore data model: users/{uid} = {username, createdAt}; usernames/{lowercaseName} = {uid, createdAt}.
import { sanitizeName, NAME_MAX } from './save.js';
import { firebaseConfig, isConfigured, FIREBASE_VERSION } from './firebase-config.js';

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
  'wrong-password': 'Current password is incorrect',
  'too-many-requests': 'Too many attempts. Try again later',
  'user-disabled': 'This account has been disabled',
  'recent-login': 'Please log out and log in again, then retry',
  denied: 'Not allowed (check the Firestore rules are published)',
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

export async function register(email, password, username) {
  const b = need();
  const un = validateUsername(username); if (un) { const e = fail('invalid-username'); e.message = un; throw e; }
  if (validateEmail(email)) throw fail('invalid-email');
  if (validatePassword(password)) throw fail('weak-password');
  await b.register(String(email).trim(), password, normalizeUsername(username));
  return currentUser();
}
export async function login(email, password) {
  const b = need();
  if (validateEmail(email)) throw fail('invalid-email');
  if (typeof password !== 'string' || !password) throw fail('invalid-credential');
  await b.login(String(email).trim(), password);
  return currentUser();
}
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
export async function deleteAccount(currentPw) { const b = needUser(); await b.deleteAccount(String(currentPw ?? '')); }
export async function resetPassword(email) {
  const b = need();
  if (validateEmail(email)) throw fail('invalid-email');
  await b.resetPassword(String(email).trim());
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
      delete d.names[nameKey(d.users[uid].username)]; delete d.users[uid]; d.session = null; save(d);
      emitUser(null);
    },
    async resetPassword() { /* pretend an email was sent, same answer for unknown addresses */ },
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
  'failed-precondition': 'unavailable', 'auth/operation-not-allowed': 'unconfigured',
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
    let username = '';
    try { const s = await fsM.getDoc(uref(u.uid)); username = s.exists() ? s.data().username : ''; } catch { /* offline: fall back below */ }
    emitUser({ uid: u.uid, email: u.email || '', username: username || sanitizeName((u.email || '').split('@')[0]) });
  }
  const reauthenticate = (pw) => authM.reauthenticateWithCredential(auth.currentUser, authM.EmailAuthProvider.credential(auth.currentUser.email, pw));
  return {
    async start() {
      await new Promise((res) => { let first = true; authM.onAuthStateChanged(auth, async (u) => { if (!busy) await publish(u); if (first) { first = false; res(); } }); });
    },
    register: (email, password, username) => wrap(async () => {
      busy = true;
      let cred = null;
      try {
        cred = await authM.createUserWithEmailAndPassword(auth, email, password);
        await fsM.runTransaction(db, async (tx) => {
          const taken = await tx.get(nref(username));
          if (taken.exists()) { const e = new Error('taken'); e.code = 'username-taken'; throw e; }
          tx.set(nref(username), { uid: cred.user.uid, createdAt: fsM.serverTimestamp() });
          tx.set(uref(cred.user.uid), { username, createdAt: fsM.serverTimestamp() });
        });
      } catch (e) {
        if (cred) { try { await authM.deleteUser(cred.user); } catch { try { await authM.signOut(auth); } catch { /* ignore */ } } } // roll back the half-made account
        busy = false; throw e;
      }
      busy = false;
      emitUser({ uid: cred.user.uid, email: cred.user.email || email, username });
    }),
    login: (email, password) => wrap(async () => { await authM.signInWithEmailAndPassword(auth, email, password); }),
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
    resetPassword: (email) => wrap(async () => { await authM.sendPasswordResetEmail(auth, email); }),
    idToken: () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)),
  };
}
