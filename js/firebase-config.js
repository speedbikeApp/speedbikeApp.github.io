// Firebase web-app config for online accounts.
//
// HOW TO FILL THIS IN: Firebase console -> Project settings -> General -> Your apps -> Web app -> "SDK setup and
// configuration" -> Config. Copy the values over the placeholders below (see README, "Online accounts (Firebase setup)").
// These values are NOT secrets (they ship to every browser); access is enforced by Auth + firestore.rules.
//
// While any required value still starts with "YOUR_" (or is empty) the game runs fully offline as before and the
// ACCOUNT screen says "Online accounts not configured".
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

// Pinned Firebase JS SDK version loaded from Google's CDN (no build step).
export const FIREBASE_VERSION = '10.12.2';

export function isConfigured(cfg = firebaseConfig) {
  return ['apiKey', 'authDomain', 'projectId', 'appId'].every((k) => typeof cfg[k] === 'string' && cfg[k].trim() !== '' && !/^YOUR_/.test(cfg[k]) && !cfg[k].includes('YOUR_PROJECT_ID'));
}
