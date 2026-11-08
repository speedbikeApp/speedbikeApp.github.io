// Release step: writes a fresh UTC-timestamp version into version.json and js/version.js. Run before every commit that is deployed.
import { writeFileSync } from 'node:fs';
const v = new Date().toISOString().slice(0, 16).replace(/-/g, '.').replace('T', '-').replace(':', '');
const root = new URL('../', import.meta.url);
writeFileSync(new URL('version.json', root), JSON.stringify({ v }) + '\n');
writeFileSync(new URL('js/version.js', root), `export const VERSION = '${v}'; // written by tools/bump-version.mjs (with version.json)\n`);
console.log('version ->', v);
