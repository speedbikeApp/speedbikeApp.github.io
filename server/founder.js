// Founder badge: an account created before FOUNDER_UNTIL (ISO date) is a founder for good. Unset = every account (pre-launch).
// The creation time comes from the auth backend (Firebase Auth user metadata; dev: first time the store saw the uid), never from client-writable docs.
export const parseFounderUntil = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

// createdAt(uid) -> ms (may throw). -> { until, is(uid) -> Promise<bool> }. A failed lookup is "no" but not cached (retried next time).
export function createFounders({ until = null, createdAt }) {
  const cache = new Map();
  return {
    until,
    async is(uid) {
      if (until === null) return true;
      if (cache.has(uid)) return cache.get(uid);
      let t; try { t = await createdAt(uid); } catch { return false; }
      const v = Number.isFinite(t) && t < until; cache.set(uid, v); return v;
    },
  };
}

// The icon shown next to a name: the player's pick ('' | 'admin' | 'founder' | 'star:N'; null = not sent yet -> admin, then founder). admin / founder only while the account has it.
export const sessionIcon = (pick, admin, founder) => (pick === null ? (admin ? 'admin' : founder ? 'founder' : '') : (pick === 'admin' && !admin) || (pick === 'founder' && !founder) ? '' : pick);
