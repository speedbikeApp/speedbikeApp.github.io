import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { nextMilestone } = await import('../js/levels.js');
assert.deepEqual(nextMilestone(1, 100), { level: 5, tier: 'rare' });
assert.deepEqual(nextMilestone(5, 100), { level: 10, tier: 'epic' });
assert.deepEqual(nextMilestone(95, 100), { level: 100, tier: 'legendary' });
assert.equal(nextMilestone(100, 100), null);
assert.equal(nextMilestone(11, 14), null); // no milestone left before max
console.log('levelsui ok');
