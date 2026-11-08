// Pentest F1: users/{uid}.username is client-writable, so the server must only trust a name the usernames/ reservation gives to that uid.
import assert from 'node:assert/strict';
import { ownsName } from '../auth.js';

const names = { quels: { uid: 'owner' }, 'big bob': { uid: 'bob' } };
const db = { collection: (c) => ({ doc: (k) => ({ get: async () => { assert.equal(c, 'usernames'); return { exists: k in names, data: () => names[k] }; } }) }) };

assert.equal(await ownsName(db, 'owner', 'Quels'), true);
assert.equal(await ownsName(db, 'attacker', 'Quels'), false);   // attacker wrote username:'Quels' into their own users doc
assert.equal(await ownsName(db, 'attacker', 'quels '), false);
assert.equal(await ownsName(db, 'bob', ' Big   Bob'), true);     // same key normalisation as js/auth.js nameKey
assert.equal(await ownsName(db, 'x', 'nobody'), false);
assert.equal(await ownsName(db, 'x', ''), false);
assert.equal(await ownsName(db, 'x', { toString: () => 'quels' }), false);
const broken = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('down'); } }) }) };
assert.equal(await ownsName(broken, 'owner', 'Quels'), false); // backend error: not trusted
console.log('ownsName tests passed');
