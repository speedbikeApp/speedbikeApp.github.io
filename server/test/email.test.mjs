// Gmail API mailer: RFC 2822 message encoding, base64url raw, OAuth token caching/refresh, console mailer privacy.
import assert from 'node:assert/strict';
import { buildMessage, buildRaw, createGmailMailer, createConsoleMailer, createMailer, FROM } from '../email.js';

const mail = { to: 'a@b.co', subject: 'Código de SpeedBike ✓', text: 'Hola\nCódigo 123456', html: '<b>Código</b> 123456' };
{ // message structure + UTF-8
  const raw = buildRaw(mail, { boundary: 'BND', date: new Date(0) });
  assert.match(raw, /^[A-Za-z0-9_-]+$/); // base64url: no padding, no + or /
  const msg = Buffer.from(raw, 'base64url').toString('utf8'), head = msg.split('\r\n\r\n')[0];
  assert.equal(FROM, 'SpeedBike <noreply.speedbike@gmail.com>');
  assert.ok(head.includes('From: SpeedBike <noreply.speedbike@gmail.com>') && head.includes('To: a@b.co') && head.includes('MIME-Version: 1.0'));
  assert.ok(head.includes('Content-Type: multipart/alternative; boundary="BND"') && head.includes('Date: Thu, 01 Jan 1970 00:00:00 GMT'));
  const m = head.match(/Subject: (.*)/)[1].match(/^=\?UTF-8\?B\?(.+)\?=$/);
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), mail.subject);
  assert.ok(!/[^\x00-\x7f]/.test(msg)); // everything is ASCII on the wire
  assert.ok(msg.includes('--BND\r\nContent-Type: text/plain; charset=UTF-8') && msg.includes('--BND\r\nContent-Type: text/html; charset=UTF-8') && msg.trimEnd().endsWith('--BND--'));
  const texts = [...msg.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--BND/g)].map((x) => Buffer.from(x[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
  assert.deepEqual(texts, [mail.text, mail.html]);
  assert.equal(buildMessage({ ...mail, subject: 'Plain ASCII' }).match(/Subject: (.*)/)[1], 'Plain ASCII');
  assert.throws(() => buildMessage({ ...mail, subject: 'x\r\nBcc: evil@x.co' }), /injection/);
  assert.throws(() => buildMessage({ ...mail, to: 'a@b.co\r\nBcc: e@x.co' }), /injection/);
}
{ // OAuth refresh + send; token cached until expiry; 401 refreshes once
  const calls = []; let clock = 0, tokenN = 0, fail401 = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') { tokenN++; return { ok: true, status: 200, json: async () => ({ access_token: 'AT' + tokenN, expires_in: 3600 }) }; }
    if (fail401-- > 0) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id: 'm1' }) };
  };
  const m = createGmailMailer({ clientId: 'CID', clientSecret: 'SEC', refreshToken: 'RT', fetchImpl, now: () => clock });
  await m.send(mail); await m.send(mail);
  assert.equal(tokenN, 1);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('client_id'), 'CID'); assert.equal(body.get('client_secret'), 'SEC'); assert.equal(body.get('refresh_token'), 'RT');
  const send = calls[1]; assert.equal(send.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(send.init.headers.Authorization, 'Bearer AT1'); assert.match(JSON.parse(send.init.body).raw, /^[A-Za-z0-9_-]+$/);
  clock = 3600e3; await m.send(mail); assert.equal(tokenN, 2); // expired -> refreshed
  fail401 = 1; await m.send(mail); assert.equal(tokenN, 3); // 401 -> one refresh + retry
  fail401 = 5; await assert.rejects(m.send(mail), /gmail send 401/);
  const bad = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }) });
  await assert.rejects(bad.send(mail), /gmail token 400 invalid_grant/);
}
{ // console mailer never prints the body in production; factory picks by env
  const out = []; const log = (...a) => out.push(a.join(' '));
  await createConsoleMailer({ production: true, log }).send(mail);
  assert.deepEqual(out, ['[mail] would send to a@b.co: ' + mail.subject]);
  out.length = 0; await createConsoleMailer({ production: false, log }).send(mail); assert.equal(out.length, 2);
  assert.equal(createMailer({}, { production: true, log }).kind, 'console'); assert.ok(out.some((l) => /GMAIL_\* env missing/.test(l)));
  assert.equal(createMailer({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' }).kind, 'gmail');
}
console.log('email tests passed');
