// PARTY UI. DOM only. State comes from party.js (fed by online.js from the server's `party` / `pinvites` messages, docs/MULTIPLAYER.md "Party"):
//  - the party row on the main menu next to the FRIENDS button: crown + member names (the leader's crown is gold), LEAVE at the end;
//    the leader taps a member to get TRANSFER LEAD / KICK, everybody else sees nothing destructive
//  - the pending-invite panel (top-right of every menu screen, until the 60 s expiry) with ACCEPT / DECLINE
//  - toasts for invites / joins / leaves, and the INVITE TO PARTY hook of the FRIENDS screen (friends-ui.js).
// User text only via textContent. Every action is an intent over the shared socket; the server answers with `pres` and a fresh `party`.
import { net } from './online.js';
import { party, PARTY_ERR, PARTY_GONE, partyEventText } from './party.js';
import { isSignedIn } from './account-ui.js';
import { setPartyHooks, render as renderFriends } from './friends-ui.js';
import { showAnnounce } from './hud.js';

const $ = (id) => document.getElementById(id);
let openUid = null;   // member whose TRANSFER / KICK menu is open (leader only)
let hadParty = false;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
const crown = (cls = '') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 14 10'); s.setAttribute('class', 'crown ' + cls); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M1 9V2.5l3.5 3L7 1l2.5 4.5L13 2.5V9z'); p.setAttribute('fill', 'currentColor'); s.appendChild(p); return s; };

function send(t, uid) { return net.send(uid ? { t, uid } : { t }); }

export function renderParty() {
  const P = party.state.party, show = !!P && isSignedIn();
  $('mParty').hidden = !show;
  if (!show) { openUid = null; $('pMenu').hidden = true; $('pRow').textContent = ''; return; }
  if (openUid && !party.memberActions(openUid).length) openUid = null; // left / lost the lead meanwhile
  const row = $('pRow'); row.textContent = '';
  for (const m of P.members) {
    const clickable = party.memberActions(m.uid).length > 0, isLead = m.uid === P.leader;
    const chip = el(clickable ? 'button' : 'span', `pm${isLead ? ' lead' : ''}${m.online ? '' : ' off'}${m.uid === party.state.me ? ' me' : ''}${openUid === m.uid ? ' open' : ''}`);
    if (clickable) { chip.type = 'button'; chip.dataset.uid = m.uid; chip.title = 'Party options'; }
    if (isLead) chip.append(crown());
    chip.append(el('span', 'n', m.username));
    if (!m.online) chip.title = 'Offline - removed after 30 s';
    row.appendChild(chip);
  }
  const menu = $('pMenu'), who = openUid && P.members.find((m) => m.uid === openUid);
  menu.hidden = !who; menu.textContent = '';
  if (who) {
    menu.append(el('span', 'q', who.username));
    for (const a of party.memberActions(who.uid)) {
      const b = el('button', 'mbtn frame' + (a === 'kick' ? ' danger' : ''), a === 'kick' ? 'KICK' : 'TRANSFER LEAD'); b.type = 'button'; b.dataset.act = a; b.dataset.uid = who.uid; menu.appendChild(b);
    }
    const x = el('button', 'mbtn frame', 'CLOSE'); x.type = 'button'; x.dataset.act = 'close'; menu.appendChild(x);
  }
}

// Pending invites: a panel that stays until the invite expires (server TTL 60 s) or is answered.
export function renderInvites() {
  const list = isSignedIn() ? party.activeInvites() : [], box = $('pInv');
  box.hidden = !list.length;
  const now = performance.now();
  const sig = list.map((i) => i.uid).join() + '|' + party.inParty();
  if (box.dataset.sig !== sig) { // rebuild only when the set changed; countdowns update in place
    box.dataset.sig = sig; box.textContent = '';
    for (const i of list) {
      const row = el('div', 'pInvRow frame'); row.dataset.uid = i.uid;
      const t = el('div', 't'); const b = el('b', '', i.username); t.append(b, ' invited you to a party', el('small', 'left'));
      const ok = el('button', 'mbtn frame primary', 'ACCEPT'), no = el('button', 'mbtn frame', 'DECLINE');
      ok.type = no.type = 'button'; ok.dataset.act = 'accept'; no.dataset.act = 'decline'; ok.dataset.uid = no.dataset.uid = i.uid;
      row.append(t, ok, no);
      if (party.inParty()) row.append(el('div', 'note', 'ACCEPTING LEAVES YOUR CURRENT PARTY'));
      box.appendChild(row);
    }
  }
  for (const i of list) { const s = box.querySelector(`[data-uid="${CSS.escape(i.uid)}"] small.left`); if (s) s.textContent = `${Math.max(0, Math.ceil((i.until - now) / 1000))}s`; }
}

function onClick(e) {
  const chip = e.target.closest('button.pm');
  if (chip) { openUid = openUid === chip.dataset.uid ? null : chip.dataset.uid; return renderParty(); }
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const uid = b.dataset.uid;
  switch (b.dataset.act) {
    case 'close': openUid = null; return renderParty();
    case 'kick': openUid = null; send('pkick', uid); return renderParty();
    case 'transfer': openUid = null; send('ptransfer', uid); return renderParty();
    case 'accept': return void (send('paccept', uid) || showAnnounce('NOT CONNECTED TO THE SERVER'));
    case 'decline': send('pdecline', uid); return;
  }
}

export function initPartyUi() {
  $('pLeave').addEventListener('click', () => { openUid = null; send('pleave'); });
  $('mParty').addEventListener('click', onClick);
  $('pInv').addEventListener('click', onClick);
  setPartyHooks({
    invite: (f) => { if (!send('pinvite', f.uid)) showAnnounce('NOT CONNECTED TO THE SERVER'); },
    canInvite: (f) => net.state === 'online' && party.canInvite(f),
  });
  party.onChange(() => {
    const has = party.inParty();
    if (hadParty && !has && PARTY_GONE[party.state.reason]) showAnnounce(PARTY_GONE[party.state.reason]);
    hadParty = has;
    renderParty(); renderInvites(); renderFriends();
  });
  net.on('pres', (m) => {
    if (!m.ok) showAnnounce(PARTY_ERR[m.code] || 'SOMETHING WENT WRONG');
    else if (m.op === 'pinvite') showAnnounce('Party invite sent');
  });
  net.on('pevent', (m) => { const t = partyEventText(m); if (t) showAnnounce(t, 'friend'); });
  net.on('error', (m) => { if (PARTY_ERR[m.code] && m.code !== 'busy') showAnnounce(PARTY_ERR[m.code]); }); // leader-only / member busy answers to `queue`
  for (const t of ['welcome', 'status']) net.on(t, () => { renderParty(); renderInvites(); });
  setInterval(renderInvites, 500);
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && openUid) { openUid = null; renderParty(); } });
  renderParty(); renderInvites();
}
