import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../store.js';
import { settleMatch, announcementsFor } from '../ranking.js';
import { defaultRank } from '../../js/ranks.js';

const R = (tier, div, wins) => ({ ...defaultRank(), tier, div, wins });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ranks-'));
const file = path.join(dir, 'data', 'ranks.json');

// announcements
assert.deepEqual(announcementsFor('Bob', R('He', 1, 0), R('He', 1, 1), 'none'), [{ kind: 'tierPoint', text: 'Bob is one win from NEON!' }]);
assert.deepEqual(announcementsFor('Bob', R('Ne', 1, 0), R('Ne', 1, 1), 'none'), [{ kind: 'tierPoint', text: 'Bob is one win from XENON!' }]);
assert.deepEqual(announcementsFor('Bob', R('He', 1, 1), R('Ne', 3, 0), 'promote'), [{ kind: 'tierUp', text: 'Bob reached NEON!' }]);
assert.deepEqual(announcementsFor('Bob', R('He', 3, 1), R('He', 2, 0), 'promote'), [], 'division change only: no announcement');
assert.deepEqual(announcementsFor('Bob', R('Xe', 2, 0), R('Xe', 1, 1), 'none'), [], 'Xe1 is the top: no tier point');
assert.deepEqual(announcementsFor('Bob', R('He', 1, 1), R('He', 1, 1), 'none'), [], 'already at the tier point');

const store = createJsonStore(file);
await store.setRank('w', R('He', 1, 1)); await store.setRank('l1', R('Ne', 3, 0)); await store.setRank('l2', R('He', 3, 0));
const e = (id, uid, place, won) => ({ id, uid, username: uid.toUpperCase(), place, won });
const { ranks, announcements } = await settleMatch(store, [e(0, 'w', 1, true), e(1, 'l1', 2, false), e(2, 'l2', 3, false), e(3, 'new', 4, false)], 1234);
const by = Object.fromEntries(ranks.map((r) => [r.uid, r]));
assert.equal(by.w.change, 'promote'); assert.deepEqual([by.w.rankAfter.tier, by.w.rankAfter.div, by.w.rankAfter.wins], ['Ne', 3, 0]);
assert.equal(by.w.rankBefore.wins, 1); assert.equal(by.w.rankAfter.totalWins, 1);
assert.equal(by.l1.change, 'demote'); assert.deepEqual([by.l1.rankAfter.tier, by.l1.rankAfter.div, by.l1.rankAfter.wins], ['He', 1, 1]);
assert.equal(by.l2.change, 'none'); assert.equal(by.l2.rankAfter.wins, 0);
assert.deepEqual([by.new.rankAfter.tier, by.new.rankAfter.div, by.new.rankAfter.matches], ['He', 3, 1], 'unknown uid starts at He3');
assert.deepEqual(announcements, [{ kind: 'tierUp', text: 'W reached NEON!' }, { kind: 'tierPoint', text: 'L1 is one win from NEON!' }]);

// persisted: atomic file, no temp left behind, a fresh store instance reads it back
await store.flush();
assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ranks.json']);
const again = createJsonStore(file);
assert.deepEqual(await again.getRank('w'), by.w.rankAfter);
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).w.username, 'W');
assert.deepEqual(await again.getRank('nobody'), defaultRank());

// corrupt file does not crash the server
fs.writeFileSync(file, '{not json');
const c = createJsonStore(file); assert.deepEqual(await c.getRank('w'), defaultRank());

fs.rmSync(dir, { recursive: true, force: true });
console.log('ranking tests ok');
