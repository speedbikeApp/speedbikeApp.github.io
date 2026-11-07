// POST /auth/login: handler behaviour with injected fakes over a real local http server (no Firebase, no internet).
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLoginHandler, createRestVerifier, createFirebaseLoginDeps, usernameKey, clientIp, WindowLimiter, MAX_BODY } from '../login.js';

const SECRET_EMAIL = 'secret.person@example.com';
function setup(over = {}) {
  const clock = { t: 1_000_000 }, calls = { lookup: 0, verify: 0, token: 0, sleeps: [] };
  const deps = {
    enabled: true, allowedOrigins: ['https://speedbikeapp.github.io'], production: true,
    now: () => clock.t, sleep: async (ms) => { calls.sleeps.push(ms); clock.t += ms; },
    lookup: async (key) => { calls.lookup++; return key === 'ann_1' ? { uid: 'uid-ann', email: SECRET_EMAIL } : null; },
    verifyPassword: async (email, pw) => { calls.verify++; assert.equal(email, SECRET_EMAIL); return pw === 'hunter2hunter2' ? { ok: true } : pw === 'locked-out' ? { ok: false, code: 'too_many' } : { ok: false, code: 'invalid' }; },
    createToken: async (uid) => { calls.token++; return 'custom-token-for-' + uid; },
    ...over,
  };
  const handler = createLoginHandler(deps);
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server, clock, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}
async function post(s, body, { headers = {}, method = 'POST', raw } = {}) {
  const r = await fetch(`http://127.0.0.1:${s.port}/auth/login`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text, headers: r.headers };
}
let n = 0; const ip = () => ({ 'x-forwarded-for': `10.0.${Math.floor(++n / 250)}.${n % 250}` }); // fresh client IP per call unless a test pins one

{ // success: custom token, no email / REST tokens anywhere in the response
  const s = await setup();
  const r = await post(s, { username: '  ann_1 ', password: 'hunter2hunter2' }, { headers: ip() });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, token: 'custom-token-for-uid-ann' });
  assert.ok(!r.text.includes(SECRET_EMAIL) && !r.text.includes('@'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await post(s, { username: 'ANN_1', password: 'hunter2hunter2' }, { headers: ip() })).status, 200); // case-insensitive
  assert.equal(s.calls.token, 2);
  await s.close();
}
{ // unknown username and wrong password are indistinguishable (body, status, padded delay); malformed names too
  const s = await setup({ minFailMs: 700 });
  const a = await post(s, { username: 'nobody', password: 'whatever12' }, { headers: ip() });
  const b = await post(s, { username: 'ann_1', password: 'wrongwrong' }, { headers: ip() });
  const c = await post(s, { username: 'a<b>', password: 'whatever12' }, { headers: ip() });
  const d = await post(s, { username: 'ann_1', password: '' }, { headers: ip() });
  for (const r of [a, b, c, d]) { assert.equal(r.status, 401); assert.equal(r.text, '{"ok":false,"code":"invalid_credentials"}'); }
  assert.equal(a.text, b.text);
  assert.equal(s.calls.sleeps.length, 4); assert.ok(s.calls.sleeps.every((ms) => ms > 0 && ms <= 700)); // each failure was padded to the floor
  assert.equal(s.calls.verify, 1); // only the real wrong-password attempt reached the password check
  assert.equal(s.calls.token, 0);
  await s.close();
}
{ // padding is relative to elapsed time: a slow failure sleeps less, a fast one more
  let slow = false;
  const s = await setup({ lookup: async () => { if (slow) s.clock.t += 500; return null; } });
  await post(s, { username: 'nobody', password: 'pw' }, { headers: ip() }); slow = true;
  await post(s, { username: 'nobody', password: 'pw' }, { headers: ip() });
  assert.deepEqual(s.calls.sleeps, [700, 200]);
  await s.close();
}
{ // TOO_MANY_ATTEMPTS from Firebase -> 429; backend failures -> 503 (never a 200 / token)
  const s = await setup();
  const r = await post(s, { username: 'ann_1', password: 'locked-out' }, { headers: ip() });
  assert.equal(r.status, 429); assert.equal(r.json.code, 'rate_limited'); assert.ok(r.json.retryAfter > 0); assert.ok(!r.text.includes(SECRET_EMAIL));
  await s.close();
  const s2 = await setup({ lookup: async () => { throw new Error('firestore down'); } });
  const r2 = await post(s2, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: ip() });
  assert.equal(r2.status, 503); assert.equal(r2.json.code, 'unavailable');
  await s2.close();
  const s3 = await setup({ createToken: async () => { throw new Error('sign failed'); } });
  assert.equal((await post(s3, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: ip() })).status, 503);
  await s3.close();
}
{ // per-IP limit (10 / 5 min), x-forwarded-for first hop, window expiry; other IPs unaffected
  const s = await setup();
  const A = { 'x-forwarded-for': '203.0.113.7, 10.1.1.1' };
  for (let i = 0; i < 10; i++) assert.equal((await post(s, { username: 'n' + 'x'.repeat(i + 3).slice(0, 8), password: 'pw' }, { headers: A })).status, 401);
  const blocked = await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: A });
  assert.equal(blocked.status, 429); assert.equal(blocked.json.code, 'rate_limited'); assert.ok(blocked.json.retryAfter >= 1 && blocked.json.retryAfter <= 300);
  assert.equal(blocked.headers.get('retry-after'), String(blocked.json.retryAfter));
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { 'x-forwarded-for': '203.0.113.8' } })).status, 200); // different IP
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { 'x-forwarded-for': '203.0.113.7, 99.9.9.9' } })).status, 429); // same first hop, other proxies behind it
  s.clock.t += 5 * 60 * 1000 + 1;
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: A })).status, 200);
  await s.close();
}
{ // per-username limit (10 / 15 min) across different IPs; case-insensitive key; other usernames unaffected
  const s = await setup();
  for (let i = 0; i < 10; i++) assert.equal((await post(s, { username: i % 2 ? 'ANN_1' : 'ann_1', password: 'bad-password' }, { headers: ip() })).status, 401);
  const r = await post(s, { username: 'Ann_1', password: 'hunter2hunter2' }, { headers: ip() });
  assert.equal(r.status, 429); assert.equal(r.json.code, 'rate_limited'); assert.ok(r.json.retryAfter > 0);
  assert.equal(s.calls.token, 0);
  assert.equal((await post(s, { username: 'other', password: 'x' }, { headers: ip() })).status, 401);
  s.clock.t += 15 * 60 * 1000 + 1;
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: ip() })).status, 200);
  await s.close();
}
{ // CORS: allowed origin echoed, disallowed 403 (no ACAO), preflight, localhost only outside production
  const s = await setup();
  const ok = await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { ...ip(), Origin: 'https://speedbikeapp.github.io' } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://speedbikeapp.github.io');
  for (const o of ['https://evil.example', 'http://localhost:8000', 'https://speedbikeapp.github.io.evil.com', 'null']) {
    const r = await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { ...ip(), Origin: o } });
    assert.equal(r.status, 403, o); assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  const pf = await fetch(`http://127.0.0.1:${s.port}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://speedbikeapp.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(pf.status, 204); assert.equal(pf.headers.get('access-control-allow-origin'), 'https://speedbikeapp.github.io');
  assert.match(pf.headers.get('access-control-allow-methods'), /POST/); assert.match(pf.headers.get('access-control-allow-headers'), /Content-Type/i);
  const pfBad = await fetch(`http://127.0.0.1:${s.port}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pfBad.status, 403); assert.equal(pfBad.headers.get('access-control-allow-origin'), null);
  assert.equal(s.calls.lookup, 1);
  await s.close();
  const dev = await setup({ production: false });
  const l = await post(dev, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { ...ip(), Origin: 'http://localhost:8000' } });
  assert.equal(l.status, 200); assert.equal(l.headers.get('access-control-allow-origin'), 'http://localhost:8000');
  assert.equal((await post(dev, { username: 'ann_1', password: 'x' }, { headers: { ...ip(), Origin: 'https://evil.example' } })).status, 403);
  await dev.close();
}
{ // method, content type, body size and shape
  const s = await setup();
  assert.equal((await post(s, null, { method: 'GET' })).status, 405);
  assert.equal((await post(s, null, { method: 'PUT', raw: '{}' })).status, 405);
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { ...ip(), 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { ...ip(), 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: { ...ip(), 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
  const big = await post(s, { username: 'ann_1', password: 'x'.repeat(MAX_BODY + 10) }, { headers: ip() });
  assert.equal(big.status, 413);
  for (const raw of ['not json', '[]', 'null', '"str"', '{}', '{"username":"a"}', '{"password":"x"}', '{"username":5,"password":"x"}', '{"username":"ann_1","password":{"$ne":1}}', JSON.stringify({ username: 'x'.repeat(65), password: 'p' })]) {
    const r = await post(s, null, { headers: ip(), raw }); assert.equal(r.status, 400, raw); assert.equal(r.json.code, 'bad_request');
  }
  const v0 = s.calls.verify;
  assert.equal((await post(s, { username: 'ann_1', password: 'x'.repeat(129) }, { headers: ip() })).status, 401); // over-long password: generic failure, no backend call
  assert.equal(s.calls.verify, v0);
  assert.equal((await post(s, { username: 'ann_1', password: 'hunter2hunter2', extra: 'y'.repeat(100) }, { headers: ip() })).status, 200); // extra fields are ignored
  await s.close();
}
{ // dev-auth mode (not enabled): 503 {code:'unavailable'}; the backend is never touched
  const s = await setup({ enabled: false });
  const r = await post(s, { username: 'ann_1', password: 'hunter2hunter2' }, { headers: ip() });
  assert.equal(r.status, 503); assert.deepEqual(r.json, { ok: false, code: 'unavailable' });
  assert.equal(s.calls.lookup + s.calls.verify + s.calls.token, 0);
  await s.close();
}
{ // helpers
  assert.equal(usernameKey('  Ann   B '), 'ann b'); assert.equal(usernameKey('ab'), ''); assert.equal(usernameKey('bad<name>'), ''); assert.equal(usernameKey(5), ''); assert.equal(usernameKey('x'.repeat(13)), '');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' }, socket: { remoteAddress: '9.9.9.9' } }), '1.2.3.4');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '<script>' }, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
  let t = 0; const w = new WindowLimiter(2, 1000, () => t, 3);
  assert.ok(w.hit('a').ok && w.hit('a').ok); assert.equal(w.hit('a').ok, false); t = 1001; assert.ok(w.hit('a').ok);
  w.hit('b'); w.hit('c'); assert.equal(w.hit('d').ok, false); // key cap reached -> fail closed
}
{ // REST verifier: request shape, token discard, error mapping (fake fetch)
  const seen = [];
  const mk = (status, body) => createRestVerifier({ apiKey: 'KEY&x', fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: status < 300, status, json: async () => body }; } });
  assert.deepEqual(await mk(200, { idToken: 'a', refreshToken: 'b', email: SECRET_EMAIL })(SECRET_EMAIL, 'pw'), { ok: true });
  assert.match(seen[0].url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:signInWithPassword\?key=KEY%26x$/);
  assert.deepEqual(JSON.parse(seen[0].init.body), { email: SECRET_EMAIL, password: 'pw', returnSecureToken: true });
  for (const m of ['INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'USER_DISABLED']) assert.deepEqual(await mk(400, { error: { message: m } })('e@x.co', 'pw'), { ok: false, code: 'invalid' });
  assert.deepEqual(await mk(400, { error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled' } })('e@x.co', 'pw'), { ok: false, code: 'too_many' });
  await assert.rejects(mk(400, { error: { message: 'API_KEY_INVALID' } })('e@x.co', 'pw'));
  await assert.rejects(mk(503, null)('e@x.co', 'pw'));
}
{ // firebase deps: lookup chain with fake Firestore/Admin; disabled and missing users give null
  const docs = { ann_1: { uid: 'u1' }, ghost: { uid: 'u2' }, off: { uid: 'u3' } };
  const users = { u1: { email: SECRET_EMAIL }, u3: { email: 'o@x.co', disabled: true } };
  const fb = {
    db: { collection: (c) => { assert.equal(c, 'usernames'); return { doc: (k) => ({ get: async () => ({ exists: k in docs, data: () => docs[k] }) }) }; } },
    auth: { getUser: async (uid) => { if (!users[uid]) { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; } return users[uid]; }, createCustomToken: async (uid) => 'tok-' + uid },
  };
  const d = createFirebaseLoginDeps(fb, {}, async () => { throw new Error('unused'); });
  assert.deepEqual(await d.lookup('ann_1'), { uid: 'u1', email: SECRET_EMAIL });
  assert.equal(await d.lookup('nobody'), null); assert.equal(await d.lookup('ghost'), null); assert.equal(await d.lookup('off'), null);
  assert.equal(await d.createToken('u1'), 'tok-u1');
}
console.log('login tests ok');
