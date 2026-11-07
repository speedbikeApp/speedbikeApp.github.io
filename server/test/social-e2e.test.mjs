// End-to-end friends over real WebSockets (dev-auth server on a random port): search, request, accept, live presence, rename, remove, limits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';
import { createJsonSocialStore } from '../social-store.js';

const guard = setTimeout(() => { console.error('social e2e timed out'); process.exit(1); }, 60000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-social-'));
const social = createJsonSocialStore(path.join(dir, 'social.json'));
const app = createGameServer({ auth: createDevAuth(), store: createJsonStore(path.join(dir, 'ranks.json')), social, log: () => {} });
const port = await app.listen(0);

function client(uid, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, uid, msgs: [], waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); c.waiters = c.waiters.filter((w) => !w.test(m) || (w.resolve(m), false)); });
  c.send = (m) => ws.send(JSON.stringify(m));
  // wait for a message matching `test` (already received ones count only if newer than mark)
  c.next = (test, ms = 5000) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${uid} timed out waiting for ${test}`)), ms);
    c.waiters.push({ test: typeof test === 'function' ? test : (m) => m.t === test, resolve: (m) => { clearTimeout(to); resolve(m); } });
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.hello = async () => { await c.open; const w = c.next('welcome'), f = c.next('friends'); c.send({ t: 'hello', dev: true, uid, username }); await w; return f; };
  c.closed = new Promise((r) => ws.on('close', r));
  return c;
}

const A = client('uidA', 'Alice'), B = client('uidB', 'Bobby');
let snapA = await A.hello();
assert.deepEqual(snapA.friends, []);
// B is not connected yet but must be searchable only after it has connected once (dev directory)
A.send({ t: 'fsearch', q: 'bo' });
assert.equal((await A.next('fresults')).results.length, 0);
const snapB = await B.hello();
A.send({ t: 'fsearch', q: 'BO' });
const res = await A.next('fresults');
assert.equal(res.results.length, 1); assert.equal(res.results[0].username, 'Bobby'); assert.equal(res.results[0].rel, 'none'); assert.equal(res.results[0].uid, 'uidB');
assert.ok(res.results[0].rank && res.results[0].rank.tier, 'search result carries a rank');
A.send({ t: 'fsearch', q: 'al' });
assert.equal((await A.next('fresults')).results.length, 0, 'own name never listed');

// request -> B sees it, A cannot self-friend
A.send({ t: 'fadd', uid: 'uidA' });
assert.equal((await A.next('fres')).code, 'self');
const evB = B.next('fevent'), incB = B.next((m) => m.t === 'friends' && m.incoming.length === 1);
A.send({ t: 'fadd', uid: 'uidB' });
const r1 = await A.next((m) => m.t === 'fres' && m.op === 'fadd');
assert.deepEqual([r1.ok, r1.state], [true, 'sent']);
assert.equal((await evB).kind, 'request');
assert.equal((await incB).incoming[0].username, 'Alice');
assert.ok(A.msgs.some((m) => m.t === 'friends' && m.outgoing.length === 1 && m.outgoing[0].uid === 'uidB'), 'sender sees outgoing');

// accept -> both lists, with live presence
const bothA = A.next((m) => m.t === 'friends' && m.friends.length === 1), bothB = B.next((m) => m.t === 'friends' && m.friends.length === 1);
B.send({ t: 'faccept', uid: 'uidA' });
const fa = await bothA, fb = await bothB;
assert.deepEqual([fa.friends[0].uid, fa.friends[0].username, fa.friends[0].online], ['uidB', 'Bobby', true]);
assert.deepEqual([fb.friends[0].uid, fb.friends[0].username, fb.friends[0].online], ['uidA', 'Alice', true]);
assert.deepEqual(fa.incoming, []); assert.deepEqual(fb.incoming, []);
assert.deepEqual(Object.keys(fa.friends[0].rank).sort(), ['div', 'tier', 'wins']);

// rename -> friend gets fname
const nameMsg = A.next((m) => m.t === 'fname');
B.send({ t: 'frefresh', username: 'Bobster' });
const fnm = await nameMsg;
assert.deepEqual([fnm.uid, fnm.username], ['uidB', 'Bobster']);

// presence: B drops -> A sees offline; B comes back (reconnect) -> online
const offline = A.next((m) => m.t === 'fpresence' && m.uid === 'uidB' && m.online === false);
B.ws.close(); await B.closed;
await offline;
const B2 = client('uidB', 'Bobster');
const online = A.next((m) => m.t === 'fpresence' && m.uid === 'uidB' && m.online === true);
const snapB2 = await B2.hello();
await online;
assert.equal(snapB2.friends[0].online, true, 'reconnected user sees friend online');
// a second connection of the same uid replaces the first and the friend never sees an offline blip
const blips = []; const track = (m) => { if (m.t === 'fpresence') blips.push(m); }; A.ws.on('message', (d) => track(JSON.parse(d)));
const B3 = client('uidB', 'Bobster'); await B3.hello();
await B2.closed;
await new Promise((r) => setTimeout(r, 150));
assert.ok(!blips.some((m) => m.online === false), 'takeover does not flash offline');

// client cannot write friendships: unknown / malformed social messages are rejected, nothing changes
B3.send({ t: 'friends', friends: [{ uid: 'evil' }] });
B3.send({ t: 'fadd', uid: 'x y' });
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual((await social.getLinks('uidB')).friends, ['uidA']);

// remove -> both sides
const goneA = A.next((m) => m.t === 'friends' && m.friends.length === 0), goneB = B3.next((m) => m.t === 'friends' && m.friends.length === 0);
A.send({ t: 'fremove', uid: 'uidB' });
await goneA; await goneB;
assert.deepEqual((await social.getLinks('uidA')).friends, []); assert.deepEqual((await social.getLinks('uidB')).friends, []);

// decline / cancel flow
A.send({ t: 'fadd', uid: 'uidB' }); await A.next((m) => m.t === 'fres' && m.op === 'fadd' && m.ok);
const declined = A.next((m) => m.t === 'friends' && m.outgoing.length === 0);
B3.send({ t: 'fdecline', uid: 'uidA' });
await declined;
A.send({ t: 'fadd', uid: 'uidB' }); await A.next((m) => m.t === 'fres' && m.op === 'fadd' && m.ok);
A.send({ t: 'fcancel', uid: 'uidB' });
await B3.next((m) => m.t === 'friends' && m.incoming.length === 0 && B3.msgs.length > 0);
assert.deepEqual((await social.getLinks('uidA')).outgoing, []);

// unknown target + rate limit on searches
A.send({ t: 'fadd', uid: 'nobody' });
assert.equal((await A.next((m) => m.t === 'fres' && m.uid === 'nobody')).code, 'not_found');
const limited = A.next((m) => m.t === 'fres' && m.code === 'rate_limited');
for (let i = 0; i < 20; i++) A.send({ t: 'fsearch', q: 'bo' });
await limited;

// signed-out sockets can't use social
const raw = client('raw', 'raw'); await raw.open; raw.send({ t: 'fsearch', q: 'bo' });
assert.equal((await raw.next('error')).code, 'not_authed');

for (const c of [A, B3, raw]) c.ws.close();
await app.close();
clearTimeout(guard);
console.log('social e2e passed');
