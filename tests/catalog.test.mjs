// Garage catalog: merge into PARTS, save validation keeps custom ids before the catalog loads, overrides apply, cache + offline behaviour.
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const P = await import('../js/parts.js'), S = await import('../js/save.js'), C = await import('../js/catalog.js'), CS = await import('../js/cloudsave.js');

const CAT = { items: [
  { id: 'c_aaa', cat: 'body', name: 'Super <b>Wedge</b>', price: 400, base: 'wedge', color: 0x112233 },
  { id: 'c_bbb', cat: 'glow', name: 'Pink', price: 50, base: 'red', color: 0xff66aa },
  { id: 'c_ach', cat: 'rim', name: 'Medal', price: 0, ach: 'jump5', base: 'ring' },
  { id: 'c_hid', cat: 'tire', name: 'Gone', price: 10, base: 'slim', hidden: true },
  { id: 'c_bad', cat: 'tire', name: 'Bad', price: 10, base: 'nope' },       // unknown base: ignored
  { id: 'x_evil', cat: 'tire', name: 'Evil', price: 0, base: 'slim' },      // not a custom id: ignored
], overrides: { armored: { price: 123, name: 'Tank' }, wedge: { ach: null, price: 77 }, sleek: { price: 'free' } } };

// ---- save keeps custom ids while the catalog is unknown, falls back for equip/display
store.clear();
const raw = S.defaults(); raw.coins = 9;
raw.unlocks.parts.body.push('c_aaa'); raw.unlocks.parts.glow.push('c_bbb', 'zzz'); raw.equipped.parts.body = 'c_aaa'; raw.equipped.parts.glow = 'c_bbb';
store.set(S.KEY, JSON.stringify(raw));
let d = S.loadSave();
assert.ok(d.unlocks.parts.body.includes('c_aaa') && d.unlocks.parts.glow.includes('c_bbb'), 'custom ids survive load before catalog');
assert.ok(!d.unlocks.parts.glow.includes('zzz'), 'junk ids still dropped');
assert.equal(d.equipped.parts.body, 'c_aaa', 'equipped custom id kept');
assert.equal(P.getPart('body', 'c_aaa'), null); assert.equal(P.glowHex('c_bbb'), P.glowHex('orange'), 'unknown glow falls back to default colour');
assert.equal(S.equipPart('body', 'c_aaa').ok, false, 'cannot (re)equip an unknown id');
S.flushSave(); assert.ok(JSON.parse(store.get(S.KEY)).unlocks.parts.body.includes('c_aaa'), 'persisted');

// ---- cloud merge keeps them too
const loc = S.progressOf(S.getSave()), cloud = S.progressOf(S.parseSave(null)); cloud.updatedAt = 5;
assert.ok(CS.mergeProgress(loc, cloud).unlocks.parts.body.includes('c_aaa'));
assert.ok(CS.resolveProgress(S.getSave(), S.progressOf(S.getSave()), '').unlocks.parts.glow.includes('c_bbb'));

// ---- merge into PARTS
assert.equal(C.useCatalog(CAT), true); assert.equal(C.useCatalog({ items: 5 }), false);
const body = P.getPart('body', 'c_aaa');
assert.deepEqual([body.base, body.price, body.color, body.custom], ['wedge', 400, 0x112233, true]);
assert.equal(body.name, 'Super bWedgeb', 'name sanitized'); // no < > / for innerHTML
assert.equal(P.glowHex('c_bbb'), 0xff66aa); assert.ok(P.getPart('tire', 'c_hid').hidden);
assert.equal(P.getPart('tire', 'c_bad'), null); assert.equal(P.getPart('tire', 'x_evil'), null);
assert.equal(P.getPart('body', 'armored').price, 123); assert.equal(P.getPart('body', 'armored').name, 'Tank');
assert.equal(P.getPart('body', 'wedge').ach, undefined); assert.equal(P.getPart('body', 'wedge').price, 77, 'achievement override cleared');
assert.equal(P.getPart('body', 'sleek').price, 0, 'invalid override ignored');
assert.equal(P.isShown(P.getPart('tire', 'c_hid'), false), false); assert.equal(P.isShown(P.getPart('tire', 'c_hid'), true), true);
d = S.getSave();
assert.equal(d.equipped.parts.body, 'c_aaa'); assert.ok(d.unlocks.parts.body.includes('c_aaa'), 'owned custom item still owned after merge');
assert.equal(S.equipPart('glow', 'c_bbb').ok, true);

// ---- price override applies to buying; achievement-gated custom part follows the achievement
d.coins = 200; S.buyPart('body', 'armored'); // 123 now
assert.equal(S.getSave().coins, 77, "override price charged");
assert.equal(S.buyPart('rim', 'c_ach').reason, 'ach');
S.getSave().unlocks.achievements.push('jump5'); S.reclamp();
assert.ok(S.partOwned('rim', 'c_ach'), 'ach custom part unlocks with its achievement');
// free custom item becomes owned
C.useCatalog({ items: [{ id: 'c_free', cat: 'tire', name: 'Free', price: 0, base: 'wide' }], overrides: {} });
assert.ok(S.partOwned('tire', 'c_free'));
assert.ok(S.getSave().unlocks.parts.body.includes('c_aaa'), 'custom ids kept even if the catalog later lacks them');

// ---- cache + fetch
store.clear(); C.useCatalog({ items: [], overrides: {} });
assert.equal(C.catalogUrl('', 'wss://x.onrender.com'), 'https://x.onrender.com/catalog'); assert.equal(C.catalogUrl('', 'ws://localhost:8787/'), 'http://localhost:8787/catalog');
assert.equal(await C.refreshCatalog(async () => { throw new Error('asleep'); }, 'http://x'), false, 'offline: no throw');
assert.equal(await C.refreshCatalog(async () => ({ ok: false, json: async () => ({}) }), 'http://x'), false);
assert.equal(await C.refreshCatalog(async () => ({ ok: true, json: async () => ({ ok: true, ...CAT }) }), 'http://x'), true);
assert.ok(P.getPart('body', 'c_aaa')); assert.ok(store.has(C.CATALOG_KEY));
C.useCatalog({ items: [], overrides: {} }); assert.equal(P.getPart('body', 'c_aaa'), null);
assert.equal(C.loadCachedCatalog(), true); assert.ok(P.getPart('body', 'c_aaa'), 'cached catalog restores items offline');
console.log('catalog tests passed');
