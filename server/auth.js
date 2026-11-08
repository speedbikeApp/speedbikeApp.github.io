// Authentication. Firebase mode verifies the client's ID token with the Admin SDK; DEV mode trusts {dev:true, uid, username}.
// Mode is picked once at startup (see resolveAuthMode) and logged loudly.
export const DEFAULT_PROJECT = 'speedbike-9a552';

// Same charset/limits as js/save.js sanitizeName (letters/digits/space/_/-, max 12), without importing browser-side code.
export function sanitizeName(v) {
  const s = String(v ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 12).trim();
  return s || 'PLAYER';
}

export function resolveAuthMode(env = process.env) {
  const creds = !!(env.GOOGLE_APPLICATION_CREDENTIALS || env.FIREBASE_SERVICE_ACCOUNT);
  if (env.DEV_AUTH === '1') return 'dev';
  if (env.DEV_AUTH === '0' && !creds) throw new Error('DEV_AUTH=0 but no Firebase credentials (set GOOGLE_APPLICATION_CREDENTIALS)');
  return creds ? 'firebase' : 'dev';
}

export function createDevAuth() {
  console.warn('\n' + '!'.repeat(72) + '\n[auth] DEV AUTH: any client can claim ANY uid/username. Never expose this publicly.\n' + '!'.repeat(72) + '\n');
  return {
    mode: 'dev',
    async verify(hello) {
      if (hello.dev !== true) throw new Error('server is in dev-auth mode: send {dev:true, uid, username}');
      return { uid: hello.uid, username: sanitizeName(hello.username) };
    },
  };
}

/** True when usernames/{lowercase name} is reserved for uid. The reservation can only be created by its owner and never updated (firestore.rules),
 *  so it is the source of truth: an attacker can write any `username` into their own users/{uid} doc but cannot hold another player's reservation. */
export async function ownsName(db, uid, name) {
  if (typeof name !== 'string' || !name || name.length > 32) return false;
  const key = name.trim().replace(/\s+/g, ' ').toLowerCase(); // = js/auth.js nameKey
  try { const r = await db.collection('usernames').doc(key).get(); return r.exists && r.data().uid === uid; } catch { return false; }
}

// Returns { auth, db } (db = Firestore for ranks). firebase-admin is only imported in this mode.
export async function createFirebaseAuth(env = process.env) {
  const admin = (await import('firebase-admin')).default;
  const projectId = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT;
  const credential = env.FIREBASE_SERVICE_ACCOUNT ? admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) : admin.credential.applicationDefault();
  const app = admin.initializeApp({ credential, projectId });
  const db = admin.firestore(app), fbAuth = admin.auth(app);
  console.log(`[auth] FIREBASE mode: verifying ID tokens for project ${projectId}`);
  return {
    db, fbAuth, FieldPath: admin.firestore.FieldPath,
    auth: {
      mode: 'firebase',
      async verify(hello) {
        if (!hello.token) throw new Error('missing token');
        const dec = await fbAuth.verifyIdToken(hello.token, true); // checkRevoked: a deleted / disabled account is refused even with an unexpired token
        let name = '';
        try { const u = await db.collection('users').doc(dec.uid).get(); name = u.exists ? u.data().username : ''; } catch { /* fall through */ }
        if (!(await ownsName(db, dec.uid, name))) name = ''; // users/{uid}.username is client-writable: trust it only if usernames/ reserves it for this uid
        return { uid: dec.uid, username: sanitizeName(name || '') };
      },
    },
  };
}
