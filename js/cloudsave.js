// Progress sync between the local save and the signed-in account (auth.js loadProgress/saveProgress).
// Merge rule: union of achievements / unlocks, max of stats, coins + equipped from the more recently modified save.
// Settings never sync. Network failures are silent; the next save retries. No DOM.
import * as auth from './auth.js';
import { getSave, progressOf, applyProgress, flushSave, setProgressListener, parseSave } from './save.js';
import { CATS } from './parts.js';

export const PUSH_DELAY_MS = 3000;
const union = (a, b) => [...new Set([...a, ...b])];

/** Merge two sanitized progress objects (progressOf shape). Returns a new progress object. */
export function mergeProgress(local, cloud) {
  const newer = cloud.updatedAt > local.updatedAt ? cloud : local;
  const stats = {};
  for (const k of Object.keys(local.stats)) stats[k] = Math.max(local.stats[k], cloud.stats[k] ?? 0);
  stats.winStreak = newer.stats.winStreak; // a streak is not monotonic: it follows the newer save
  const parts = {};
  for (const c of CATS) parts[c] = union(local.unlocks.parts[c], cloud.unlocks.parts[c]);
  return {
    coins: newer.coins, updatedAt: Math.max(local.updatedAt, cloud.updatedAt), stats,
    // ability charges are spendable like coins: they follow the newer save; infinite flags are permanent (union)
    unlocks: { abilities: union(local.unlocks.abilities, cloud.unlocks.abilities), abilityCount: { ...newer.unlocks.abilityCount },
      abilityInf: union(local.unlocks.abilityInf || [], cloud.unlocks.abilityInf || []), parts, achievements: union(local.unlocks.achievements, cloud.unlocks.achievements) },
    equipped: JSON.parse(JSON.stringify(newer.equipped)),
  };
}

/** What local progress should become when `uid` signs in. cloud = stored object or null. Returns the progress to keep (already sanitized). */
export function resolveProgress(localSave, cloud, uid) {
  const other = localSave.cloudUid && localSave.cloudUid !== uid; // local belongs to another account
  const local = progressOf(other ? parseSave(null) : localSave);  // never copy one account's progress into another
  if (!cloud || typeof cloud !== 'object') return local; // account has nothing yet: upload local (fresh if it was another account's)
  const c = progressOf(parseSave(JSON.stringify(cloud)));
  if (localSave.cloudUid && localSave.cloudUid !== uid) return c; // local belonged to another account: never mix them
  return parseSave(JSON.stringify(mergeProgress(local, c)));
}

let uid = null, synced = false, gen = 0, timer = null, busy = false, again = false, onApplied = () => {};

/** Called after cloud progress changed the local save (refresh coin display / menus). */
export function setOnApplied(fn) { onApplied = fn; }

async function pull() {
  const me = uid, g = gen;
  let cloud;
  try { cloud = await auth.loadProgress(); } catch { return; } // offline: retried on the next save
  if (g !== gen || me !== uid) return; // signed out / switched while waiting
  const d = getSave(), before = JSON.stringify(progressOf(d));
  const res = resolveProgress(d, cloud, me);
  applyProgress(res, me);
  synced = true;
  if (JSON.stringify(progressOf(getSave())) !== before) { try { onApplied(); } catch { /* ignore */ } }
  await push(); // cloud empty or merge result differs from what it holds
}

async function push() {
  if (!uid || !synced) return;
  if (busy) { again = true; return; }
  busy = true;
  try { do { again = false; try { await auth.saveProgress(progressOf(getSave())); } catch { /* retried on next save */ } } while (again); } finally { busy = false; }
}

/** Push now (visibility hidden / pagehide / before sign-out). */
export async function flushCloud() {
  if (timer) { clearTimeout(timer); timer = null; }
  flushSave();
  if (!uid) return;
  if (synced) await push(); else await pull();
}

function schedule() {
  if (!uid || timer) return;
  timer = setTimeout(() => { timer = null; if (synced) push(); else pull(); }, PUSH_DELAY_MS);
}

/** Auth-change hook: call with the user (or null) from auth.onAuthChange. */
export function cloudUserChanged(u) {
  const next = u ? u.uid : null;
  if (next === uid) return;
  gen++; uid = next; synced = false; again = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (uid) pull();
}

/** An admin edited the cloud progress (server `resync`). Normal: pull + merge now. force: take the cloud values as they are (lets edits that LOWER stats stick; unsynced local changes are dropped). */
export async function resyncCloud(force) {
  if (!uid) return;
  if (!force) { synced = false; return pull(); }
  const me = uid, g = gen;
  let cloud; try { cloud = await auth.loadProgress(); } catch { return; }
  if (g !== gen || me !== uid || !cloud) return;
  applyProgress(progressOf(parseSave(JSON.stringify(cloud))), me); synced = true;
  try { onApplied(); } catch { /* ignore */ }
}

export function initCloudSave() {
  setProgressListener(schedule);
  try {
    const hide = () => { if (document.visibilityState === 'hidden') flushCloud(); };
    document.addEventListener('visibilitychange', hide);
    globalThis.addEventListener('pagehide', () => flushCloud());
  } catch { /* no DOM (tests) */ }
}
export const _state = () => ({ uid, synced });
