// Outbound email through the Gmail API over HTTPS (Render's free tier blocks SMTP). OAuth2 refresh-token flow, no dependencies.
// mailer.send({to, subject, text, html}) -> Promise (throws on failure). Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
// Without them createMailer returns a console mailer: logs "would send to <to>: <subject>" (the body only outside production).

export const FROM = 'SpeedBike <noreply.speedbike@gmail.com>';
const b64url = (b) => Buffer.from(b).toString('base64url');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
const b64body = (s) => wrap76(Buffer.from(s, 'utf8').toString('base64'));
const noCrlf = (s) => { if (/[\r\n]/.test(s)) throw new Error('header injection'); return s; };
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`); // shortcut: one encoded-word (RFC 2047 caps it at 75 chars; Gmail copes), keep subjects short

/** RFC 2822 multipart/alternative message (plain + html), UTF-8, base64 parts. */
export function buildMessage({ to, subject, text, html }, { from = FROM, date = new Date(), boundary = 'sb_' + Math.random().toString(36).slice(2) + Date.now().toString(36) } = {}) {
  const h = [`From: ${from}`, `To: ${noCrlf(to)}`, `Subject: ${encWord(noCrlf(subject))}`, `Date: ${date.toUTCString()}`, 'MIME-Version: 1.0'];
  if (!html) return [...h, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64body(text)].join('\r\n');
  return [...h, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64body(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64body(html),
    `--${boundary}--`, ''].join('\r\n');
}
export const buildRaw = (mail, opts) => b64url(buildMessage(mail, opts));

export function createGmailMailer({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 10000 }) {
  let tok = null, exp = 0;
  async function accessToken() {
    if (tok && now() < exp - 60000) return tok;
    const r = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(timeoutMs),
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.access_token) throw new Error('gmail token ' + r.status + ' ' + String(j && j.error).slice(0, 40));
    tok = j.access_token; exp = now() + (Number(j.expires_in) || 3600) * 1000; return tok;
  }
  return {
    kind: 'gmail',
    async send(mail) {
      const raw = buildRaw(mail);
      for (let i = 0; ; i++) {
        const r = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }), signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.ok) return;
        if (r.status === 401 && i === 0) { tok = null; continue; } // expired/revoked access token: refresh once
        throw new Error('gmail send ' + r.status);
      }
    },
  };
}

export function createConsoleMailer({ production = false, log = console.log } = {}) {
  return { kind: 'console', async send({ to, subject, text }) { log(`[mail] would send to ${to}: ${subject}`); if (!production) log(text); } };
}

export function createMailer(env = process.env, { production = false, log = console.log, fetchImpl } = {}) {
  const { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GMAIL_REFRESH_TOKEN: refreshToken } = env;
  if (clientId && clientSecret && refreshToken) return createGmailMailer({ clientId, clientSecret, refreshToken, fetchImpl });
  if (production) log('[mail] GMAIL_* env missing: emails are NOT sent (sign-up and password reset will not work)');
  return createConsoleMailer({ production, log });
}
