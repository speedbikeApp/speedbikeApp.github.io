// Web push (installed web app only). Server: GET /push/key, POST /push/sub, POST /push/unsub (see server push contract). Every call is try/catch: never throws.
// Save setting `notify`: 'ask' (never answered), 'on', 'off'.
import { serverUrl } from './net.js';
import { getSave, setSetting } from './save.js';

export const pushUrl = (path, search = '', url = serverUrl(search)) => String(url).replace(/^ws/i, 'http').replace(/\/+$/, '') + path;
export const isInstalled = () => !!(globalThis.matchMedia && globalThis.matchMedia('(display-mode: standalone)').matches) || !!(globalThis.navigator && globalThis.navigator.standalone);
export const pushSupported = () => !!(globalThis.navigator && 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis);
/** base64url -> Uint8Array (applicationServerKey). */
export const keyBytes = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')), (c) => c.charCodeAt(0));
/** Show the one-time menu card? Only after install, with a server key, and never once answered. */
export const shouldAsk = (notify, avail, perm) => avail && notify === 'ask' && perm !== 'denied';

const search = () => (globalThis.location ? globalThis.location.search : '');
const post = (path, body) => fetch(pushUrl(path, search()), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
let reg = null, key; // key: undefined = not asked yet, null = server has no push
const ready = () => reg || (reg = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready));

/** true when this install can use push AND the server has it configured. */
export async function pushAvailable() {
  if (!isInstalled() || !pushSupported()) return false;
  try {
    if (key === undefined) key = (await (await fetch(pushUrl('/push/key', search()))).json()).key || null;
    await ready();
  } catch { return false; }
  return !!key;
}
export const notifyOn = () => getSave().settings.notify === 'on' && globalThis.Notification && Notification.permission === 'granted';

/** Must run inside a user gesture. Returns 'on' | 'denied' | 'error'. */
export async function enable() {
  try {
    if (!pushSupported()) return 'error';
    if ((await Notification.requestPermission()) !== 'granted') return 'denied'; // first await: iOS only allows the prompt directly inside the tap
    if (!(await pushAvailable())) return 'error';
    const r = await ready();
    const sub = (await r.pushManager.getSubscription()) || await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await post('/push/sub', { sub: sub.toJSON() });
    setSetting('notify', 'on'); return 'on';
  } catch { return 'error'; }
}
export async function disable() {
  setSetting('notify', 'off');
  try {
    const sub = await (await ready()).pushManager.getSubscription();
    if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe(); await post('/push/unsub', { endpoint }); }
  } catch { /* offline: the server drops dead endpoints itself */ }
}
/** App start: register the worker and send the "seen" ping while notifications are on. Returns whether push is available. */
export async function initPush() {
  const ok = await pushAvailable();
  if (ok && notifyOn()) { try { const sub = await (await ready()).pushManager.getSubscription(); if (sub) await post('/push/sub', { sub: sub.toJSON() }); } catch { /* retry next start */ } }
  return ok;
}
