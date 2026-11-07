// Client-side friends state (pure: no DOM, no socket, no three). online.js feeds it the server's social messages (docs/MULTIPLAYER.md "Social");
// friends-ui.js renders it and hud.js asks isFriend(uid) for the blue person icon. The server is the only authority: this is a read-only mirror.
//   friends:  Map uid -> {uid, username, rank, online}      incoming / outgoing: Map uid -> {uid, username, rank}
const toMap = (list, online) => new Map((Array.isArray(list) ? list : []).filter((p) => p && typeof p.uid === 'string').map((p) => [p.uid, {
  uid: p.uid, username: String(p.username ?? '?'), rank: p.rank || null, ...(online ? { online: !!p.online } : {}),
}]));

export function createSocial() {
  const listeners = new Set();
  const s = { friends: new Map(), incoming: new Map(), outgoing: new Map(), ready: false, listeners };
  const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { if (typeof console !== 'undefined') console.error(e); } } };
  const other = (uid) => s.friends.get(uid) || s.incoming.get(uid) || s.outgoing.get(uid);
  return {
    state: s,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Feed a server message; returns true when it was a social state message. */
    apply(m) {
      if (!m || typeof m.t !== 'string') return false;
      switch (m.t) {
        case 'friends': s.friends = toMap(m.friends, true); s.incoming = toMap(m.incoming); s.outgoing = toMap(m.outgoing); s.ready = true; break;
        case 'fpresence': { const f = s.friends.get(m.uid); if (!f) return true; f.online = !!m.online; break; }
        case 'frank': { const f = other(m.uid); if (!f) return true; f.rank = m.rank || null; break; }
        case 'fname': { const f = other(m.uid); if (!f || typeof m.username !== 'string') return true; f.username = m.username; break; }
        default: return false;
      }
      emit();
      return true;
    },
    /** Signed out / switched account: forget everything. */
    reset() { s.friends = new Map(); s.incoming = new Map(); s.outgoing = new Map(); s.ready = false; emit(); },
    /** Friends, online first, then by name (case-insensitive). */
    sortedFriends() {
      return [...s.friends.values()].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
    },
    incomingList: () => [...s.incoming.values()].sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase())),
    outgoingList: () => [...s.outgoing.values()].sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase())),
    isFriend: (uid) => typeof uid === 'string' && s.friends.has(uid),
    pendingCount: () => s.incoming.size,
    onlineCount: () => { let n = 0; for (const f of s.friends.values()) if (f.online) n++; return n; },
  };
}

export const social = createSocial();

// Search-result button state per relationship (what the ADD button shows / does).
export const REL_ACTION = { none: { label: 'ADD', act: 'fadd' }, outgoing: { label: 'SENT', act: null }, incoming: { label: 'ACCEPT', act: 'faccept' }, friend: { label: 'FRIENDS', act: null } };

// Error text for a `fres` {ok:false, code}.
export const FRIEND_ERR = {
  self: 'THAT IS YOU', not_found: 'PLAYER NOT FOUND', already_friends: 'ALREADY FRIENDS', already_sent: 'REQUEST ALREADY SENT',
  limit_friends: 'YOUR FRIENDS LIST IS FULL', target_limit_friends: 'THEIR FRIENDS LIST IS FULL', limit_outgoing: 'TOO MANY PENDING REQUESTS',
  target_limit_incoming: 'THEY HAVE TOO MANY REQUESTS', no_request: 'REQUEST NO LONGER EXISTS', rate_limited: 'SLOW DOWN', unavailable: 'TRY AGAIN IN A MOMENT', bad_query: 'USE 2-12 LETTERS OR NUMBERS',
};
