import assert from 'node:assert/strict';
const { pushUrl, keyBytes, shouldAsk } = await import('../js/push.js');
assert.equal(pushUrl('/push/key', '', 'wss://x.onrender.com/'), 'https://x.onrender.com/push/key');
assert.equal(pushUrl('/push/sub', '', 'ws://localhost:8080'), 'http://localhost:8080/push/sub');
assert.deepEqual([...keyBytes('AQID')], [1, 2, 3]); assert.deepEqual([...keyBytes('-_8')], [251, 255]);
assert.equal(shouldAsk('ask', true, 'default'), true);
for (const a of [['on', true, 'default'], ['off', true, 'default'], ['ask', false, 'default'], ['ask', true, 'denied']]) assert.equal(shouldAsk(...a), false);
console.log('push ok');
