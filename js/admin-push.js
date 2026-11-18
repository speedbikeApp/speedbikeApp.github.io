// ADMIN > NOTIFY tab: push a custom notification or the HUGE UPDATE one to every subscriber (server ops pushsend / pushstats). textContent only.
import { registerAdminTab, ADMIN_ERR } from './admin-core.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; };

function mountPush(root, { call }) {
  const msg = el('div', 'adMsg'), stats = el('div', 'adSec'), form = el('div', 'adSec');
  const title = el('input', 'wide'), body = el('input', 'wide');
  title.maxLength = 60; title.placeholder = 'TITLE'; body.maxLength = 200; body.placeholder = 'BODY';
  const say = (t, kind) => { msg.textContent = t || ''; msg.className = 'adMsg' + (kind ? ' ' + kind : ''); };
  async function loadStats() {
    const r = await call('pushstats', {}); if (dead) return;
    stats.textContent = ''; stats.append(el('b', '', 'SUBSCRIBERS'), el('div', '', r.ok ? `${r.subs} SUBSCRIBED - PUSH ${r.configured ? 'CONFIGURED' : 'NOT CONFIGURED (NO VAPID KEYS)'}` : (ADMIN_ERR[r.code] || String(r.code).toUpperCase())));
  }
  const send = async (kind, what) => {
    const t = title.value.trim(), b = body.value.trim();
    if (kind === 'custom' && (!t || !b)) return say('TITLE AND BODY ARE REQUIRED', 'bad');
    if (!globalThis.confirm(`Send ${what} to EVERYONE who turned notifications on?`)) return;
    say('...'); const r = await call('pushsend', { kind, title: t, body: b });
    say(r.ok ? `SENT ${r.sent}, FAILED ${r.failed}` : (ADMIN_ERR[r.code] || String(r.code || 'ERROR').toUpperCase()), r.ok ? 'ok' : 'bad'); loadStats();
  };
  form.append(el('b', '', 'NOTIFICATION'), title, body,
    btn('SEND TO EVERYONE', 'primary', () => send('custom', 'this notification')),
    btn('HUGE UPDATE', 'danger', () => send('update', 'the HUGE UPDATE notification (empty fields use the default text)')));
  root.append(msg, stats, form);
  let dead = false; loadStats();
  return () => { dead = true; };
}
registerAdminTab('push', 'NOTIFY', mountPush);
