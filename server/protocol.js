// Client message validation + rate limiting. Everything from a socket is untrusted: parse defensively, return plain objects only.
import { CFG } from '../js/config.js';
import { isAbilityId } from '../js/abilities.js';
export const MAX_MSG = 1024;        // bytes, every message ...
export const MAX_HELLO = 4096;      // ... except hello (a Firebase ID token alone is ~1 KB)
export const MAX_ADMIN = 32768;     // ... and admin (map / item editors send whole documents); the socket's maxPayload matches
export const MODES_ALL = ['standard', 'hyper', '3d', 'deathmatch'];
export const INPUT_KINDS = ['turn', 'boost', 'jump', 'ability', 'swap'];

// Loadout (ability ids the client says it can use): unknown ids / duplicates are dropped, at most CFG.abilities.maxSlots kept. Always an array.
export function sanitizeLoadout(v) {
  const out = [];
  if (Array.isArray(v)) for (const id of v.slice(0, 16)) if (isAbilityId(id) && !out.includes(id) && out.length < CFG.abilities.maxSlots) out.push(id);
  return out;
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isUid = (v) => typeof v === 'string' && /^[\w-]{1,128}$/.test(v); // Firebase uids are <= 128 alphanumerics; dev uids <= 40 [\w-]

// Username search text: same charset as usernames (letters, digits, space, _ -), 2..12 chars after trimming. -> lowercase key prefix or null.
export function normalizeQuery(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const s = v.trim().replace(/\s+/g, ' ').toLowerCase();
  return /^[a-z0-9 _-]{2,12}$/.test(s) ? s : null;
}

// Returns { ok:true, msg } with a sanitized message, or { ok:false, code, message }.
export function parseClientMessage(raw) {
  const len = typeof raw === 'string' ? Buffer.byteLength(raw) : raw && raw.length;
  if (!len) return bad('bad_message', 'empty message');
  let o;
  try { o = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return bad('bad_json', 'invalid JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !isStr(o.t, 16)) return bad('bad_message', 'missing type');
  if (len > (o.t === 'hello' ? MAX_HELLO : o.t === 'admin' ? MAX_ADMIN : MAX_MSG)) return bad('too_large', 'message too large');
  switch (o.t) {
    case 'hello':
      if (o.dev === true) {
        if (!isStr(o.uid, 40) || !/^[\w-]{1,40}$/.test(o.uid) || !isStr(o.username, 40)) return bad('bad_message', 'bad dev hello');
        return ok({ t: 'hello', dev: true, uid: o.uid, username: o.username });
      }
      if (!isStr(o.token, MAX_HELLO) || !o.token) return bad('bad_message', 'missing token');
      return ok({ t: 'hello', token: o.token });
    case 'queue':
      if (!isStr(o.mode, 16) || !MODES_ALL.includes(o.mode)) return bad('bad_mode', 'unknown mode');
      return ok({ t: 'queue', mode: o.mode, ...(o.loadout !== undefined ? { loadout: sanitizeLoadout(o.loadout) } : {}) });
    case 'loadout': // ability ids for the next match (lobby / party) or the final list during the first countdown of a match
      return ok({ t: 'loadout', abilities: sanitizeLoadout(o.abilities) });
    case 'leaveQueue': case 'leave':
      return ok({ t: o.t });
    case 'in': {
      if (!isStr(o.kind, 8) || !INPUT_KINDS.includes(o.kind)) return bad('bad_message', 'bad input kind');
      const m = { t: 'in', kind: o.kind };
      if (o.kind === 'ability') { if (!isAbilityId(o.ability)) return bad('bad_message', 'bad ability'); m.ability = o.ability; }
      if (o.kind === 'turn') { if (o.side !== -1 && o.side !== 1) return bad('bad_message', 'bad turn side'); m.side = o.side; }
      if (o.ctick !== undefined && isNum(o.ctick)) m.ctick = o.ctick; // client tick when pressed: the server rewinds the bike to it (lag compensation, capped by CFG.net.maxRewindMs)
      return ok(m);
    }
    case 'fsearch': {
      const q = normalizeQuery(o.q);
      if (!q) return bad('bad_query', 'search needs 2-12 letters, numbers, space, _ or -');
      return ok({ t: 'fsearch', q });
    }
    case 'fadd': case 'faccept': case 'fdecline': case 'fcancel': case 'fremove':
      if (!isUid(o.uid)) return bad('bad_message', 'bad uid');
      return ok({ t: o.t, uid: o.uid });
    case 'flist':
      return ok({ t: 'flist' });
    case 'pinvite': case 'paccept': case 'pdecline': case 'pkick': case 'ptransfer': // party intents (server/party.js)
      if (!isUid(o.uid)) return bad('bad_message', 'bad uid');
      return ok({ t: o.t, uid: o.uid });
    case 'pleave': case 'plist':
      return ok({ t: o.t });
    case 'frefresh': // after a username change; `username` is only honoured in dev-auth mode (index.js)
      return ok(isStr(o.username, 40) ? { t: 'frefresh', username: o.username } : { t: 'frefresh' });
    case 'admin': { // admin console (server/admin.js): the router re-checks admin rights; args are validated by each op
      if (!isStr(o.op, 32) || !/^[A-Za-z]\w*$/.test(o.op)) return bad('bad_message', 'bad admin op');
      if (o.a !== undefined && (!o.a || typeof o.a !== 'object' || Array.isArray(o.a))) return bad('bad_message', 'bad admin args');
      if (o.id !== undefined && !(isNum(o.id) || isStr(o.id, 16))) return bad('bad_message', 'bad admin id');
      return ok({ t: 'admin', op: o.op, ...(o.id !== undefined ? { id: o.id } : {}), a: o.a || {} });
    }
    case 'ping':
      if (!(isNum(o.c) || isStr(o.c, 32))) return bad('bad_message', 'bad ping');
      return ok({ t: 'ping', c: o.c });
    default:
      return bad('unknown_type', 'unknown message type');
  }
}
const ok = (msg) => ({ ok: true, msg });
const bad = (code, message) => ({ ok: false, code, message });

// Token bucket: `rate` tokens/s, up to `burst`. take() -> true when allowed.
export class RateLimiter {
  constructor(rate, burst, now = () => Date.now()) { this.rate = rate; this.burst = burst; this.now = now; this.tokens = burst; this.last = now(); }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.last) * this.rate / 1000); this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
}
