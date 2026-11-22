// Profile card (main menu, bottom-left) + PROFILE screen (level / xp / prestige) + CHOOSE UNLIMITED screen. DOM only; logic is levels.js.
import { getSave } from './save.js';
import { levelInfo, nextMilestone, prestige, prestigeChoices, pickPrestigeUnlimited } from './levels.js';
import { ABILITIES } from './abilities.js';
import { abilityIcon } from './icons.js';
import { glowHex } from './parts.js';
import { showAnnounce, nameIconHtml } from './hud.js';
import { net, nameIconWire, sendNameIcon } from './online.js';
import { active as tutorialActive } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
let show = () => {};

function setName(node, name) { // the name + the icon picked on the account screen
  const n = document.createElement('span'); n.className = 'n'; n.textContent = name;
  node.replaceChildren(n); node.insertAdjacentHTML('beforeend', nameIconHtml(nameIconWire())); // fixed markup only
}
const pct = (i) => Math.round((i.xp / i.need) * 100) + '%';

/** Re-read the save into the card and (if open) the profile / pick screens. Cheap; call after anything that changes progress. */
export function refreshProfile() {
  const d = getSave(), i = levelInfo(d);
  setName($('pfName'), d.profile.username);
  $('pfLvl').textContent = `LEVEL ${i.level}`;
  sendNameIcon();
  $('pfBar').firstElementChild.style.width = pct(i);
  $('pfXp').textContent = i.canPrestige ? 'MAX LEVEL' : `${i.xp} / ${i.need} XP`;
  $('pfPick').hidden = i.prestigePicks <= 0;
  $('mProfile').querySelector('.pfDia').style.setProperty('--g', hex(glowHex(d.equipped.parts.glow)));
  $('mProfile').hidden = tutorialActive(); // SKIP TUTORIAL sits in the same corner
  if ($('scrProfile').classList.contains('on')) renderProfile();
}

function renderProfile(msg = '') {
  const d = getSave(), i = levelInfo(d), m = nextMilestone(i.level, i.max);
  setName($('prName'), d.profile.username);
  $('prLvl').textContent = `LEVEL ${i.level}`;
  $('prPres').textContent = i.prestige > 0 ? `PRESTIGE ${i.prestige}` : '';
  $('prBar').firstElementChild.style.width = pct(i);
  $('prXp').textContent = i.canPrestige ? 'MAX LEVEL' : `${i.xp} / ${i.need} XP`;
  $('prNext').textContent = i.canPrestige ? 'MAX LEVEL REACHED' : m ? `NEXT REWARD - LEVEL ${m.level}: ${m.tier.toUpperCase()} DROP` : '';
  $('prMsg').textContent = msg;
  $('prPrestige').hidden = !i.canPrestige;
  $('prPick').hidden = i.prestigePicks <= 0;
  $('prPick').textContent = `CHOOSE UNLIMITED (${i.prestigePicks})`;
}

function renderPick() {
  const d = getSave(), ids = prestigeChoices(d), picks = d.prestigePicks;
  $('pkInfo').textContent = ids.length ? `FREE UNLIMITED POWER-UP - ${picks} PICK${picks === 1 ? '' : 'S'} LEFT` : 'NO POWER-UP LEFT TO CHOOSE - YOUR PICK IS KEPT';
  $('pkList').innerHTML = ids.map((id) => `<button class="mbtn frame pkCard" type="button" data-id="${id}">${abilityIcon(id)}<b>${ABILITIES[id].name.toUpperCase()}</b><small class="coins">VALUE ${ABILITIES[id].price}</small></button>`).join('');
}

function openPick() { show('scrPick'); }

export function onScreen(name) {
  if (name === 'scrProfile') renderProfile();
  if (name === 'scrPick') renderPick();
}

export function initProfileUi(h) {
  show = h.show;
  $('mProfile').addEventListener('click', () => show('scrProfile'));
  $('prBack').addEventListener('click', () => show('scrMain'));
  $('pkBack').addEventListener('click', () => show(getSave().prestigePicks > 0 ? 'scrProfile' : 'scrMain'));
  $('prPick').addEventListener('click', openPick);
  $('prPrestige').addEventListener('click', () => {
    if (!confirm('PRESTIGE?\n\nYou go back to LEVEL 1, gain a prestige star, and choose one free UNLIMITED power-up.')) return;
    const r = prestige();
    if (r.ok) { refreshProfile(); openPick(); } else renderProfile('NOT AT MAX LEVEL');
  });
  $('pkList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const r = pickPrestigeUnlimited(b.dataset.id);
    if (!r.ok) return;
    showAnnounce(`UNLIMITED ${ABILITIES[b.dataset.id].name.toUpperCase()} UNLOCKED`);
    refreshProfile();
    show(getSave().prestigePicks > 0 ? 'scrPick' : 'scrProfile');
  });
  new MutationObserver(refreshProfile).observe($('tutSkip'), { attributes: true, attributeFilter: ['hidden'] });
  for (const t of ['welcome', 'status', 'adminstate']) net.on(t, refreshProfile); // the rights to the admin / founder icon come with these
  refreshProfile();
}
