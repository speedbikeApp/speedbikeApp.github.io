// DOM HUD: score bar, timer, pause, minimap, countdown / result overlays, ability hexagon.
import { CFG } from './config.js';
import { activeDef, ABILITIES, isActive, canUse, protectLeft } from './abilities.js';
import { MAPS } from './maps.js';
import { getAchievement } from './achievements.js';
import { getPart } from './parts.js';

const $ = (id) => document.getElementById(id);
const css = (c) => '#' + c.toString(16).padStart(6, '0');
const show = (el, on) => { el.style.display = on ? 'flex' : 'none'; };
const cache = {}; // only touch the DOM when a value changed
function setHtml(id, html) { if (cache[id] !== html) { cache[id] = html; $(id).innerHTML = html; } }

let bikes = [], mapCtx = null, mapFrame = 0, reward = null;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Player's display name (HUD + results). textContent only.
export function setPlayerName(name) {
  if (bikes[0]) setBikeInfo(bikes[0].id, name, bikes[0].color);
}
// Name + colour of a bike (player glow colour / AI colour reassignment). Player: also HUD icon + points bar.
export function setBikeInfo(id, name, color) {
  const b = bikes.find((v) => v.id === id);
  if (!b) return;
  b.name = name; b.color = color;
  delete cache['sb' + id]; // scoreboard row refreshes on next setScoreboard
}
// "UNLOCKED: ..." toast for earned achievements (ids). Stacks, fades out by itself.
export function showUnlocks(ids) {
  for (const id of ids) {
    const a = getAchievement(id); if (!a) continue;
    const p = getPart(a.reward.cat, a.reward.id);
    const el = document.createElement('div');
    el.className = 'toast frame';
    el.innerHTML = `UNLOCKED: ${esc(a.name.toUpperCase())}<small>${esc(a.desc)} &mdash; ${esc((p ? p.name : '').toUpperCase())} ${a.reward.cat === 'glow' ? 'COLOR' : a.reward.cat.toUpperCase()}</small>`;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4800);
  }
}
// {placement, earned, total, won} for the results screen (null = not rewarded yet).
export function setMatchReward(r) { reward = r; }

// info: [{id,name,color}]; handlers: {onPause,onResume,onBoost,onJump,onAbility,onSwap,onPlayAgain,onMenu}
export function initHud(info, handlers) {
  bikes = info;
  buildScoreboard();
  mapCtx = $('minimap').getContext('2d');
  $('pause').addEventListener('click', handlers.onPause);
  $('resume').addEventListener('click', handlers.onResume);
  // pointerdown (not click) for instant response; preventDefault keeps focus off the button so Space never re-triggers it
  for (const [id, fn] of [['boostBtn', handlers.onBoost], ['jumpBtn', handlers.onJump], ['abilityBtn', handlers.onAbility], ['swapBtn', handlers.onSwap]]) {
    $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  }
  $('matchResult').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) (b.dataset.act === 'menu' ? handlers.onMenu : handlers.onPlayAgain)();
  });
}

// Boost / jump buttons: fill = meter, "OK!!" when ready, "active" while boosting / airborne. DOM touched only on change.
export function setAbilityButtons(b) {
  for (const [id, meter, active] of [['boostBtn', b.boostMeter, b.boosting], ['jumpBtn', b.jumpMeter, b.jumpT >= 0]]) {
    const pct = Math.floor(meter * 100), ready = meter >= 1;
    const key = `${pct}|${ready}|${active}`;
    if (cache[id] === key) continue;
    cache[id] = key;
    const el = $(id);
    el.style.setProperty('--f', pct);
    el.classList.toggle('ready', ready);
    el.classList.toggle('active', !!active);
    el.querySelector('b').textContent = ready ? 'OK!!' : pct + '%';
  }
}

// Hexagon ability button: icon + short name, cooldown fill / seconds, "OK!!" when ready, glow while the effect runs.
// Swap button shows "slot/actives" and is hidden with fewer than two active abilities. DOM touched only on change.
export function setAbilityHud(b) {
  const def = activeDef(b), actives = (b.abilities || []).filter((id) => ABILITIES[id].type === 'active');
  let key, cdLeft = 0, frac = 1, ready = false, active = false, usedUp = false;
  if (def) {
    cdLeft = b.cd[def.id] || 0;
    frac = def.cooldown > 0 ? 1 - cdLeft / def.cooldown : 1;
    ready = canUse(b, def.id); active = isActive(b, def.id);
    usedUp = !!(def.once && b.used[def.id]);
    key = `${def.id}|${Math.ceil(cdLeft)}|${Math.floor(frac * 50)}|${ready}|${active}|${actives.length}|${actives.indexOf(def.id)}|${usedUp}`;
  } else key = 'none';
  if (cache.abHud === key) return;
  cache.abHud = key;
  const el = $('abilityBtn');
  el.classList.toggle('none', !def); el.classList.toggle('ready', ready); el.classList.toggle('active', active);
  el.style.setProperty('--f', Math.floor(frac * 100));
  $('abIcon').textContent = def ? def.icon : '--';
  $('abName').textContent = def ? def.short : 'NONE';
  $('abState').textContent = !def ? '' : ready ? 'OK!!' : usedUp ? 'USED' : active && cdLeft <= 0 ? 'ON' : Math.ceil(cdLeft) + 's';
  const sw = $('swapBtn');
  sw.style.visibility = actives.length > 1 ? 'visible' : 'hidden';
  sw.textContent = def ? `${actives.indexOf(def.id) + 1}/${actives.length} ⇄` : '';
}

// Small "SHIELD 2.4" tag under the player's name while trails can't hurt (Protector / spawn protection). DOM only on change.
export function setShieldTag(b) {
  const left = b.alive ? protectLeft(b) : 0, txt = left > 0 ? 'SHIELD ' + left.toFixed(1) : '';
  if (cache.shield === txt) return;
  cache.shield = txt;
  const el = $('shieldTag'); el.textContent = txt; el.style.display = txt ? 'block' : 'none';
}

// Briefly light the left (-1) / right (+1) chevron when a turn is input.
const chevTimers = {};
export function flashTurn(side) {
  const id = side < 0 ? 'chevL' : 'chevR', el = $(id);
  el.classList.add('lit'); clearTimeout(chevTimers[id]);
  chevTimers[id] = setTimeout(() => el.classList.remove('lit'), 160);
}

// Top-left scoreboard: one row per bike (player first, fixed order): dot, name, bar, number. Bar = round points toward
// winPoints, or lives in Death Match. Rows are rebuilt only when their own key changes.
const BIKE_SVG = '<svg viewBox="0 0 30 18"><rect x="3" y="7" width="24" height="5" fill="currentColor"/><circle cx="6" cy="13" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="24" cy="13" r="4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="17" y="3" width="8" height="4" fill="#fff"/></svg>';
let rowEls = [];
function buildScoreboard() {
  const box = $('hudRows'); box.innerHTML = ''; rowEls = [];
  bikes.forEach((b, i) => {
    const el = document.createElement('div'); el.className = 'hrow' + (i === 0 ? ' me' : '');
    box.appendChild(el); rowEls.push(el);
    if (i === 0) box.appendChild($('shieldTag')); // SHIELD tag sits right under the player row
  });
  for (const k of Object.keys(cache)) if (k.startsWith('sb')) delete cache[k];
}
// Pure: what a row shows. segs = bar length, n = filled value, out = Death Match eliminated, dim = crashed this round / out.
export function scoreRow(dm, id, match, alive) {
  const n = dm ? (match.lives[id] || 0) : (match.scores[id] || 0);
  const segs = dm ? CFG.deathMatch.lives : CFG.match.winPoints;
  const out = dm && n <= 0 && match.phase !== 'countdown' && match.phase !== 'idle';
  const dim = out || (!alive && (match.phase === "running" || match.phase === "roundEnd"));
  return { n, segs, out, dim };
}
export function setScoreboard(state, match, dm) {
  for (let i = 0; i < bikes.length; i++) {
    const b = bikes[i], r = scoreRow(dm, b.id, match, state.bikes[b.id].alive);
    const key = `${b.name}|${b.color}|${r.n}|${r.segs}|${r.out}|${r.dim}`;
    if (cache['sb' + b.id] === key) continue;
    cache['sb' + b.id] = key;
    const el = rowEls[i], c = css(b.color);
    el.style.setProperty('--c', c);
    el.classList.toggle('dim', r.dim);
    let segs = ''; for (let k = 0; k < r.segs; k++) segs += k < r.n ? '<i class="on"></i>' : '<i></i>';
    el.innerHTML = `${BIKE_SVG}<span class="hn">${esc(b.name)}</span><span class="hp">${segs}</span><span class="hv">${r.out ? 'OUT' : r.n}</span>`;
  }
}
// Small centred status line under the timer (Death Match: respawn countdown / eliminated). '' hides it.
export function setStatus(text) { setHtml('status', text); show($('status'), !!text); }

export function setTimer(seconds) { setHtml('timer', Math.max(0, seconds).toFixed(3)); }
export function showPause(on) { show($('pauseOverlay'), on); }

const nameOf = (id) => esc(bikes.find((b) => b.id === id).name);
const colored = (id, text) => `<span style="color:${css(bikes.find((b) => b.id === id).color)}">${text}</span>`;

function roundResultHtml(match) {
  const r = match.lastResult;
  const gained = {};
  for (const id of r.awards) gained[id] = (gained[id] || 0) + 1;
  const ids = Object.keys(gained).map(Number);
  const title = r.reason === 'timeout' ? 'TIME UP' : r.reason === 'draw' ? 'DRAW' : r.reason === 'out' ? 'YOU CRASHED' : 'ROUND OVER';
  const lines = ids.length
    ? ids.map((id) => `<div class="line">${colored(id, nameOf(id))} +${gained[id]}</div>`).join('')
    : '<div class="line">NO POINTS</div>';
  const board = bikes.map((b) => colored(b.id, `${esc(b.name)} ${match.scores[b.id]}`)).join(' &nbsp; ');
  return `<div class="panel frame"><h2>${title}</h2>${lines}<div class="line" style="font-size:14px">${board}</div></div>`;
}

function matchResultHtml(match) {
  const dm = match.mode.kind === 'deathmatch';
  const rows = match.placements.map((id) =>
    `<div class="line">${match.ranks[id]}. ${colored(id, nameOf(id))} &nbsp; ${match.scores[id]}${dm ? ' KILLS' : ''}</div>`).join('');
  const title = match.ranks[bikes[0].id] === 1 ? 'YOU WIN!' : `${nameOf(match.winner)} WINS`;
  const rw = reward
    ? `<div class="line coins">+${reward.earned} SBCOINS</div><div class="line" style="font-size:14px">TOTAL <span class="coins">${reward.total}</span> &nbsp; PLACE ${reward.placement}</div>`
    + (reward.unlocked || []).map((id) => `<div class="line" style="font-size:14px;color:#fff">UNLOCKED: ${esc(getAchievement(id).name.toUpperCase())}</div>`).join('') : '';
  return `<div class="panel frame"><h2>${title}</h2>${rows}${rw}<button class="mbtn frame primary" type="button" data-act="again">PLAY AGAIN</button><button class="mbtn frame" type="button" data-act="menu">MAIN MENU</button></div>`;
}

// Show overlays for the current match phase.
export function syncOverlays(match) {
  let cd = '';
  if (match.phase === 'countdown') cd = String(Math.ceil(match.cd));
  else if (match.phase === 'running' && match.runTime < CFG.match.goShowSec) cd = 'GO!';
  setHtml('countdown', cd);
  show($('countdown'), !!cd);

  const rr = match.phase === 'roundEnd' && match.lastResult;
  setHtml('roundResult', rr ? roundResultHtml(match) : '');
  show($('roundResult'), !!rr);

  const me = match.phase === 'matchEnd';
  setHtml('matchResult', me ? matchResultHtml(match) : '');
  show($('matchResult'), me);
}

// Top-down minimap: platforms (shaded by height), trails as lines, bikes as dots. A stealthed bike's dot is hidden from the
// viewer (the player); the player's own dot is only dimmed while stealthed.
export function drawMinimap(state) {
  if ((mapFrame++ % 3) || !mapCtx) return;
  const map = state.map || MAPS.arena, c = mapCtx, W = c.canvas.width, k = W / (2 * map.half), o = W / 2;
  c.clearRect(0, 0, W, W);
  c.lineWidth = 2;
  for (const p of map.platforms) {
    const t = Math.max(0, Math.min(1, (p.y + 4) / 8)); // low -> dark, high -> brighter
    c.fillStyle = `rgba(${Math.round(20 + 60 * t)},${Math.round(60 + 120 * t)},${Math.round(70 + 100 * t)},0.35)`;
    c.strokeStyle = '#3f9';
    c.fillRect(o + p.x0 * k, o + p.z0 * k, (p.x1 - p.x0) * k, (p.z1 - p.z0) * k);
    if (!map.walls) c.strokeRect(o + p.x0 * k, o + p.z0 * k, (p.x1 - p.x0) * k, (p.z1 - p.z0) * k);
  }
  c.lineWidth = 3; c.lineCap = 'round';
  for (const b of state.bikes) {
    if (!b.alive) continue;
    c.strokeStyle = css(b.color);
    c.beginPath();
    for (const s of b.trail) { c.moveTo(o + s.x1 * k, o + s.z1 * k); c.lineTo(o + s.x2 * k, o + s.z2 * k); }
    c.stroke();
  }
  for (const b of state.bikes) {
    if (!b.alive) continue;
    if (b.stealth && b.id !== state.playerId) continue;
    c.globalAlpha = b.stealth ? 0.4 : 1;
    c.fillStyle = css(b.color);
    c.beginPath(); c.arc(o + b.x * k, o + b.z * k, b.id === state.playerId ? 7 : 5, 0, 6.283); c.fill();
    if (b.id === state.playerId) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); }
    c.globalAlpha = 1;
  }
}
