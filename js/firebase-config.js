// Firebase web-app config for online accounts.
//
// HOW TO FILL THIS IN: Firebase console -> Project settings -> General -> Your apps -> Web app -> "SDK setup and
// configuration" -> Config. Copy the values over the placeholders below (see README, "Online accounts (Firebase setup)").
// These values are NOT secrets (they ship to every browser); access is enforced by Auth + firestore.rules.
//
// While any required value still starts with "YOUR_" (or is empty) the game runs fully offline as before and the
// ACCOUNT screen says "Online accounts not configured".
export const firebaseConfig = {
  apiKey: 'AIzaSyABu0WFgNP_scfWtJ4kIrHkUKCmTGQTBMM',
  authDomain: 'speedbike-9a552.firebaseapp.com',
  projectId: 'speedbike-9a552',
  storageBucket: 'speedbike-9a552.firebasestorage.app',
  messagingSenderId: '526006764314',
  appId: '1:526006764314:web:73570f9891531760ce62a3',
};

// Pinned Firebase JS SDK version loaded from Google's CDN (no build step).
export const FIREBASE_VERSION = '10.12.2';

export function isConfigured(cfg = firebaseConfig) {
  return ['apiKey', 'authDomain', 'projectId', 'appId'].every((k) => typeof cfg[k] === 'string' && cfg[k].trim() !== '' && !/^YOUR_/.test(cfg[k]) && !cfg[k].includes('YOUR_PROJECT_ID'));
}
