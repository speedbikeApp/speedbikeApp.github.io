// One-time helper (run locally by the owner): node server/tools/gmail-token.mjs <client_id> <client_secret>
// Prints a Google consent URL, catches the redirect on 127.0.0.1, exchanges the code and prints the REFRESH TOKEN to paste into Render (GMAIL_REFRESH_TOKEN).
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) { console.error('usage: node server/tools/gmail-token.mjs <client_id> <client_secret>'); process.exit(1); }
const state = randomBytes(16).toString('hex');
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
  const done = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); setTimeout(() => { server.close(); process.exit(code === 200 ? 0 : 1); }, 200); };
  if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) return done(400, 'Bad request (' + (u.searchParams.get('error') || 'no code') + '). Run the helper again.');
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: u.searchParams.get('code'), client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }).toString(),
    });
    const j = await r.json();
    if (!j.refresh_token) return done(400, 'No refresh token returned (' + (j.error_description || j.error || r.status) + '). Revoke the app at myaccount.google.com/permissions and retry.');
    console.log('\nGMAIL_REFRESH_TOKEN (secret, paste into Render, do not commit):\n' + j.refresh_token + '\n');
    done(200, 'Done. You can close this tab and read the terminal.');
  } catch (e) { done(500, 'Token exchange failed: ' + e.message); }
});
let redirect = '';
server.listen(0, '127.0.0.1', () => {
  redirect = `http://127.0.0.1:${server.address().port}`;
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.send', access_type: 'offline', prompt: 'consent', state });
  console.log('Open this URL in your browser and sign in as noreply.speedbike@gmail.com:\n\n' + 'https://accounts.google.com/o/oauth2/v2/auth?' + q + '\n\nWaiting for the redirect on ' + redirect + ' ...');
});
