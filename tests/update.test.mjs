import assert from 'node:assert/strict';
const { differs, isStale } = await import('../js/update.js');
const { VERSION } = await import('../js/version.js');
const { readFileSync } = await import('node:fs');
assert.equal(differs(VERSION), false); assert.equal(differs('x' + VERSION), true);
assert.equal(differs(undefined), false); assert.equal(differs(''), false); assert.equal(isStale(), false);
assert.equal(JSON.parse(readFileSync(new URL('../version.json', import.meta.url))).v, VERSION, 'run tools/bump-version.mjs: files out of sync');
console.log('update ok');
