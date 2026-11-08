// Per-IP connection cap + new-connection rate limit (index.js wss 'connection').
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../index.js';
import { createDevAuth } from '../auth.js';
import { createJsonStore } from '../store.js';

console.warn = () => {};
const app = createGameServer({ auth: createDevAuth(), store: createJsonStore(null), maxConnsPerIp: 3, connRatePerMin: 5, log: () => {} });
const port = await app.listen(0);
const open = (ip) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'cf-connecting-ip': ip } });
  ws.on('open', () => res({ ws, closed: new Promise((r) => ws.on('close', (code) => r(code))) })); ws.on('error', () => {});
});
const a = [await open('1.1.1.1'), await open('1.1.1.1'), await open('1.1.1.1')];
const x = await open('1.1.1.1');
assert.equal(await x.closed, 1013, 'fourth socket from one IP is refused');
const o = await open('2.2.2.2'); o.ws.close(); await o.closed; // other IPs are unaffected
a[0].ws.close(); await a[0].closed; await new Promise((r) => setTimeout(r, 50));
const y = await open('1.1.1.1'); // a slot freed by close, but the 5/min budget (3 + refused is not counted + this one) is still fine
y.ws.close(); await y.closed;
const z = await open('1.1.1.1'); // 3 + y = 4, z = 5: still allowed, next is over the rate
z.ws.close(); await z.closed; await new Promise((r) => setTimeout(r, 50));
const w = await open('1.1.1.1'); assert.equal(await w.closed, 1013, 'rate limit: more than 5 new sockets a minute');
for (const c of [...a.slice(1)]) c.ws.terminate();
await new Promise((r) => setTimeout(r, 50));
await app.close();
console.log('conncap test passed');
