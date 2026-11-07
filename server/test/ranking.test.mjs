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
assert.deepEqual(announcementsFor('Bob', R('He', 3, 0), R('He', 3, 1), 'none'), [{ kind: 'tierPoint', text: 'Bob is one win from NEON!' }]);
assert.deepEqual(announcementsFor('Bob', R('Ne', 3, 0), R('Ne', 3, 1), 'none'), [{ kind: 'tierPoint', text: 'Bob is one win from XENON!' }]);
assert.deepEqual(announcementsFor('Bob', R('He', 3, 1), R('Ne', 1, 0), 'promote'), [{ kind: 'tierUp', text: 'Bob reached NEON!' }]);
assert.deepEqual(announcementsFor('Bob', R('He', 1, 1), R('He', 2, 0), 'promote'), [], 'division change only: no announcement');
assert.deepEqual(announcementsFor('Bob', R('Xe', 2, 0), R('Xe', 3, 1), 'none'), [], 'Xe 3 is the top: no tier point');
assert.deepEqual(announcementsFor('Bob', R('He', 3, 1), R('He', 3, 1), 'none'), [], 'already at the tier point');

const store = createJsonStore(file);
await store.setRank('w', R('He', 3, 1)); await store.setRank('l1', R('Ne', 1, 0)); await store.setRank('l2', R('He', 1, 0));
const e = (id, uid, place, won) => ({ id, uid, username: uid.toUpperCase(), place, won });
const { ranks, announcements } = await settleMatch(store, [e(0, 'w', 1, true), e(1, 'l1', 2, false), e(2, 'l2', 3, false), e(3, 'new', 4, false)], 1234);
const by = Object.fromEntries(ranks.map((r) => [r.uid, r]));
assert.equal(by.w.change, 'promote'); assert.deepEqual([by.w.rankAfter.tier, by.w.rankAfter.div, by.w.rankAfter.wins], ['Ne', 1, 0]);
assert.equal(by.w.rankBefore.wins, 1); assert.equal(by.w.rankAfter.totalWins, 1);
assert.equal(by.l1.change, 'demote'); assert.deepEqual([by.l1.rankAfter.tier, by.l1.rankAfter.div, by.l1.rankAfter.wins], ['He', 3, 1]);
assert.equal(by.l2.change, 'none'); assert.equal(by.l2.rankAfter.wins, 0);
assert.deepEqual([by.new.rankAfter.tier, by.new.rankAfter.div, by.new.rankAfter.matches], ['He', 1, 1], 'unknown uid starts at He 1');
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

// ---- migration of stored records: the old numbering (no `v`, div 3 = lowest) is converted on read, written back as v2 on the next update ----
{
  const mfile = path.join(dir, 'old', 'ranks.json'); fs.mkdirSync(path.dirname(mfile), { recursive: true });
  const old = (tier, div, wins) => ({ tier, div, wins, matches: 4, totalWins: 2, updatedAt: 1, username: 'U' });
  fs.writeFileSync(mfile, JSON.stringify({ low: old('He', 3, 1), top: old('Xe', 1, 1), mid: old('Ne', 2, 0), cur: { ...old('Ne', 3, 0), v: 2 } }));
  const ms = createJsonStore(mfile);
  const at = async (u) => { const r = await ms.getRank(u); return [r.tier, r.div, r.wins, r.v]; };
  assert.deepEqual(await at('low'), ['He', 1, 1, 2], 'old lowest (He3) = He 1, same position'); assert.deepEqual(await at('top'), ['Xe', 3, 1, 2], 'old highest (Xe1) = Xe 3');
  assert.deepEqual(await at('mid'), ['Ne', 2, 0, 2]); assert.deepEqual(await at('cur'), ['Ne', 3, 0, 2], 'v2 records are not converted');
  assert.equal(JSON.parse(fs.readFileSync(mfile, 'utf8')).low.div, 3, 'reading alone does not rewrite the file');
  const res = await settleMatch(ms, [e(0, 'low', 1, true), e(1, 'top', 2, false), e(2, 'mid', 3, false)]);
  const rb = Object.fromEntries(res.ranks.map((r) => [r.uid, r]));
  assert.deepEqual([rb.low.rankAfter.tier, rb.low.rankAfter.div, rb.low.change], ['He', 2, 'promote'], 'He 1 + win -> He 2');
  assert.deepEqual([rb.top.rankAfter.tier, rb.top.rankAfter.div, rb.top.rankAfter.wins], ['Xe', 3, 0], 'loss at the top: one win pip less');
  assert.deepEqual([rb.mid.rankAfter.tier, rb.mid.rankAfter.div, rb.mid.change], ['Ne', 1, 'demote']);
  await ms.flush();
  const disk = JSON.parse(fs.readFileSync(mfile, 'utf8'));
  assert.ok(Object.values(disk).every((r) => r.v === 2), 'written back with the new version'); assert.deepEqual([disk.low.tier, disk.low.div], ['He', 2]);
  const reread = createJsonStore(mfile); assert.deepEqual([(await reread.getRank('low')).div, (await reread.getRank('cur')).div], [2, 3], 'a second load does not convert again');
  // Firestore store (fake Admin SDK): same migration on read, v stamped on write
  const { createFirestoreStore } = await import('../store.js');
  const docs = new Map([['f1', old('He', 3, 0)], ['f2', { ...old('Ne', 1, 1), v: 2 }]]);
  const fs2 = createFirestoreStore({ collection: () => ({ doc: (id) => ({ get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }), set: async (v) => { docs.set(id, v); } }) }) });
  assert.deepEqual([(await fs2.getRank('f1')).div, (await fs2.getRank('f2')).div], [1, 1]);
  await fs2.setRank('f1', await fs2.getRank('f1'), 'F'); assert.equal(docs.get('f1').v, 2); assert.equal(docs.get('f1').div, 1);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('ranking tests ok');
