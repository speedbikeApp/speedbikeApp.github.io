// Custom shapes: validator (clamp / reject) and the catalog merge (parts.js applyCatalog keeps valid shapes, base 'none' needs them).
import assert from 'node:assert/strict';
import { validateShapes, cleanShape, shapesKey, MAX_SHAPES, SHAPE_TYPES, SHAPE_ROLES } from '../js/shapedef.js';
import { applyCatalog, getPart } from '../js/parts.js';
const S = { type: 'cone', p: [0.5, 1, 0], r: [0, 90, 0], s: [1, 1, 1], role: 'dark', mirror: false };
assert.deepEqual(validateShapes('body', undefined), { ok: true, shapes: [] }); assert.deepEqual(validateShapes('body', null), { ok: true, shapes: [] });
assert.deepEqual(validateShapes('body', [S]).shapes, [S]);
for (const t of SHAPE_TYPES) assert.ok(cleanShape('body', { ...S, type: t })); for (const r of SHAPE_ROLES) assert.ok(cleanShape('rim', { ...S, role: r }));
let c = cleanShape('body', { ...S, p: [99, -99, 99], r: [1000, -1000, 0], s: [-1, 99, 0.5], extra: 1, mirror: undefined });
assert.deepEqual(c, { type: 'cone', p: [1.6, -0.3, 2.6], r: [360, -360, 0], s: [0.01, 3, 0.5], role: 'dark', mirror: false });
assert.deepEqual(cleanShape('tire', { ...S, p: [99, 99, -99], s: [9, 9, 9] }).p, [0.7, 0.9, -0.9]);
assert.equal(cleanShape('body', { ...S, p: [0.123456, 0, 0] }).p[0], 0.123, 'rounded to 3 decimals');
for (const bad of [null, 5, [], { ...S, type: 'cube' }, { ...S, role: 'visor' }, { ...S, p: [0, 0] }, { ...S, p: [0, '1', 0] }, { ...S, s: [1, Infinity, 1] }, { ...S, r: [NaN, 0, 0] }, { ...S, mirror: 1 }]) assert.equal(cleanShape('body', bad), null, JSON.stringify(bad));
assert.equal(validateShapes('body', Array(MAX_SHAPES).fill(S)).ok, true); assert.equal(validateShapes('body', Array(MAX_SHAPES + 1).fill(S)).ok, false);
assert.equal(validateShapes('body', {}).ok, false); assert.equal(validateShapes('glow', [S]).ok, false); assert.match(validateShapes('body', [S, null]).why, /shape 2/);
assert.equal(shapesKey([S]), shapesKey([{ ...S }])); assert.notEqual(shapesKey([S]), shapesKey([{ ...S, p: [0.6, 1, 0] }]));

applyCatalog({ items: [
  { id: 'c_a', cat: 'body', name: 'A', price: 1, base: 'wedge', shapes: [S, { ...S, type: 'x' }] },   // invalid shapes: model without shapes
  { id: 'c_b', cat: 'body', name: 'B', price: 1, base: 'wedge', shapes: [S] },
  { id: 'c_c', cat: 'tire', name: 'C', price: 1, base: 'none', shapes: [S] },
  { id: 'c_d', cat: 'rim', name: 'D', price: 1, base: 'none' },                                         // 'none' without shapes: skipped
  { id: 'c_e', cat: 'glow', name: 'E', price: 1, base: 'none', shapes: [S] },                          // glow: no shapes / none
] });
assert.equal(getPart('body', 'c_a').shapes, undefined); assert.deepEqual(getPart('body', 'c_b').shapes, [S]);
assert.deepEqual([getPart('tire', 'c_c').base, getPart('tire', 'c_c').shapes.length, getPart('rim', 'c_d'), getPart('glow', 'c_e')], ['none', 1, null, null]);
applyCatalog(null);
console.log('shapedef tests passed');
