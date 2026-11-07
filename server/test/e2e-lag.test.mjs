// Full 4-client match through the real server with 150 ms RTT (+-20 ms jitter) on every message. Real time (TIME_SCALE 1): ~1-2 minutes.
process.env.E2E_RTT_MS = process.env.E2E_RTT_MS || '150';
process.env.E2E_JITTER_MS = process.env.E2E_JITTER_MS || '20';
await import('./e2e.test.mjs');
