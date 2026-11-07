// Client-side party state (pure: no DOM, no socket, no three). online.js feeds it the server's party messages (docs/MULTIPLAYER.md "Party");
// party-ui.js renders it. The server is the only authority: this is a read-only mirror plus a few derived questions (am I the leader, may I invite).
//   party: null | { id, leader, max, members:[{uid, username, rank, online}] }      invites: [{uid, username, until}]  (until = local clock ms)
export const PARTY_MAX = 4;

export function createParty(now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
  const listeners = new Set();
  const s = { party: null, invites: [], me: null, reason: '' };
  const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { if (typeof console !== 'undefined') console.error(e); } } };
  const cleanParty = (p) => (p && typeof p === 'object' && Array.isArray(p.members) && typeof p.leader === 'string' ? {
    id: p.id, leader: p.leader, max: Number(p.max) || PARTY_MAX,
    members: p.members.filter((m) => m && typeof m.uid === 'string').map((m) => ({ uid: m.uid, username: String(m.username ?? '?'), rank: m.rank || null, online: m.online !== false })),
  } : null);
  const api = {
    state: s,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setMe(uid) { s.me = uid || null; },
    /** Feed a server message; returns true when it was a party state message. */
    apply(m) {
      if (!m || typeof m.t !== 'string') return false;
      if (m.t === 'party') { s.party = cleanParty(m.party); s.reason = s.party ? '' : String(m.reason || ''); emit(); return true; }
      if (m.t === 'pinvites') {
        const t = now();
        s.invites = (Array.isArray(m.invites) ? m.invites : []).filter((i) => i && typeof i.uid === 'string' && Number(i.ttl) > 0)
          .map((i) => ({ uid: i.uid, username: String(i.username ?? '?'), until: t + Number(i.ttl) }));
        emit(); return true;
      }
      return false;
    },
    reset() { s.party = null; s.invites = []; s.reason = ''; emit(); },
    /** Invites that have not expired yet (drops the expired ones; returns true via the listener when something expired). */
    activeInvites() {
      const t = now(), live = s.invites.filter((i) => i.until > t);
      if (live.length !== s.invites.length) { s.invites = live; emit(); }
      return live;
    },
    inParty: () => !!s.party,
    isLeader: () => !!s.party && s.party.leader === s.me,
    leaderOf: () => (s.party ? s.party.members.find((m) => m.uid === s.party.leader) || null : null),
    isMember: (uid) => !!s.party && s.party.members.some((m) => m.uid === uid),
    size: () => (s.party ? s.party.members.length : 0),
    isFull: () => !!s.party && s.party.members.length >= (s.party.max || PARTY_MAX),
    /** May the INVITE TO PARTY button be enabled for this friend? (online, not already in our party, party not full) */
    canInvite: (friend) => !!friend && friend.online !== false && !api.isMember(friend.uid) && !api.isFull(),
    /** Only the leader (or somebody not in a party) may start a game. */
    canStartGame: () => !s.party || s.party.leader === s.me,
    /** Which member actions the viewer gets for `uid`: leader only, never on themselves. */
    memberActions: (uid) => (api.isLeader() && uid !== s.me && api.isMember(uid) ? ['transfer', 'kick'] : []),
  };
  return api;
}

export const party = createParty();

// Text for a `pres` {ok:false, code}, a `party` null reason and a `pevent`.
export const PARTY_ERR = {
  self: 'THAT IS YOU', not_friend: 'YOU CAN ONLY INVITE FRIENDS', offline: 'THEY ARE OFFLINE', party_full: 'PARTY IS FULL (MAX 4)', already_in_party: 'ALREADY IN YOUR PARTY',
  busy: 'FINISH THE QUEUE OR MATCH FIRST', invite_limit: 'THEY HAVE TOO MANY INVITES', no_invite: 'THE INVITE EXPIRED', not_in_party: 'YOU ARE NOT IN A PARTY',
  not_leader: 'ONLY THE PARTY LEADER CAN DO THAT', not_member: 'NOT IN YOUR PARTY', rate_limited: 'SLOW DOWN', party_offline: 'NOT ENOUGH PARTY MEMBERS ONLINE',
  member_busy: 'A PARTY MEMBER IS IN A MATCH OR QUEUE',
};
export const PARTY_GONE = { kicked: 'YOU WERE KICKED FROM THE PARTY', disbanded: 'PARTY DISBANDED', timeout: 'REMOVED FROM THE PARTY (OFFLINE)' };
export function partyEventText(e) {
  const n = e && e.username;
  switch (e && e.kind) {
    case 'invite': return `${n} invited you to a party`;
    case 'joined': return `${n} joined the party`;
    case 'left': return `${n} left the party`;
    case 'kicked': return `${n} was kicked from the party`;
    case 'leader': return `${n} is now the party leader`;
    default: return '';
  }
}
