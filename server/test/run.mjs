// Runs every *.test.mjs in this folder in its own process; exits non-zero if any fails.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`FAILED: ${f}`); }
}
if (failed) process.exit(1);
console.log('all server tests passed');
