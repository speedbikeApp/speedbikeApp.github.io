// Web push (contract: tasks/push-contract.md). Subscriptions + sent-markers live in a push store:
//   JSON keys `subs` {hash: sub}, `marks` {key: ms}; Firestore `push_subs/{sha256(endpoint)}` and `push_marks/{sha256(key)}` {key, at}. Admin SDK only (no client rules).
// Store interface (async): subs() -> [sub], putSub(sub), delSub(id), hasMark(k), putMark(k), flush().
// VAPID keys come only from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT); missing = push off, nothing crashes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WindowLimiter, clientIp, originAllowed } from './login.js';
import { adminError as E } from './admin.js';

const H = 3600e3, DAY = 24 * H, INACTIVE_MS = 3 * DAY, MAX_BODY = 2048;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const B64 = /^[A-Za-z0-9_-]{1,256}={0,2}$/;
export const REMINDERS = [
  ['Your bikes are getting rusty', 'The garage is gathering dust. Hop back in and burn some rubber!'],
  ['The arena misses you', 'Your rivals keep climbing the ranks. Time to take your spot back!'],
  ['Rust never sleeps', 'Your bike has been parked for days. One quick match to shake it off?'],
  ['Your bike is getting restless', 'The engine wants to roar again. Come race!'],
  ['Still the fastest?', 'The arena is waiting and your trail is fading. Show them you are back!'],
];

export function createJsonPushStore(file) {
  let d = { subs: {}, marks: {} };
  if (file) { try { d = { subs: {}, marks: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') console.warn(`[push] could not read ${file} (${e.message}); starting empty`); } }
  let chain = Promise.resolve();
  const save = () => { if (file) chain = chain.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(d)); await fs.promises.rename(tmp, file);
  }).catch((e) => console.error('[push] save failed:', e.message)); };
  return {
    kind: 'json',
    async subs() { return structuredClone(Object.values(d.subs)); },
    async putSub(s) { d.subs[hash(s.endpoint)] = structuredClone(s); save(); },
    async delSub(id) { delete d.subs[id]; save(); },
    async hasMark(k) { return k in d.marks; },
    async putMark(k) { d.marks[k] = Date.now(); save(); },
    flush: () => chain,
  };
}

export function createFirestorePushStore(db) {
  const subs = db.collection('push_subs'), marks = db.collection('push_marks');
  return {
    kind: 'firestore',
    async subs() { return (await subs.get()).docs.map((x) => x.data()); },
    async putSub(s) { await subs.doc(hash(s.endpoint)).set(s); },
    async delSub(id) { await subs.doc(id).delete(); },
    async hasMark(k) { return (await marks.doc(hash(k)).get()).exists; },
    async putMark(k) { await marks.doc(hash(k)).set({ key: k, at: Date.now() }); },
    flush: async () => {},
  };
}

/** sender(sub, payloadString) rejects with {statusCode} on failure; default = web-push (loaded lazily). */
export function createPush({ store, catalog, vapid, sender, log = () => {}, allowedOrigins = [], production = false, now = () => Date.now() }) {
  const v = vapid || { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT };
  const configured = !!(v.publicKey && v.privateKey && v.subject);
  let wp = null;
  const send = sender || (async (sub, payload) => {
    wp ||= (await import('web-push')).default;
    await wp.sendNotification(sub, payload, { TTL: 86400, vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey } });
  });
  const subLimit = new WindowLimiter(20, 60000), tickLimit = new WindowLimiter(1, 30000);

  /** Sends one payload to a sub; deletes it on 404/410. -> true when sent. */
  async function sendTo(sub, title, body) {
    try { await send({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ title, body, url: '/' })); return true; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await store.delSub(hash(sub.endpoint)); else log('[push] send failed:', (e && e.statusCode) || (e && e.message)); return false; }
  }
  async function broadcast(title, body) {
    let sent = 0, failed = 0;
    for (const s of await store.subs()) (await sendTo(s, title, body)) ? sent++ : failed++;
    return { sent, failed };
  }

  async function tick() {
    if (!configured) return 0;
    const t = now(); let sent = 0;
    for (const e of await catalog.getEvents()) {
      for (const [kind, due, text] of [['start', e.start - H <= t && t < e.start, `${e.title} starts in 1 hour!`], ['end', e.start <= t && e.end - H <= t && t < e.end, `${e.title}: 1 hour left!`]]) {
        const k = `${kind}:${e.id}`;
        if (!due || await store.hasMark(k)) continue;
        await store.putMark(k); // mark first: a crash must not double-notify everyone
        sent += (await broadcast(e.title, text)).sent;
      }
    }
    for (const s of await store.subs()) {
      if (s.reminded || t - s.lastSeen < INACTIVE_MS) continue;
      const [title, body] = REMINDERS[Math.floor(Math.random() * REMINDERS.length)];
      await store.putSub({ ...s, reminded: true });
      if (await sendTo(s, title, body)) sent++;
    }
    return sent;
  }

  async function handler(req, res) {
    const origin = req.headers.origin, h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (origin && originAllowed(origin, allowedOrigins, production)) h['Access-Control-Allow-Origin'] = origin;
    const out = (code, o) => { res.writeHead(code, h); res.end(code === 204 ? undefined : JSON.stringify(o)); };
    const p = req.url.split('?')[0];
    if (req.method === 'OPTIONS') return out(204);
    if (p === '/push/key' && req.method === 'GET') return out(200, { key: configured ? v.publicKey : null });
    if (req.method !== 'POST') return out(405, { ok: false });
    const ip = clientIp(req);
    if (p === '/push/tick') {
      if (!tickLimit.hit(ip).ok) return out(429, { ok: false, code: 'rate_limited' });
      try { return out(200, { ok: true, sent: await tick() }); } catch (e) { log('[push] tick failed:', e.message); return out(503, { ok: false }); }
    }
    if (p !== '/push/sub' && p !== '/push/unsub') return out(404, { ok: false });
    if (!subLimit.hit(ip).ok) return out(429, { ok: false, code: 'rate_limited' });
    let raw = '', size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return out(413, { ok: false, code: 'too_large' }); raw += c; }
    let b; try { b = JSON.parse(raw); } catch { return out(400, { ok: false, code: 'bad_json' }); }
    try {
      if (p === '/push/unsub') {
        if (typeof b?.endpoint !== 'string' || b.endpoint.length > 1024) return out(400, { ok: false, code: 'bad_endpoint' });
        await store.delSub(hash(b.endpoint)); return out(200, { ok: true });
      }
      const s = b?.sub;
      if (typeof s?.endpoint !== 'string' || s.endpoint.length > 1024 || !s.endpoint.startsWith('https://')) return out(400, { ok: false, code: 'bad_endpoint' });
      if (![s.keys?.p256dh, s.keys?.auth].every((x) => typeof x === 'string' && B64.test(x))) return out(400, { ok: false, code: 'bad_keys' });
      await store.putSub({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, lastSeen: now(), reminded: false });
      return out(200, { ok: true });
    } catch (e) { log('[push] failed:', e.message); return out(503, { ok: false, code: 'unavailable' }); }
  }

  return { handler, tick, configured, broadcast, store };
}

export function registerPushOps({ admin, push, log = () => {} }) {
  admin.register('pushsend', async (a, ctx) => {
    const kind = a?.kind;
    if (kind !== 'custom' && kind !== 'update') throw E('bad_kind');
    let title = typeof a.title === 'string' ? a.title.trim() : '', body = typeof a.body === 'string' ? a.body.trim() : '';
    if (kind === 'update') { title ||= 'HUGE UPDATE!'; body ||= 'A huge update just dropped. Come check it out!'; }
    if (title.length < 1 || title.length > 60) throw E('bad_title');
    if (body.length < 1 || body.length > 200) throw E('bad_body');
    if (!push.configured) throw E('not_configured');
    const r = await push.broadcast(title, body); log(`[admin] ${ctx.uid} pushsend ${kind}: ${r.sent} sent, ${r.failed} failed`);
    return { sent: r.sent, failed: r.failed };
  });
  admin.register('pushstats', async () => ({ subs: (await push.store.subs()).length, configured: push.configured }));
}
