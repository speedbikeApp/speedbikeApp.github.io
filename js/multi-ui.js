// MULTIPLAYER menu screens: scrMulti (rank, online count, mode cards), scrQueue, scrLobby. DOM only; talks to online.js (socket) and
// the menu through the callbacks given to initMultiUi. User text only via textContent; badges come from rankview.js (escaped).
import { CFG } from './config.js';
import { net, mp, MODE_LABEL } from './online.js';
import { isSignedIn } from './account-ui.js';
import { featuredMode, nextRotation } from './rotation.js';
import { defaultRank } from './ranks.js';
import { badgeHtml, badgeInfo, fmtCountdown } from './rankview.js';
import { party, PARTY_ERR } from './party.js';
import { usableAbilities } from './save.js';

const $ = (id) => document.getElementById(id);
let show = () => {}, openAccountScreen = () => {};
let flow = null;            // null | 'queue' | 'lobby'  (set when WE queued, or when the party leader queued for us; late server messages are ignored otherwise)
let flowMode = null;
let lobbyDeadline = 0;      // local performance.now() when the lobby countdown ends

const LEADER_ONLY = 'ONLY THE PARTY LEADER CAN START A GAME';
const menuShown = () => $('menu').style.display === 'flex';
const ERR = { ...PARTY_ERR, busy: 'ALREADY QUEUED OR IN A MATCH', bad_mode: 'MODE NOT AVAILABLE RIGHT NOW', not_authed: 'NOT SIGNED IN TO THE SERVER', rank_failed: 'COULD NOT SAVE RANKS', replaced: 'SIGNED IN FROM ANOTHER PLACE' };
const on = (name) => { const el = document.querySelector('.screen.on'); return !!el && el.id === name; };

function serverClockNow() { return net.state === 'online' ? net.serverNow() : Date.now(); }
function featuredId() { return mp.featured || featuredMode(serverClockNow()); }
function rotationMs() { const at = mp.nextRotation || nextRotation(serverClockNow()); return at - serverClockNow(); }

function statusInfo() {
  switch (net.state) {
    case 'online': return ['CONNECTED', 'ok'];
    case 'connecting': return ['CONNECTING...', 'wait'];
    case 'denied': return [(net.error || 'NOT SIGNED IN').toUpperCase(), 'bad'];
    case 'offline': return ['SERVER OFFLINE', 'bad'];
    default: return ['NOT CONNECTED', 'wait'];
  }
}

export function renderMulti() {
  const signed = isSignedIn();
  $('mpNeed').hidden = signed; $('mpMain').hidden = !signed;
  if (!signed) { $('mpMsg').textContent = ''; return; }
  const b = badgeInfo(mp.rank || defaultRank());
  $('mpRank').innerHTML = `${badgeHtml(mp.rank || defaultRank(), 'big')}<small>${b.label}</small>`;
  $('mpOnline').textContent = mp.online == null ? '-- ONLINE' : `${mp.online} ONLINE`;
  const [txt, cls] = statusInfo();
  $('mpStatus').textContent = txt; $('mpStatus').className = cls;
  const ready = net.state === 'online', lead = party.canStartGame();
  for (const btn of $('mpModes').children) btn.disabled = !ready || !lead;
  const f = featuredId();
  $('mpFeat').firstChild.nodeValue = MODE_LABEL[f] || f.toUpperCase();
  $('mpFeat').querySelector('small').textContent = `FEATURED - ROTATES IN ${fmtCountdown(rotationMs())}`;
  if (net.state === 'offline') $('mpMsg').textContent = 'SERVER OFFLINE - RETRYING. SINGLEPLAYER STILL WORKS.';
  else if (net.state === 'denied') $('mpMsg').textContent = '';
  else if (!lead) $('mpMsg').textContent = LEADER_ONLY;
  else if ($('mpMsg').dataset.keep !== '1') $('mpMsg').textContent = '';
}
function msg(text) { $('mpMsg').textContent = text; $('mpMsg').dataset.keep = text ? '1' : ''; }

function tick() {
  if (on('scrMulti')) {
    if (isSignedIn()) { $('mpFeat').querySelector('small').textContent = `FEATURED - ROTATES IN ${fmtCountdown(rotationMs())}`; const f = featuredId(); $('mpFeat').firstChild.nodeValue = MODE_LABEL[f] || f.toUpperCase(); }
  } else if (on('scrLobby')) setLobbyCount();
}
function setLobbyCount() {
  const s = Math.max(0, Math.ceil((lobbyDeadline - performance.now()) / 1000));
  $('lCount').textContent = lobbyDeadline ? `STARTS IN ${s}` : '';
}

/** Called by menu.showScreen for the multiplayer screens. */
export function onScreen(name) {
  if (name === 'scrMulti') {
    msg('');
    if (isSignedIn()) { if (net.state === 'idle') net.connect(); else net.retryNow(); }
    renderMulti();
  }
}

/** Queue for a mode id ('standard' | 'deathmatch' | 'hyper' | '3d'). Returns false if not connected. */
export function queueMode(modeId) {
  if (net.state !== 'online') { show('scrMulti'); msg('NOT CONNECTED TO THE SERVER'); return false; }
  if (!party.canStartGame()) { show('scrMulti'); msg(LEADER_ONLY); return false; }
  net.send({ t: 'queue', mode: modeId, loadout: usableAbilities() }); // provisional loadout (charges are only spent when the match starts)
  flow = 'queue'; flowMode = modeId;
  $('qMode').textContent = MODE_LABEL[modeId] || modeId.toUpperCase();
  $('qSub').textContent = 'JOINING QUEUE...';
  show('scrQueue');
  return true;
}
const syncCancel = () => { const m = party.inParty() && !party.isLeader(); $('qCancel').textContent = m ? 'LEAVE PARTY' : 'CANCEL'; $('lLeave').textContent = m ? 'LEAVE PARTY' : 'LEAVE'; };
function cancelFlow() {
  if (flow) net.send(party.inParty() && !party.isLeader() ? { t: 'pleave' } : { t: 'leaveQueue' }); // a pulled-in member can only leave the party; the leader's leaveQueue cancels for everybody
  flow = null; lobbyDeadline = 0;
  show('scrMulti');
}
/** Esc / back inside the multiplayer screens. Returns true if handled. */
export function multiBack(name) {
  if (name === 'scrQueue' || name === 'scrLobby') { cancelFlow(); return true; }
  if (name === 'scrMulti') { show('scrPlay'); return true; }
  return false;
}
export const inFlow = () => !!flow;

function renderLobby(m) {
  $('lMode').textContent = MODE_LABEL[m.mode] || String(m.mode).toUpperCase();
  const list = $('lList'); list.textContent = '';
  const myUid = net.welcome ? net.welcome.uid : null;
  for (let i = 0; i < 4; i++) {
    const p = (m.players || [])[i], row = document.createElement('div');
    if (!p) { row.className = 'lrow empty'; row.textContent = '- WAITING -'; list.appendChild(row); continue; }
    row.className = 'lrow' + (p.uid === myUid ? ' me' : '');
    const dot = document.createElement('i'); dot.className = 'dot'; dot.style.setProperty('--c', '#' + CFG.players[(p.colorIdx | 0) % CFG.players.length].color.toString(16).padStart(6, '0'));
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.username;
    if (p.admin) { const ad = document.createElement('span'); ad.className = 'ai'; ad.title = 'Admin'; ad.textContent = '✎'; nm.append(' ', ad); }
    const bd = document.createElement('span'); bd.innerHTML = badgeHtml(p.rank || defaultRank());
    row.append(dot, nm, bd); list.appendChild(row);
  }
  const remain = (m.countdownEndsAt || 0) - (m.serverNow || 0);
  lobbyDeadline = performance.now() + Math.max(0, remain);
  setLobbyCount();
}

export function initMultiUi(h) {
  show = h.show; openAccountScreen = h.openAccount;
  setInterval(tick, 250);
  const click = (id, fn) => $(id).addEventListener('click', fn);
  click('mpBack', () => multiBack('scrMulti'));
  click('mpAccount', () => openAccountScreen());
  click('qCancel', cancelFlow);
  click('lLeave', cancelFlow);
  $('mpModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mp]'); if (!b || b.disabled) return;
    queueMode(b.dataset.mp === 'featured' ? featuredId() : b.dataset.mp);
  });
  // The party leader queued: members are put into the same queue / lobby by the server and follow it on their own screens.
  const follow = () => { if (flow) return true; if (!party.inParty() || !menuShown()) return false; flow = 'queue'; return true; };
  net.on('queued', (m) => {
    if (!follow()) return;
    syncCancel(); flow = 'queue'; flowMode = m.mode;
    $('qMode').textContent = MODE_LABEL[m.mode] || String(m.mode).toUpperCase();
    $('qSub').textContent = `${m.inQueue} IN QUEUE`;
    if (!on('scrQueue')) show('scrQueue');
  });
  net.on('lobby', (m) => { if (!follow()) return; syncCancel(); flow = 'lobby'; renderLobby(m); if (!on('scrLobby')) show('scrLobby'); });
  net.on('start', () => { flow = null; lobbyDeadline = 0; });
  net.on('unqueued', (m) => { // the leader cancelled / we were removed from the party while searching
    if (!flow) return;
    flow = null; lobbyDeadline = 0; show('scrMulti');
    msg(m.reason === 'leader' ? 'THE LEADER CANCELLED THE SEARCH' : 'YOU LEFT THE SEARCH');
  });
  party.onChange(() => { if (on('scrMulti')) renderMulti(); });
  net.on('error', (m) => {
    if (!flow && !on('scrMulti')) return;
    if (flow) { flow = null; show('scrMulti'); }
    msg(ERR[m.code] || String(m.message || 'ERROR').toUpperCase());
  });
  const refresh = () => { if (on('scrMulti')) renderMulti(); };
  for (const t of ['welcome', 'online', 'rotation', 'rank', 'status']) net.on(t, refresh);
  net.on('close', () => {
    if (flow) { flow = null; lobbyDeadline = 0; show('scrMulti'); msg('CONNECTION LOST'); }
  });
}
