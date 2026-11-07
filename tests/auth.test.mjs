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
  await rejects(A.login('bad', 'x'), 'invalid-email');
  await rejects(A.resetPassword('bad'), 'invalid-email');
  await A.resetPassword('anyone@example.com');
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
console.log('auth tests ok');
