// Garage catalog (custom items + overrides set by admins): GET <server>/catalog, cached in localStorage, merged into PARTS (parts.js applyCatalog).
// initCatalog() applies the cached copy synchronously and refreshes in the background; it never blocks or throws (the server may be asleep).
import { applyCatalog } from './parts.js';
import { reclamp } from './save.js';
import { serverUrl } from './net.js';

export const CATALOG_KEY = 'speedbike.catalog.v1';
export const catalogUrl = (search = '', url = serverUrl(search)) => String(url).replace(/^ws/i, 'http').replace(/\/+$/, '') + '/catalog';
const valid = (c) => !!c && typeof c === 'object' && Array.isArray(c.items) && (!c.overrides || typeof c.overrides === 'object');

/** Apply a catalog object (also re-validates the save). Returns false if it was malformed. */
export function useCatalog(c) {
  if (!valid(c)) return false;
  applyCatalog(c); reclamp();
  return true;
}
export function loadCachedCatalog() {
  try { return useCatalog(JSON.parse(globalThis.localStorage.getItem(CATALOG_KEY))); } catch { return false; }
}
export async function refreshCatalog(fetchFn = globalThis.fetch, url) {
  try {
    const r = await fetchFn(url || catalogUrl(globalThis.location ? globalThis.location.search : ''));
    const c = await r.json();
    if (!r.ok || !useCatalog(c)) return false;
    try { globalThis.localStorage.setItem(CATALOG_KEY, JSON.stringify({ items: c.items, overrides: c.overrides || {} })); } catch { /* storage unavailable */ }
    return true;
  } catch { return false; }
}
export function initCatalog() { loadCachedCatalog(); refreshCatalog(); }
