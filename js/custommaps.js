// Admin-made maps for single-player: GET <server>/maps, cached in localStorage, never blocks or throws (the server may be asleep).
// CUSTOM = live registry {id: def} (def.modes = mode ids it belongs to); modes.js adds them to the single-player pools, main.js resolves them at match start.
import { validateMap, CUSTOM_ID_RE } from './mapdef.js';

export const MAPS_KEY = 'speedbike.maps.v1';
export const CUSTOM = {};
export const mapsUrl = (url) => String(url).replace(/^ws/i, 'http').replace(/\/+$/, '') + '/maps';

/** Replace the registry with the valid entries of a /maps reply. Returns false if the reply was malformed (registry untouched). */
export function useCustomMaps(c) {
  if (!c || !Array.isArray(c.maps)) return false;
  const next = {};
  for (const r of c.maps) {
    if (!r || typeof r.id !== 'string' || !CUSTOM_ID_RE.test(r.id)) continue;
    const v = validateMap({ ...r.def, modes: r.modes ?? r.def?.modes });
    if (v.ok) next[r.id] = { id: r.id, ...v.map };
  }
  for (const k of Object.keys(CUSTOM)) delete CUSTOM[k];
  Object.assign(CUSTOM, next); return true;
}
export function loadCachedMaps() {
  try { return useCustomMaps(JSON.parse(globalThis.localStorage.getItem(MAPS_KEY))); } catch { return false; }
}
export async function refreshCustomMaps(fetchFn = globalThis.fetch, url) {
  try {
    if (!url) { const { serverUrl } = await import('./net.js'); url = mapsUrl(serverUrl(globalThis.location ? globalThis.location.search : '')); }
    const r = await fetchFn(url), c = await r.json();
    if (!r.ok || !useCustomMaps(c)) return false;
    try { globalThis.localStorage.setItem(MAPS_KEY, JSON.stringify({ maps: c.maps })); } catch { /* storage unavailable */ }
    return true;
  } catch { return false; }
}
export function initCustomMaps() { loadCachedMaps(); refreshCustomMaps(); }
/** Ids of the custom maps playable in `modeId`, sorted by name. */
export const customFor = (modeId) => Object.values(CUSTOM).filter((d) => d.modes.includes(modeId)).sort((a, b) => a.name.localeCompare(b.name)).map((d) => d.id);
