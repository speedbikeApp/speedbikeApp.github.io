// Invite links (docs/MULTIPLAYER.md "Invite links", server/invites.js). `?invite=CODE` is read once, kept in sessionStorage through sign-up / sign-in,
// dropped from the address bar, and sent as `invuse` after the next welcome. The FRIENDS screen copies / shares OUR link. Rewards arrive as `invreward`.
import { net } from './online.js';
import { grantPart, addCoins } from './save.js';
import { showAnnounce } from './hud.js';
import * as auth from './auth.js';

const KEY = 'speedbike.invite', CODE_RE = /^[\w-]{8,32}$/;
const mem = (v) => { try { if (v === undefined) return sessionStorage.getItem(KEY) || ''; if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch { /* storage blocked */ } return ''; };
export const pendingInvite = () => mem();
/** The invite code in a query string, '' if absent / malformed. */
export const inviteCodeOf = (search) => { try { const c = new URLSearchParams(search).get('invite') || ''; return CODE_RE.test(c) ? c : ''; } catch { return ''; } };
/** Called once at start: remember ?invite= and remove it from the address bar (a reload must not repeat it). */
export function readInviteParam() {
  const c = inviteCodeOf(globalThis.location?.search || '');
  if (c) { mem(c); try { const u = new URL(location.href); u.searchParams.delete('invite'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch { /* ignore */ } }
  return mem();
}
/** Who owns this code? -> username | '' (public endpoint: works before sign-in). */
export async function inviterName(code) {
  try { const u = auth.authServerUrl('/invite'); if (!u) return ''; const r = await fetch(`${u}?code=${encodeURIComponent(code)}`); const j = await r.json(); return j.ok ? String(j.username) : ''; } catch { return ''; }
}

const link = (code) => `${location.origin}${location.pathname}?invite=${code}`; // the game's own address (GitHub Pages today, the domain later)
const USE_ERR = { unknown: 'THAT INVITE LINK IS NOT VALID ANYMORE', own: 'THAT IS YOUR OWN INVITE LINK', already_friends: 'YOU ARE ALREADY FRIENDS', limit_friends: 'YOUR FRIENDS LIST IS FULL', target_limit_friends: 'THEIR FRIENDS LIST IS FULL' };
let myCode = '', copyNext = false;
const $ = (id) => document.getElementById(id);

async function share(code) { // phones: the share sheet; otherwise copy
  const url = link(code);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: 'SpeedBike', text: 'Play SpeedBike with me!', url }); return; }
    await navigator.clipboard.writeText(url); showAnnounce('INVITE LINK COPIED');
  } catch (e) { if (e && e.name !== 'AbortError') showAnnounce(url); } // clipboard blocked: show it
}

export function initInvite() {
  net.on('welcome', () => { const c = pendingInvite(); if (c) net.send({ t: 'invuse', code: c }); });
  net.on('invres', (m) => {
    if (m.code !== 'rate_limited' && m.code !== 'unavailable') mem(''); // answered (or hopeless): do not repeat; transient errors retry at the next connect
    showAnnounce(m.ok ? `YOU ARE NOW FRIENDS WITH ${m.username}${m.joined ? ' - JOINED THEIR PARTY' : ''}` : USE_ERR[m.code] || 'COULD NOT USE THE INVITE LINK', 'friend');
  });
  net.on('invreward', (m) => {
    addCoins(m.coins); grantPart('glow', 'invited');
    showAnnounce(`INVITE BONUS WITH ${m.name}: +${m.coins} COINS AND THE INVITED COLOR`, 'friend');
  });
  net.on('invcode', (m) => { myCode = m.code; if (copyNext) { copyNext = false; share(myCode); } });
  net.on('status', (s) => { if (s.state === 'idle') myCode = ''; });
  $('frInvite').addEventListener('click', () => { if (myCode) share(myCode); else if (net.send({ t: 'invget' })) copyNext = true; else showAnnounce('NOT CONNECTED TO THE SERVER'); });
  $('frInviteNew').addEventListener('click', () => { if (!confirm('Make a new invite link? The old one stops working.')) return; if (net.send({ t: 'invreset' })) { myCode = ''; showAnnounce('NEW INVITE LINK READY'); } else showAnnounce('NOT CONNECTED TO THE SERVER'); });
}
/** FRIENDS screen opened: fetch our code now so INVITE LINK can copy / share inside the tap (a share sheet needs the tap). */
export function prefetchInvite() { if (!myCode) net.send({ t: 'invget' }); }
