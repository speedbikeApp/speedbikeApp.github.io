// The icon a player picked reaches their party and friends, and follows admin rights. Real WebSockets, dev auth, random port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';

const guard = setTimeout(() => { console.error('icons e2e timed out'); process.exit(1); }, 30000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-icons-'));
const app = createGameServer({ auth: createDevAuth(), store: createJsonStore(path.join(dir, 'ranks.json')), adminUsernames: 'BOSS', countdownMs: 60000, log: () => {} });
const port = await app.listen(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(20); } assert.fail('timed out: ' + what); }

async function client(uid) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), c = { ws, uid, msgs: [] };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.last = (t) => c.msgs.filter((m) => m.t === t).at(-1);
  c.member = (who) => c.last('party')?.party?.members.find((m) => m.uid === who);
  await new Promise((r) => ws.on('open', r));
  c.send({ t: 'hello', dev: true, uid, username: uid.toUpperCase() });
  await until(() => c.last('friends'), uid + ' connected');
  return c;
}

const ann = await client('ann'), ben = await client('ben'), boss = await client('boss');
ann.send({ t: 'fadd', uid: 'ben' }); await until(() => ben.last('friends').incoming.length, 'request');
ben.send({ t: 'faccept', uid: 'ann' }); await until(() => ann.last('friends').friends.length && ben.last('friends').friends.length, 'friends');
ann.send({ t: 'pinvite', uid: 'ben' }); await until(() => ben.last('pinvites')?.invites.length, 'invite');
ben.send({ t: 'paccept', uid: 'ann' }); await until(() => ben.member('ann'), 'party');
assert.equal(ben.member('ann').icon, 'founder', 'before a pick: what the lobby would show');

// a pick reaches both lists, NONE included (a founder showing nothing)
for (const icon of ['star:3', '']) {
  ann.send({ t: 'icon', icon });
  await until(() => ben.member('ann').icon === icon && ben.last('ficon')?.icon === icon, `icon "${icon}"`);
}
// a burst is one update, with the last value
const before = ben.msgs.filter((m) => m.t === 'ficon').length;
for (const icon of ['star:1', 'star:2', 'star:4', 'star:5', 'star:6']) ann.send({ t: 'icon', icon });
await until(() => ben.member('ann').icon === 'star:6', 'burst'); await sleep(500);
assert.equal(ben.msgs.filter((m) => m.t === 'ficon').length, before + 1, 'coalesced');

// admin icon: only with the rights, and gone when they are taken away, without the client cooperating
ann.send({ t: 'icon', icon: 'admin' });
await until(() => ben.member('ann').icon === '', 'a non-admin shows nothing');
boss.send({ t: 'admin', op: 'padmin', id: 1, a: { uid: 'ann', on: true } });
await until(() => ben.member('ann').icon === 'admin', 'granted');
boss.send({ t: 'admin', op: 'padmin', id: 2, a: { uid: 'ann', on: false } });
await until(() => ben.member('ann').icon === '' && ben.last('ficon').icon === '', 'revoked');

// offline: the friend list keeps the last pick
ann.send({ t: 'icon', icon: 'star:9' }); await until(() => ben.last('ficon').icon === 'star:9', 'last pick');
ann.ws.close(); await until(() => ben.last('fpresence')?.online === false, 'offline');
ben.msgs = ben.msgs.filter((m) => m.t !== 'friends'); ben.send({ t: 'flist' });
await until(() => ben.last('friends'), 'snapshot');
assert.equal(ben.last('friends').friends[0].icon, 'star:9');

// READY over the wire: two people skip the countdown (60 s here)
const [r1, r2] = [await client('r1'), await client('r2')];
for (const c of [r1, r2]) c.send({ t: 'queue', mode: 'standard' });
await until(() => r1.last('lobby')?.canReady && r2.last('lobby')?.canReady, 'can ready');
r1.send({ t: 'ready' }); await until(() => r2.last('lobby').players.some((p) => p.ready), 'ready shown');
assert.equal(r1.last('start'), undefined, 'one is not enough');
r2.send({ t: 'ready' }); await until(() => r1.last('start') && r2.last('start'), 'started');

for (const c of [ben, boss, r1, r2]) c.ws.close();
await app.close();
fs.rmSync(dir, { recursive: true, force: true });
clearTimeout(guard);
console.log('icons + ready e2e ok');
