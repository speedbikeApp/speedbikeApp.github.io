import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const A = await import('../js/auth.js');
const fresh = async () => { mem.clear(); await A.init({ backend: 'mock' }); };
const rejects = async (p, code) => { try { await p; } catch (e) { assert.equal(e.code, code, e.message); assert.ok(e.message); return; } assert.fail('expected rejection ' + code); };

{ // no backend / unconfigured firebase: offline, clear error
  await A.init({ backend: 'firebase', config: { apiKey: 'YOUR_API_KEY', authDomain: '', projectId: '', appId: '' } }); // real config is set now; test the placeholder path
  assert.equal(A.status().configured, false);
  await rejects(A.login('a@b.co', 'password1'), 'unconfigured');
  assert.equal(A.currentUser(), null);
}
await fresh();
assert.equal(A.status().mode, 'mock');
{ // register + auth events
  const seen = []; const off = A.onAuthChange((u) => seen.push(u && u.username));
  const u = await A.register('Ann@Example.com ', 'hunter2hunter2', 'Ann_1');
  assert.equal(u.username, 'Ann_1'); assert.equal(u.email, 'Ann@Example.com'); assert.deepEqual(A.currentUser(), u);
  assert.deepEqual(seen, [null, 'Ann_1']);
  await A.logout(); assert.equal(A.currentUser(), null); assert.deepEqual(seen, [null, 'Ann_1', null]); off();
}
{ // duplicate username (case-insensitive) and duplicate email
  await rejects(A.register('b@example.com', 'password123', 'ANN_1'), 'username-taken');
  await rejects(A.register('b@example.com', 'password123', 'ann_1'), 'username-taken');
  await rejects(A.register('ann@example.com', 'password123', 'Other'), 'email-in-use');
  assert.equal(A.currentUser(), null);
}
{ // login: wrong password / unknown email rejected, right one works (email case-insensitive)
  await rejects(A.login('ann@example.com', 'wrongwrong'), 'invalid-credential');
  await rejects(A.login('nobody@example.com', 'hunter2hunter2'), 'invalid-credential');
  assert.equal(A.currentUser(), null);
  const u = await A.login('ann@example.com', 'hunter2hunter2'); assert.equal(u.username, 'Ann_1');
}
{ // change username frees old name, rejects taken, allows case change
  await A.logout(); await A.register('bob@example.com', 'password123', 'Bob');
  await rejects(A.changeUsername('ann_1'), 'username-taken');
  await A.changeUsername('Bobby');
  assert.equal(A.currentUser().username, 'Bobby');
  await A.logout();
  await A.register('c@example.com', 'password123', 'bob'); // old name is free again
  await A.logout(); await A.login('ann@example.com', 'hunter2hunter2');
  await A.changeUsername('ANN_1'); assert.equal(A.currentUser().username, 'ANN_1'); // case-only change of own name
  await rejects(A.changeUsername('ab'), 'invalid-username');
}
{ // change password needs the right current password
  await rejects(A.changePassword('nope-nope', 'newpassword1'), 'wrong-password');
  await rejects(A.changePassword('hunter2hunter2', 'short'), 'weak-password');
  await A.changePassword('hunter2hunter2', 'newpassword1');
  await A.logout();
  await rejects(A.login('ann@example.com', 'hunter2hunter2'), 'invalid-credential');
  await A.login('ann@example.com', 'newpassword1');
}
{ // session survives re-init (reload); signed-out calls rejected
  await A.init({ backend: 'mock' });
  assert.equal(A.currentUser().username, 'ANN_1');
  await A.logout();
  await rejects(A.changeUsername('Whatever'), 'not-signed-in');
  await rejects(A.deleteAccount('x'), 'not-signed-in');
}
{ // delete account removes user + username
  await A.login('ann@example.com', 'newpassword1');
  await rejects(A.deleteAccount('wrongwrong'), 'wrong-password');
  assert.ok(A.currentUser());
  await A.deleteAccount('newpassword1');
  assert.equal(A.currentUser(), null);
  const d = A._mockDump();
  assert.ok(!Object.values(d.users).some((u) => u.email === 'ann@example.com'));
  assert.ok(!('ann_1' in d.names));
  await rejects(A.login('ann@example.com', 'newpassword1'), 'invalid-credential');
  await A.register('new@example.com', 'password123', 'Ann_1'); // name reusable
}
{ // validation
  await A.logout();
  await rejects(A.register('a@b.co', 'short', 'Name'), 'weak-password');
  await rejects(A.register('not-an-email', 'password123', 'Name'), 'invalid-email');
  await rejects(A.register('v@b.co', 'password123', 'ab'), 'invalid-username');
  await rejects(A.register('v@b.co', 'password123', 'bad<name>'), 'invalid-username');
  await rejects(A.register('v@b.co', 'password123', 'x'.repeat(13)), 'invalid-username');
  await rejects(A.login('bad@', 'x'), 'invalid-email'); // '@' = email path
  await rejects(A.login('bad', 'x'), 'invalid-login');   // no '@' = username path
  await rejects(A.forgotPassword('bad@'), 'invalid-email');
  await A.forgotPassword('anyone@example.com'); await A.forgotPassword('some_user');
  await rejects(A.forgotUsername('bad'), 'invalid-email'); await A.forgotUsername('anyone@example.com');
  assert.equal(A.validateUsername('  Good  Name '), '');
  assert.notEqual(A.validateUsername(''), ''); assert.notEqual(A.validateUsername('a b!'), '');
  assert.equal(A.validatePassword('12345678'), ''); assert.notEqual(A.validatePassword('1234567'), '');
  assert.equal(A.validateEmail('a@b.co'), ''); assert.notEqual(A.validateEmail('a@b'), ''); assert.notEqual(A.validateEmail(''), '');
}
{ // firebase error mapping (friendly, never raw)
  assert.equal(A.mapFirebaseError({ code: 'auth/email-already-in-use' }).code, 'email-in-use');
  assert.equal(A.mapFirebaseError({ code: 'auth/invalid-credential' }, true).code, 'wrong-password');
  assert.equal(A.mapFirebaseError({ code: 'auth/invalid-credential' }).code, 'invalid-credential');
  assert.equal(A.mapFirebaseError({ code: 'auth/network-request-failed' }).code, 'unavailable');
  assert.equal(A.mapFirebaseError({ code: 'weird', message: 'raw internal' }).message, 'Something went wrong. Try again');
}
{ // username login (mock backend): case-insensitive, generic errors, '@' routes to the email path
  await fresh();
  await A.register('Zed@Example.com', 'zedzedzed1', 'Zed_9'); await A.logout();
  let u = await A.login('zed_9', 'zedzedzed1'); assert.equal(u.username, 'Zed_9'); await A.logout();
  u = await A.login('  ZED_9 ', 'zedzedzed1'); assert.equal(u.username, 'Zed_9'); await A.logout();
  u = await A.login('zed@example.com', 'zedzedzed1'); assert.equal(u.username, 'Zed_9'); await A.logout(); // email still works
  const msgs = new Set();
  for (const [id, pw] of [['zed_9', 'wrongwrong'], ['nobody1', 'zedzedzed1'], ['ab', 'zedzedzed1'], ['bad<name>', 'zedzedzed1'], ['x'.repeat(13), 'zedzedzed1'], ['zed_9', '']]) {
    try { await A.login(id, pw); assert.fail('should reject'); } catch (e) { assert.equal(e.code, 'invalid-login'); msgs.add(e.message); }
  }
  assert.deepEqual([...msgs], ['Wrong username or password']); // unknown user / wrong password / malformed all identical
  assert.equal(A.currentUser(), null);
  await rejects(A.login('zed_9@example.com', 'zedzedzed1'), 'invalid-credential'); // has '@': treated as an email, never as a username
  await rejects(A.login('not an email@', 'zedzedzed1'), 'invalid-email');
  await A.login('zed_9', 'zedzedzed1'); await A.changeUsername('Zed_10'); await A.logout();
  await rejects(A.login('zed_9', 'zedzedzed1'), 'invalid-login'); // old name released
  assert.equal((await A.login('zed_10', 'zedzedzed1')).username, 'Zed_10');
}
{ // server URL derivation (ws -> http, wss -> https, fixed path)
  assert.equal(A.loginServerUrl('ws://localhost:8787'), 'http://localhost:8787/auth/login');
  assert.equal(A.loginServerUrl('wss://speedbike-server.onrender.com'), 'https://speedbike-server.onrender.com/auth/login');
  assert.equal(A.loginServerUrl('wss://host.example/some/path/?x=1#h'), 'https://host.example/auth/login');
  assert.equal(A.loginServerUrl('http://nope'), ''); assert.equal(A.loginServerUrl('garbage'), '');
  assert.equal(A.loginServerUrl(), 'wss://speedbike-server.onrender.com'.replace('wss', 'https') + '/auth/login'); // default = CFG.net.url (not localhost in node)
  assert.equal(A.isEmailIdentifier('a@b'), true); assert.equal(A.isEmailIdentifier('abc'), false);
}
{ // fetchLoginToken: statuses, retry while the server wakes up, give-up, no waiting when the server says "unavailable"
  const res = (status, body, headers = {}) => ({ status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  const clock = { t: 0 }, deps = (fetchFn, extra = {}) => ({ fetch: fetchFn, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, ...extra });
  let sent = null;
  assert.equal(await A.fetchLoginToken('http://x/auth/login', 'Ann', 'pw', deps(async (url, init) => { sent = { url, init }; return res(200, { ok: true, token: 'T' }); })), 'T');
  assert.equal(sent.init.method, 'POST'); assert.deepEqual(JSON.parse(sent.init.body), { username: 'Ann', password: 'pw' });
  assert.equal(sent.init.headers['Content-Type'], 'application/json'); assert.equal(sent.init.credentials, 'omit');
  await rejects(A.fetchLoginToken('u', 'a', 'b', deps(async () => res(401, { ok: false, code: 'invalid_credentials' }))), 'invalid-login');
  try { await A.fetchLoginToken('u', 'a', 'b', deps(async () => res(429, { code: 'rate_limited', retryAfter: 130 }))); assert.fail('429'); } catch (e) { assert.equal(e.code, 'rate-limited'); assert.equal(e.message, 'Too many attempts, try again in 3 min'); }
  { // asleep: network errors and a 503 HTML page, then it answers; onStatus fires once
    let n = 0, waking = 0; clock.t = 0;
    const tok = await A.fetchLoginToken('u', 'a', 'b', deps(async () => { n++; if (n === 1) throw new TypeError('Failed to fetch'); if (n === 2) return { status: 503, json: async () => { throw new Error('html'); }, headers: { get: () => null } }; if (n === 3) return res(502, null); return res(200, { ok: true, token: 'LATE' }); }, { onStatus: (s) => { if (s === 'waking') waking++; } }));
    assert.equal(tok, 'LATE'); assert.equal(n, 4); assert.equal(waking, 1);
  }
  { // never wakes: gives up after ~60 s with the "try your email" message
    let n = 0; clock.t = 0;
    try { await A.fetchLoginToken('u', 'a', 'b', deps(async () => { n++; throw new TypeError('Failed to fetch'); })); assert.fail('gave up'); } catch (e) { assert.equal(e.code, 'login-unavailable'); assert.match(e.message, /try logging in with your email/); }
    assert.ok(clock.t >= 60000 && clock.t < 70000 && n > 10, `t=${clock.t} n=${n}`);
  }
  { // server in dev-auth mode answers {code:'unavailable'}: fail at once, no 60 s wait
    let n = 0; clock.t = 0;
    await rejects(A.fetchLoginToken('u', 'a', 'b', deps(async () => { n++; return res(503, { ok: false, code: 'unavailable' }); })), 'login-unavailable');
    assert.equal(n, 1); assert.equal(clock.t, 0);
  }
  await rejects(A.fetchLoginToken('', 'a', 'b', deps(async () => res(200, { ok: true, token: 'x' }))), 'login-unavailable');
}
{ // e-mail sign-up (mock): start -> verify (account without username) -> choose username; reset token helpers
  await fresh();
  await rejects(A.signupStart('bad', 'password123'), 'invalid-email'); await rejects(A.signupStart('n@b.co', 'short'), 'weak-password');
  await A.register('taken@example.com', 'password123', 'Taken'); await A.logout();
  await rejects(A.signupStart('TAKEN@example.com', 'password123'), 'email-in-use');
  assert.equal((await A.signupStart('new@example.com', 'password123')).resendIn, 60);
  await rejects(A.signupVerify('new@example.com', 'password123', '12ab'), 'code-invalid');
  await rejects(A.signupVerify('new@example.com', 'password123', '000000'), 'code-invalid');
  await rejects(A.signupVerify('other@example.com', 'password123', '123456'), 'code-expired');
  assert.equal(A.currentUser(), null);
  const u = await A.signupVerify('new@example.com', 'password123', '123456');
  assert.equal(u.username, ''); assert.equal(u.email, 'new@example.com');
  await rejects(A.chooseUsername('ab'), 'invalid-username'); await rejects(A.chooseUsername('taken'), 'username-taken');
  assert.equal((await A.chooseUsername(' Fresh  One ')).username, 'Fresh One');
  await A.logout(); assert.equal((await A.login('fresh one', 'password123')).email, 'new@example.com');
  await rejects(A.resetPassword('x'.repeat(43), 'newpassword1'), 'invalid-token'); await rejects(A.resetPassword('short', 'newpassword1'), 'invalid-token'); await rejects(A.resetPassword('x'.repeat(43), 'short'), 'weak-password');
  const tok = 'abcdefghij0123456789ABCDEFGHIJ_-abcdefghijk'; assert.equal(tok.length, 43);
  assert.equal(A.resetTokenOf('?a=1&reset=' + tok), tok); assert.equal(A.resetTokenOf('?reset=abc'), ''); assert.equal(A.resetTokenOf(''), '');
  assert.equal(A.authServerUrl('/auth/reset', 'wss://h.example'), 'https://h.example/auth/reset');
}
{ // callAuth: success, friendly server errors, cooldown / attempts, waking retry, no wait when unavailable
  const res = (status, body, headers = {}) => ({ status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  const clock = { t: 0 }, deps = (f, extra = {}) => ({ fetch: f, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, ...extra });
  let sent; assert.deepEqual(await A.callAuth('http://x/a', { email: 'e' }, deps(async (u, i) => { sent = i; return res(200, { ok: true, resendIn: 60 }); })), { ok: true, resendIn: 60 });
  assert.deepEqual(JSON.parse(sent.body), { email: 'e' }); assert.equal(sent.credentials, 'omit');
  const err = async (status, body) => { try { await A.callAuth('u', {}, deps(async () => res(status, body))); } catch (e) { return e; } assert.fail('no error'); };
  let e = await err(409, { ok: false, code: 'email_in_use' }); assert.equal(e.code, 'email-in-use');
  e = await err(400, { ok: false, code: 'code_invalid', attemptsLeft: 1 }); assert.equal(e.code, 'code-invalid'); assert.equal(e.message, 'That code is not right (1 try left)');
  assert.equal((await err(400, { ok: false, code: 'code_voided' })).code, 'code-voided'); assert.equal((await err(403, { ok: false, code: 'ip_mismatch' })).message, 'Open the link on the same network/device you requested it from');
  e = await err(429, { ok: false, code: 'cooldown', retryAfter: 42 }); assert.equal(e.retryAfter, 42); assert.match(e.message, /42 s/);
  e = await err(429, { ok: false, code: 'rate_limited', retryAfter: 600 }); assert.equal(e.code, 'rate-limited'); assert.match(e.message, /10 min/);
  assert.equal((await err(400, { ok: false, code: 'something_new' })).message, 'Something went wrong. Try again'); // never raw
  assert.equal((await err(503, { ok: false, code: 'unavailable' })).code, 'login-unavailable');
  let n = 0; clock.t = 0; await A.callAuth('u', {}, deps(async () => { n++; if (n === 1) throw new TypeError('x'); if (n === 2) return res(502, null); return res(200, { ok: true }); }));
  assert.equal(n, 3);
  clock.t = 0; await rejects(A.callAuth('u', {}, deps(async () => { throw new TypeError('x'); })), 'login-unavailable'); assert.ok(clock.t >= 60000);
}
console.log('auth tests ok');
