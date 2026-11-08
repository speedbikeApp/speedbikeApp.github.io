// Release check: version.json (never cached) vs the built-in VERSION. A newer deploy blocks NEW multiplayer queueing until reload.
// A failed fetch (offline) never blocks anything.
import { VERSION } from './version.js';

let stale = false;
const subs = [];
export const isStale = () => stale;
export const onStale = (fn) => subs.push(fn);
/** true only for a real, different version string. */
export const differs = (remote, local = VERSION) => typeof remote === 'string' && remote !== '' && remote !== local;

export async function checkVersion() {
  if (stale) return true;
  try {
    const r = await fetch(new URL(`../version.json?ts=${Date.now()}`, import.meta.url), { cache: 'no-store' });
    if (r.ok && differs((await r.json()).v)) { stale = true; subs.forEach((f) => f()); }
  } catch { /* offline: ignore */ }
  return stale;
}

export function initUpdate() {
  const bar = document.createElement('div');
  bar.id = 'updBar'; bar.hidden = true;
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:#fc3;color:#000;font:bold 12px monospace;letter-spacing:1px;padding:6px 10px;text-align:center';
  bar.append('A new update is available — reload to play online ');
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = 'RELOAD'; b.style.cssText = 'margin-left:8px;font:inherit;padding:2px 10px;cursor:pointer';
  b.addEventListener('click', () => location.reload());
  bar.append(b); document.body.append(bar);
  onStale(() => { bar.hidden = false; const m = document.getElementById('pMulti'); if (m) m.disabled = true; });
  checkVersion();
  setInterval(checkVersion, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
}
