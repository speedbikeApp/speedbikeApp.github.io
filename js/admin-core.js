// Admin client core (pure: no DOM, no socket). The server is the only authority (server/admin.js); everything here is cosmetic / plumbing.
//   isAdmin() / onAdminChange(fn)   - whether the server said we are an admin (welcome.admin, `adminstate`)
//   registerAdminTab(id, label, mount) - add a tab to the ADMIN page (admin-ui.js). mount(container, { call, toast }) runs every time the tab is opened on an
//        EMPTY container; it may return a cleanup function. Registering an existing id replaces it (keeps its place). `call(op, args)` -> Promise<{ok, ...result}|{ok:false, code}>.
//   createCaller(send) - request/response over the socket: { call(op, args), resolve(msg) } (online.js feeds it `ares` messages)
let admin = false;
const listeners = new Set(), tabs = new Map();
export const isAdmin = () => admin;
export function setAdmin(v) { v = v === true; if (v === admin) return; admin = v; for (const fn of [...listeners]) { try { fn(admin); } catch { /* ui bug must not break the socket */ } } }
export function onAdminChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const ORDER = ['players', 'maps', 'garage'];
export function registerAdminTab(id, label, mount) { tabs.set(id, { id, label, mount }); }
export const hasAdminTab = (id) => tabs.has(id);
/** Tabs in display order: players, maps, garage, then any others in registration order. */
export const adminTabs = () => [...tabs.values()].sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));

export function createCaller(send, { timeoutMs = 15000, setT = setTimeout, clearT = clearTimeout } = {}) {
  let n = 0; const pend = new Map();
  return {
    call(op, a = {}) {
      return new Promise((resolve) => {
        const id = ++n;
        if (!send({ t: 'admin', op, id, a })) return resolve({ ok: false, code: 'offline' });
        pend.set(id, { resolve, timer: setT(() => { pend.delete(id); resolve({ ok: false, code: 'timeout' }); }, timeoutMs) });
      });
    },
    resolve(m) { const p = m && pend.get(m.id); if (!p) return; pend.delete(m.id); clearT(p.timer); p.resolve(m); },
  };
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** Text for a server `banned` message / 403 login body {until, permanent, reason}. */
export function banMessage(m) {
  const base = m && m.permanent ? 'You are banned permanently' : m && m.until ? `You are banned until ${fmtTime(m.until)}` : 'You are banned';
  return m && m.reason ? `${base} (${m.reason})` : base;
}

/** Error text for a failed admin response code. */
export const ADMIN_ERR = {
  forbidden: 'NOT AN ADMIN', unknown_op: 'UNKNOWN ACTION', unavailable: 'SERVER ERROR - TRY AGAIN', offline: 'NOT CONNECTED', timeout: 'NO ANSWER FROM SERVER', not_found: 'PLAYER NOT FOUND',
  bad_query: 'USE 2-12 LETTERS OR NUMBERS', bad_uid: 'BAD PLAYER', protected: 'NOT ALLOWED FOR THIS ACCOUNT', bad_minutes: 'ENTER MINUTES (1 OR MORE)', bad_name: 'NAME: 3-12 LETTERS, NUMBERS, SPACE _ -',
  taken: 'NAME ALREADY TAKEN', bad_value: 'INVALID NUMBER', confirm_mismatch: 'TYPED NAME DOES NOT MATCH',
};
