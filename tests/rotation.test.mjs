import assert from 'node:assert/strict';
import { featuredMode, nextRotation, multiplayerModes, isMultiplayerMode, ROTATION_MS } from '../js/rotation.js';

const H = 3600000;
assert.equal(ROTATION_MS, H);
assert.equal(featuredMode(0), 'hyper');
assert.equal(featuredMode(H - 1), 'hyper');
assert.equal(featuredMode(H), '3d');
assert.equal(featuredMode(2 * H - 1), '3d');
assert.equal(featuredMode(2 * H), 'multimap');
assert.equal(featuredMode(3 * H), 'hyper');
assert.equal(featuredMode(1e12), ['hyper', '3d', 'multimap'][Math.floor(1e12 / H) % 3]);
assert.equal(nextRotation(0), H);
assert.equal(nextRotation(H - 1), H);
assert.equal(nextRotation(H), 2 * H, 'exactly on the boundary -> next hour');
assert.equal(nextRotation(5 * H + 123456), 6 * H);
assert.deepEqual(multiplayerModes(0), ['standard', 'deathmatch', 'hyper']);
assert.deepEqual(multiplayerModes(H), ['standard', 'deathmatch', '3d']);
assert.ok(isMultiplayerMode('3d', H)); assert.ok(!isMultiplayerMode('3d', 0)); assert.ok(!isMultiplayerMode('bogus', 0));
const t = 7 * H + 999; assert.notEqual(featuredMode(t), featuredMode(nextRotation(t))); // flips exactly at nextRotation
console.log('rotation tests ok');
