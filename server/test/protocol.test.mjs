import assert from 'node:assert/strict';
import { parseClientMessage as parse, RateLimiter } from '../protocol.js';
import { sanitizeName, resolveAuthMode } from '../auth.js';

const J = JSON.stringify;
const okMsg = (o) => { const r = parse(J(o)); assert.ok(r.ok, J(r)); return r.msg; };
const bad = (o, code) => { const r = parse(typeof o === 'string' ? o : J(o)); assert.equal(r.ok, false, J(o)); if (code) assert.equal(r.code, code); };

// valid messages
assert.deepEqual(okMsg({ t: 'hello', dev: true, uid: 'u_1', username: 'Bob' }), { t: 'hello', dev: true, uid: 'u_1', username: 'Bob' });
assert.deepEqual(okMsg({ t: 'hello', token: 'abc.def' }), { t: 'hello', token: 'abc.def' });
assert.deepEqual(okMsg({ t: 'queue', mode: 'standard' }), { t: 'queue', mode: 'standard' });
assert.deepEqual(okMsg({ t: 'in', kind: 'turn', side: -1, ctick: 12 }), { t: 'in', kind: 'turn', side: -1, ctick: 12 });
assert.deepEqual(okMsg({ t: 'in', kind: 'jump', evil: 1 }), { t: 'in', kind: 'jump' }, 'unknown fields are dropped');
okMsg({ t: 'leave' }); okMsg({ t: 'leaveQueue' }); okMsg({ t: 'ping', c: 5 });
assert.ok(parse(Buffer.from(J({ t: 'leave' }))).ok, 'Buffer input (what ws delivers)');

// rejected
bad('not json', 'bad_json'); bad('', 'bad_message'); bad('[]', 'bad_message'); bad('null'); bad({}); bad({ t: 5 });
bad({ t: 'nope' }, 'unknown_type');
bad({ t: 'queue', mode: 'bogus' }, 'bad_mode'); bad({ t: 'queue' }); bad({ t: 'queue', mode: ['standard'] });
bad({ t: 'in', kind: 'turn' }); bad({ t: 'in', kind: 'turn', side: 2 }); bad({ t: 'in', kind: 'turn', side: '1' }); bad({ t: 'in', kind: 'fly' }); bad({ t: 'in' });
bad({ t: 'hello' }); bad({ t: 'hello', dev: true, uid: 'bad uid!', username: 'x' }); bad({ t: 'hello', dev: true, uid: '../x', username: 'x' });
bad({ t: 'ping', c: {} });
bad({ t: 'ping', c: 'x'.repeat(2000) }, 'too_large');
bad(J({ t: 'in', kind: 'jump', pad: 'x'.repeat(1100) }), 'too_large');
assert.ok(parse(J({ t: 'hello', token: 't'.repeat(3000) })).ok, 'a long ID token is fine in hello');
bad({ t: 'hello', token: 't'.repeat(5000) }, 'too_large');

// rate limiter: burst then ~rate per second
{
  let now = 0; const rl = new RateLimiter(30, 30, () => now);
  let allowed = 0; for (let i = 0; i < 100; i++) if (rl.take()) allowed++;
  assert.equal(allowed, 30, 'burst limited to capacity');
  now += 1000; allowed = 0; for (let i = 0; i < 100; i++) if (rl.take()) allowed++;
  assert.equal(allowed, 30, '30 per second refill');
  now += 100; assert.ok(rl.take()); assert.ok(rl.take()); assert.ok(rl.take()); assert.ok(!rl.take(), '0.1 s = 3 tokens');
}

// party intents
for (const t of ['pinvite', 'paccept', 'pdecline', 'pkick', 'ptransfer']) {
  assert.deepEqual(parse(JSON.stringify({ t, uid: 'abc_1', junk: 1 })).msg, { t, uid: 'abc_1' });
  assert.equal(parse(JSON.stringify({ t })).code, 'bad_message'); assert.equal(parse(JSON.stringify({ t, uid: 'a b' })).code, 'bad_message');
}
assert.deepEqual(parse('{"t":"pleave","x":1}').msg, { t: 'pleave' }); assert.deepEqual(parse('{"t":"plist"}').msg, { t: 'plist' });

// auth helpers
assert.equal(sanitizeName('  Bob<script>  '), 'Bobscript'); assert.equal(sanitizeName(''), 'PLAYER'); assert.equal(sanitizeName('x'.repeat(40)).length, 12);
assert.equal(resolveAuthMode({}), 'dev'); assert.equal(resolveAuthMode({ GOOGLE_APPLICATION_CREDENTIALS: 'k.json' }), 'firebase');
assert.equal(resolveAuthMode({ GOOGLE_APPLICATION_CREDENTIALS: 'k.json', DEV_AUTH: '1' }), 'dev');
assert.throws(() => resolveAuthMode({ DEV_AUTH: '0' }));
console.log('protocol tests ok');
