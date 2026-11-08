// Sign-up codes, password reset links, username mail: handler over a real local http server with fake mailer / firebase deps / clock.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAccountsHandler } from '../accounts.js';

const ORIGIN = 'https://speedbikeapp.github.io';
function setup(over = {}) {
  const clock = { t: 1_000_000 }, mails = [], users = new Map([['ann@example.com', { uid: 'u-ann', username: 'Ann_1' }], ['nouser@example.com', { uid: 'u-nn', username: null }]]);
  const calls = { created: [], setPw: [], tokens: 0 };
  const deps = {
    userByEmail: async (e) => (users.has(e) ? { uid: users.get(e).uid, email: e } : null),
    userByName: async (k) => (k === 'ann_1' ? { uid: 'u-ann', email: 'ann@example.com' } : null),
    usernameOf: async (uid) => [...users.values()].find((u) => u.uid === uid)?.username ?? null,
    createUser: async (email, pw) => { calls.created.push({ email, pw }); users.set(email, { uid: 'u-' + email, username: null }); return 'u-' + email; },
    createToken: async (uid) => { calls.tokens++; return 'tok-' + uid; },
    setPassword: async (uid, pw) => { calls.setPw.push({ uid, pw }); },
  };
  const handler = createAccountsHandler({
    enabled: true, allowedOrigins: [ORIGIN], production: true, now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
    mailer: { send: async (m) => { mails.push(m); } }, deps, ...over,
  });
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, clock, mails, calls, users, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}
let n = 0;
const post = async (s, path, body, ip = `10.1.${Math.floor(++n / 250)}.${n % 250}`, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${s.port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, ...headers }, body: JSON.stringify(body) });
  const text = await r.text(); return { status: r.status, json: JSON.parse(text), text, headers: r.headers };
};
const codeOf = (m) => m.text.match(/code is (\d{6})/)[1];
const tokenOf = (m) => m.text.match(/reset=([\w-]{43})/)[1];
const PW = 'hunter2hunter2';
const tick = () => new Promise((r) => setTimeout(r, 20)); // background mail send

{ // signup happy path; account created only after the code
  const s = await setup();
  const a = await post(s, '/auth/signup/start', { email: ' New@Example.com ', password: PW });
  assert.equal(a.status, 200); assert.equal(a.json.resendIn, 60);
  assert.equal(s.mails.length, 1); assert.equal(s.mails[0].to, 'new@example.com'); assert.match(s.mails[0].subject, /verification/i);
  assert.ok(s.mails[0].html.includes(codeOf(s.mails[0])));
  assert.ok(!a.text.includes(codeOf(s.mails[0])));
  assert.equal(s.calls.created.length, 0);
  const v = await post(s, '/auth/signup/verify', { email: 'new@example.com', password: PW, code: codeOf(s.mails[0]) });
  assert.equal(v.status, 200); assert.deepEqual(v.json, { ok: true, token: 'tok-u-new@example.com' });
  assert.deepEqual(s.calls.created, [{ email: 'new@example.com', pw: PW }]);
  assert.equal((await post(s, '/auth/signup/verify', { email: 'new@example.com', password: PW, code: codeOf(s.mails[0]) })).json.code, 'code_expired'); // one-time
  await s.close();
}
{ // validation, existing email, resend cooldown, mail failure
  const s = await setup();
  assert.equal((await post(s, '/auth/signup/start', { email: 'nope', password: PW })).json.code, 'invalid_email');
  assert.equal((await post(s, '/auth/signup/start', { email: 'a@b.co', password: 'short' })).json.code, 'weak_password');
  const e = await post(s, '/auth/signup/start', { email: 'ANN@example.com', password: PW });
  assert.equal(e.status, 409); assert.equal(e.json.code, 'email_in_use'); assert.equal(s.mails.length, 0);
  assert.equal((await post(s, '/auth/signup/start', { email: 'c@d.co', password: PW })).status, 200);
  s.clock.t += 30_000;
  const c = await post(s, '/auth/signup/start', { email: 'c@d.co', password: PW });
  assert.equal(c.status, 429); assert.equal(c.json.code, 'cooldown'); assert.equal(c.json.retryAfter, 30); assert.equal(c.headers.get('retry-after'), '30');
  assert.equal(s.mails.length, 1);
  s.clock.t += 30_000;
  assert.equal((await post(s, '/auth/signup/start', { email: 'c@d.co', password: PW })).status, 200);
  assert.equal(s.mails.length, 2);
  const [old, fresh] = s.mails.map(codeOf);
  if (old !== fresh) assert.equal((await post(s, '/auth/signup/verify', { email: 'c@d.co', password: PW, code: old })).json.code, 'code_invalid'); // only the newest code works
  assert.equal((await post(s, '/auth/signup/verify', { email: 'c@d.co', password: PW, code: fresh })).status, 200);
  await s.close();
  const f = await setup({ mailer: { send: async () => { throw new Error('boom'); } } });
  assert.equal((await post(f, '/auth/signup/start', { email: 'c@d.co', password: PW })).json.code, 'mail_failed');
  assert.equal((await post(f, '/auth/signup/verify', { email: 'c@d.co', password: PW, code: '000000' })).json.code, 'code_expired'); // nothing pending
  await f.close();
}
{ // wrong codes: 5th wrong attempt voids the record, even the right code fails afterwards
  const s = await setup();
  await post(s, '/auth/signup/start', { email: 'w@x.co', password: PW });
  const good = codeOf(s.mails[0]), bad = good === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 4; i++) { const r = await post(s, '/auth/signup/verify', { email: 'w@x.co', password: PW, code: bad }); assert.equal(r.json.code, 'code_invalid'); assert.equal(r.json.attemptsLeft, 5 - i); }
  assert.equal((await post(s, '/auth/signup/verify', { email: 'w@x.co', password: PW, code: bad })).json.code, 'code_voided');
  assert.equal((await post(s, '/auth/signup/verify', { email: 'w@x.co', password: PW, code: good })).json.code, 'code_expired');
  assert.equal(s.calls.created.length, 0);
  await s.close();
}
{ // expired code (10 min); weak password at verify
  const s = await setup();
  await post(s, '/auth/signup/start', { email: 'e@x.co', password: PW });
  assert.equal((await post(s, '/auth/signup/verify', { email: 'e@x.co', password: 'short', code: codeOf(s.mails[0]) })).json.code, 'weak_password');
  s.clock.t += 10 * 60e3 + 1;
  assert.equal((await post(s, '/auth/signup/verify', { email: 'e@x.co', password: PW, code: codeOf(s.mails[0]) })).json.code, 'code_expired');
  assert.equal(s.calls.created.length, 0);
  await s.close();
}
{ // rate limits: per IP and per email
  const s = await setup();
  for (let i = 0; i < 8; i++) assert.equal((await post(s, '/auth/signup/start', { email: `r${i}@x.co`, password: PW }, '9.9.9.9')).status, 200);
  const r = await post(s, '/auth/signup/start', { email: 'r9@x.co', password: PW }, '9.9.9.9');
  assert.equal(r.status, 429); assert.equal(r.json.code, 'rate_limited'); assert.ok(r.json.retryAfter > 0);
  assert.equal((await post(s, '/auth/signup/start', { email: 'r9@x.co', password: PW }, '8.8.8.8')).status, 200); // other IP unaffected
  for (let i = 0; i < 5; i++) { s.clock.t += 61_000; assert.equal((await post(s, '/auth/signup/start', { email: 'many@x.co', password: PW })).status, 200); }
  s.clock.t += 61_000; // 6th send for this address within the hour is refused
  assert.equal((await post(s, '/auth/signup/start', { email: 'many@x.co', password: PW })).json.code, 'rate_limited');
  for (let i = 0; i < 20; i++) await post(s, '/auth/signup/verify', { email: 'z@x.co', password: PW, code: '1' }, '7.7.7.7');
  assert.equal((await post(s, '/auth/signup/verify', { email: 'z@x.co', password: PW, code: '1' }, '7.7.7.7')).status, 429);
  await s.close();
}
{ // forgot password: generic answers, timing floor, link, one token per account, one-time, IP bound
  const s = await setup();
  const unknown = await post(s, '/auth/forgot/password', { email: 'ghost@example.com' }, '5.5.5.5');
  const t0 = s.clock.t;
  const known = await post(s, '/auth/forgot/password', { email: 'ann@example.com' }, '5.5.5.5');
  assert.equal(s.clock.t - t0, 700); // floor applied (fake sleep advanced the clock)
  const byName = await post(s, '/auth/forgot/password', { email: 'ANN_1' }, '5.5.5.5');
  const noName = await post(s, '/auth/forgot/password', { email: 'nobody_1' }, '5.5.5.5');
  for (const r of [unknown, known, byName, noName]) assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(unknown.text, known.text);
  await tick();
  assert.equal(s.mails.length, 2); assert.equal(s.mails[0].to, 'ann@example.com');
  assert.match(s.mails[0].text, /https:\/\/speedbikeapp\.github\.io\/\?reset=/); assert.match(s.mails[0].text, /3 minutes/); assert.match(s.mails[0].text, /same network/);
  const [t1, t2] = s.mails.map(tokenOf); assert.notEqual(t1, t2);
  assert.equal((await post(s, '/auth/reset', { token: t1, password: 'newpassword1' }, '5.5.5.5')).json.code, 'invalid_token'); // replaced by the newer request
  const mm = await post(s, '/auth/reset', { token: t2, password: 'newpassword1' }, '6.6.6.6');
  assert.equal(mm.status, 403); assert.equal(mm.json.code, 'ip_mismatch'); assert.equal(s.calls.setPw.length, 0);
  assert.equal((await post(s, '/auth/reset', { token: t2, password: 'short' }, '5.5.5.5')).json.code, 'weak_password');
  assert.equal((await post(s, '/auth/reset', { token: 'x'.repeat(43), password: 'newpassword1' }, '5.5.5.5')).json.code, 'invalid_token');
  const ok = await post(s, '/auth/reset', { token: t2, password: 'newpassword1' }, '5.5.5.5');
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]); assert.deepEqual(s.calls.setPw, [{ uid: 'u-ann', pw: 'newpassword1' }]);
  assert.equal((await post(s, '/auth/reset', { token: t2, password: 'newpassword1' }, '5.5.5.5')).json.code, 'invalid_token'); // one-time
  await s.close();
}
{ // reset token expires after 3 minutes; mail failure stays generic; forgot limits
  const s = await setup();
  await post(s, '/auth/forgot/password', { email: 'ann@example.com' }, '5.5.5.5'); await tick();
  const t = tokenOf(s.mails[0]); s.clock.t += 3 * 60e3 + 1;
  assert.equal((await post(s, '/auth/reset', { token: t, password: 'newpassword1' }, '5.5.5.5')).json.code, 'invalid_token');
  await s.close();
  const f = await setup({ mailer: { send: async () => { throw new Error('boom'); } } });
  assert.equal((await post(f, '/auth/forgot/password', { email: 'ann@example.com' })).status, 200);
  await f.close();
  const h = await setup();
  for (let i = 0; i < 3; i++) assert.equal((await post(h, '/auth/forgot/password', { email: 'ann@example.com' })).status, 200);
  assert.equal((await post(h, '/auth/forgot/password', { email: 'ann@example.com' })).status, 429);
  assert.equal((await post(h, '/auth/forgot/username', { email: 'ann@example.com' })).status, 200); // separate bucket
  await h.close();
}
{ // forgot username
  const s = await setup();
  const k = await post(s, '/auth/forgot/username', { email: 'Ann@example.com' }, '4.4.4.4');
  const u = await post(s, '/auth/forgot/username', { email: 'ghost@example.com' }, '4.4.4.4');
  const nn = await post(s, '/auth/forgot/username', { email: 'nouser@example.com' }, '4.4.4.4');
  assert.equal(k.text, u.text); assert.equal(k.text, nn.text); await tick();
  assert.equal(s.mails.length, 1); assert.equal(s.mails[0].to, 'ann@example.com'); assert.match(s.mails[0].text, /username is: Ann_1\b/); assert.ok(s.mails[0].html.includes('<b>Ann_1</b>'));
  await s.close();
}
{ // http hygiene
  const s = await setup();
  const raw = (path, init) => fetch(`http://127.0.0.1:${s.port}${path}`, init);
  assert.equal((await raw('/auth/reset', { method: 'GET' })).status, 405);
  assert.equal((await raw('/auth/nothing', { method: 'POST' })).status, 404);
  assert.equal((await raw('/auth/reset', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post(s, '/auth/reset', { token: 'x' }, undefined, { Origin: 'https://evil.example' })).status, 403);
  const good = await post(s, '/auth/reset', { token: 'x' }, undefined, { Origin: ORIGIN });
  assert.equal(good.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await raw('/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await raw('/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1]' })).status, 400);
  await s.close();
  const d = await setup({ enabled: false });
  assert.equal((await post(d, '/auth/signup/start', { email: 'a@b.co', password: PW })).status, 503);
  await d.close();
}
console.log('accounts tests passed');
