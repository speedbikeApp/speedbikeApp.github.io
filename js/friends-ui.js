// FRIENDS screen (opened from the FRIENDS button at the bottom-left of the main menu) + the button's request badge. DOM only.
// State comes from social.js (fed by online.js from the server's social messages); every action is an intent sent over the shared socket
// (docs/MULTIPLAYER.md "Social"), the server answers with `fres` and a fresh `friends` snapshot. User text only via textContent; badges from rankview.js.
import { net } from './online.js';
import { social, REL_ACTION, FRIEND_ERR } from './social.js';
import { isSignedIn } from './account-ui.js';
import { defaultRank } from './ranks.js';
import { badgeHtml } from './rankview.js';
import { showAnnounce } from './hud.js';

const $ = (id) => document.getElementById(id);
let show = () => {}, openAccountScreen = () => {};
let tab = 'list', openUid = null, confirmUid = null;   // openUid: friend whose action menu is open; confirmUid: waiting for "REMOVE?" yes/no
let results = [], lastQuery = '', searching = false;
const pending = new Set();                              // uids with an action in flight (buttons disabled)
const on = () => { const el = document.querySelector('.screen.on'); return !!el && el.id === 'scrFriends'; };

// ---- party hook ----
// party-ui.js wires INVITE TO PARTY here (the button stays disabled until it does).
//   setPartyHooks({ invite: (friend) => {...}, canInvite: (friend) => bool })  friend = {uid, username, rank, online}
// Both are optional: no `invite` -> button disabled ("COMING SOON"); canInvite(friend) false -> disabled (e.g. friend offline / party full).
const partyHooks = { invite: null, canInvite: null };
export function setPartyHooks(h) { partyHooks.invite = (h && h.invite) || null; partyHooks.canInvite = (h && h.canInvite) || null; render(); }

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function button(label, cls, act, uid) {
  const b = el('button', 'mbtn frame' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.dataset.act = act; if (uid) { b.dataset.uid = uid; b.disabled = pending.has(uid); }
  return b;
}
const rankSpan = (rank) => { const s = el('span'); s.innerHTML = badgeHtml(rank || defaultRank()); return s.firstChild; }; // escaped markup from rankview.js
function empty(text) { return el('div', 'frEmpty', text); }

function statusInfo() {
  switch (net.state) {
    case 'online': { const n = social.onlineCount(); return [`CONNECTED - ${n} FRIEND${n === 1 ? '' : 'S'} ONLINE`, 'ok']; }
    case 'connecting': return ['CONNECTING... (THE SERVER MAY BE WAKING UP)', 'wait'];
    case 'denied': return [(net.error || 'NOT SIGNED IN').toUpperCase(), 'bad'];
    case 'offline': return ['SERVER OFFLINE - RETRYING', 'bad'];
    default: return ['NOT CONNECTED', 'wait'];
  }
}

function friendRow(f) {
  const frag = document.createDocumentFragment();
  const row = el('div', `frRow ${f.online ? 'on' : 'off'}${openUid === f.uid ? ' open' : ''}`);
  const nm = button(f.username, '', 'menu', f.uid); nm.className = 'nm'; nm.disabled = false; nm.title = 'Friend options';
  row.append(el('span', 'st', f.online ? '[ONLINE]' : '[OFFLINE]'), nm, rankSpan(f.rank));
  frag.appendChild(row);
  if (openUid === f.uid) {
    const act = el('div', 'frAct');
    if (confirmUid === f.uid) {
      act.append(el('span', 'q', `REMOVE ${f.username}?`), button('YES, REMOVE', 'danger', 'remove', f.uid), button('CANCEL', '', 'cancelRemove', f.uid));
    } else {
      const inv = button('INVITE TO PARTY', '', 'invite', f.uid);
      const can = !!partyHooks.invite && (!partyHooks.canInvite || !!partyHooks.canInvite(f));
      inv.disabled = !can; inv.title = partyHooks.invite ? (can ? '' : 'Offline, already in your party, or the party is full') : 'Parties are coming soon';
      act.append(inv, button('REMOVE FRIEND', 'danger', 'askRemove', f.uid));
    }
    frag.appendChild(act);
  }
  return frag;
}

function requestRow(p, incoming) {
  const row = el('div', 'frRow on');
  const nm = el('span', 'nm', p.username);
  row.append(nm, rankSpan(p.rank));
  if (incoming) row.append(button('ACCEPT', 'primary', 'accept', p.uid), button('DECLINE', '', 'decline', p.uid));
  else row.append(el('span', 'st', 'PENDING'), button('CANCEL', '', 'cancel', p.uid));
  return row;
}

function relOf(r) { // live relationship (the snapshot beats the possibly stale search result)
  const s = social.state;
  return s.friends.has(r.uid) ? 'friend' : s.incoming.has(r.uid) ? 'incoming' : s.outgoing.has(r.uid) ? 'outgoing' : 'none';
}
function resultRow(r) {
  const rel = relOf(r), a = REL_ACTION[rel], row = el('div', 'frRow on');
  row.append(el('span', 'nm', r.username), rankSpan(r.rank));
  const b = button(a.label, a.act ? 'primary' : '', a.act || 'none', r.uid);
  if (!a.act) b.disabled = true;
  row.append(b);
  return row;
}

function setList(box, nodes, emptyText) { box.textContent = ''; if (nodes.length) box.append(...nodes); else box.append(empty(emptyText)); }

export function render() {
  const signed = isSignedIn();
  if (signed) updateBadges();
  if (!on()) return;
  $('frNeed').hidden = signed; $('frMain').hidden = !signed;
  const [txt, cls] = signed ? statusInfo() : ['', ''];
  $('frStatus').textContent = txt; $('frStatus').className = cls; $('frStatus').hidden = !signed;
  if (!signed) return;
  for (const b of $('frTabs').children) b.classList.toggle('sel', b.dataset.tab === tab);
  $('frList').hidden = tab !== 'list'; $('frReq').hidden = tab !== 'req'; $('frAdd').hidden = tab !== 'add';
  const n = social.pendingCount();
  $('frReqN').hidden = !n; $('frReqN').textContent = n;
  if (tab === 'list') {
    const list = social.sortedFriends();
    if (openUid && !list.some((f) => f.uid === openUid)) openUid = confirmUid = null; // removed meanwhile
    setList($('frList'), list.map(friendRow), social.state.ready ? 'NO FRIENDS YET - USE THE ADD TAB' : 'LOADING...');
  } else if (tab === 'req') {
    const nodes = [];
    const inc = social.incomingList(), out = social.outgoingList();
    if (inc.length) { nodes.push(el('div', 'frEmpty', 'INCOMING')); inc.forEach((p) => nodes.push(requestRow(p, true))); }
    if (out.length) { nodes.push(el('div', 'frEmpty', 'SENT')); out.forEach((p) => nodes.push(requestRow(p, false))); }
    setList($('frReq'), nodes, 'NO PENDING REQUESTS');
  } else {
    const box = $('frRes');
    if (searching) setList(box, [], 'SEARCHING...');
    else setList(box, results.map(resultRow), lastQuery ? 'NO PLAYERS FOUND' : 'TYPE AT LEAST 2 LETTERS OF A USERNAME');
  }
}

function updateBadges() { // request count on the main-menu FRIENDS button
  const n = isSignedIn() ? social.pendingCount() : 0, b = $('mFrBadge');
  b.hidden = !n; b.textContent = n;
}

function msg(text) { $('frMsg').textContent = text || ''; }
function setTab(t) { tab = t; msg(''); if (t === 'add') setTimeout(() => $('frQ').focus(), 0); render(); }

/** Called by menu.showScreen when scrFriends opens. */
export function onScreen() {
  tab = 'list'; openUid = confirmUid = null; msg(''); pending.clear();
  if (isSignedIn()) { if (net.state === 'idle') net.connect(); else net.retryNow(); if (net.state === 'online') net.send({ t: 'flist' }); }
  render();
}

function act(a, uid) {
  const f = social.state.friends.get(uid);
  switch (a) {
    case 'menu': openUid = openUid === uid ? null : uid; confirmUid = null; return render();
    case 'askRemove': confirmUid = uid; return render();
    case 'cancelRemove': confirmUid = null; return render();
    case 'invite': if (f && partyHooks.invite) partyHooks.invite({ ...f }); return;
    case 'remove': return send('fremove', uid);
    case 'accept': case 'faccept': return send('faccept', uid);
    case 'decline': return send('fdecline', uid);
    case 'cancel': return send('fcancel', uid);
    case 'fadd': return send('fadd', uid);
  }
}
function send(t, uid) {
  if (!net.send({ t, uid })) { msg('NOT CONNECTED TO THE SERVER'); return; }
  pending.add(uid); msg(''); render();
}

function search(e) {
  e.preventDefault();
  const q = $('frQ').value.trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 _-]{2,12}$/.test(q)) { msg(FRIEND_ERR.bad_query); return; }
  if (!net.send({ t: 'fsearch', q })) { msg('NOT CONNECTED TO THE SERVER'); return; }
  searching = true; lastQuery = q.toLowerCase(); results = []; msg(''); render();
}

export function initFriendsUi(h) {
  show = h.show; openAccountScreen = h.openAccount;
  $('mFriends').addEventListener('click', () => show('scrFriends'));
  $('frBack').addEventListener('click', () => show('scrMain'));
  $('frAccount').addEventListener('click', () => openAccountScreen());
  for (const b of $('frTabs').children) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('frForm').addEventListener('submit', search);
  $('scrFriends').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b && !b.disabled) act(b.dataset.act, b.dataset.uid);
  });
  social.onChange(() => { pending.clear(); render(); });
  net.on('fresults', (m) => {
    if (m.q !== lastQuery) return;
    searching = false; results = Array.isArray(m.results) ? m.results : []; render();
  });
  net.on('fres', (m) => {
    if (m.uid) pending.delete(m.uid);
    if (m.op === 'fsearch') searching = false;
    if (!m.ok) msg(FRIEND_ERR[m.code] || 'SOMETHING WENT WRONG');
    else if (m.op === 'fadd') msg(m.state === 'friends' ? 'YOU ARE NOW FRIENDS' : 'REQUEST SENT');
    else if (m.op === 'faccept') msg('FRIEND ADDED');
    else if (m.op === 'fremove') { openUid = confirmUid = null; msg('FRIEND REMOVED'); }
    render();
  });
  net.on('fevent', (m) => showAnnounce(m.kind === 'accepted' ? `${m.username} is now your friend` : `${m.username} sent you a friend request`, 'friend'));
  for (const t of ['welcome', 'status', 'close']) net.on(t, render);
  updateBadges();
}
