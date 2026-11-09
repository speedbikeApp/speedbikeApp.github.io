// Tutorial: stage machine (kept in the local save, never synced to the account) + the drill's step list + its on-screen prompt.
// Flow: new -> drill (empty arena, one action at a time) -> standard (easy bots) -> color (garage, must equip cyan) -> play (one more standard) -> done.
import { getSave, saveSoon, partOwned, TUTORIAL_STAGES } from './save.js';
import { groups, codeLabel, getBindings } from './input.js';

export const STEPS = [
  { id: 'left', title: 'TURN LEFT', touch: 'TAP THE LEFT SIDE OF THE SCREEN' },
  { id: 'right', title: 'TURN RIGHT', touch: 'TAP THE RIGHT SIDE OF THE SCREEN' },
  { id: 'jump', title: 'JUMP', touch: 'TAP THE JUMP BUTTON', hud: 'jump' },
  { id: 'boost', title: 'BOOST', touch: 'TAP THE BOOST BUTTON', hud: 'boost' },
  { id: 'ability', title: 'USE THE POWER-UP', touch: 'TAP THE HEXAGON BUTTON', hud: 'ability' },
  { id: 'swap', title: 'SWAP THE POWER-UP', touch: 'TAP THE ARROW BESIDE THE HEXAGON', hud: 'swap' },
];
export const DRILL_ABILITIES = ['turbo', 'protector']; // lent to the bike in the drill; never touches the saved charges
const ACTIVE = ['drill', 'standard', 'color', 'play'];
const MENU_FLOW = ['scrMain', 'scrPlay', 'scrMode', 'scrAccount']; // screens allowed while the player has to start the next standard match

/** Step index after event `ev` (an action id) happened while on step `i`. */
export const stepDone = (i, ev) => (STEPS[i] && STEPS[i].id === ev ? i + 1 : i);
/** Instruction under the step title: the real key(s) for the action, or the touch control. */
export function stepHint(step, keys, touch) {
  if (touch) return step.touch;
  const caps = groups(keys[step.id] || []).map((g) => codeLabel(g[0]));
  return 'PRESS ' + caps.join(' / ').toUpperCase();
}
/** Screen to really show for a requested one (menu navigation is locked in the color / standard / play stages). */
export function gateScreen(name, stage) {
  if (!name || name === 'scrSettings' || name === 'scrControls') return name;
  if (stage === 'color') return 'scrGarage';
  if ((stage === 'standard' || stage === 'play') && !MENU_FLOW.includes(name)) return 'scrMain';
  return name;
}

let drilling = false, step = 0;
export const stage = () => getSave().tutorial;
export function setStage(s) { if (TUTORIAL_STAGES.includes(s) && getSave().tutorial !== s) { getSave().tutorial = s; saveSoon(); } }
export const isDrilling = () => drilling;
export const drillDone = () => drilling && step >= STEPS.length;
export const active = () => drilling || ACTIVE.includes(stage());
/** 'standard' | 'play' while the next thing to do is a (normal) standard match, else null. */
export const matchStage = () => (stage() === 'standard' || stage() === 'play' ? stage() : null);
/** Main menu shows the TUTORIAL button (and PLAY loses its primary look). */
export const menuButton = (signedIn) => (!signedIn || stage() === 'drill') && ['new', 'drill', 'done'].includes(stage());

export function beginDrill() { drilling = true; step = 0; if (stage() === 'new') setStage('drill'); } // a replay (stage done) keeps its stage
export const endDrill = () => { drilling = false; };
/** Drill finished: the first run goes on to the standard match (true), a replay just ends (false). */
export function finishDrill() { drilling = false; if (stage() !== 'drill') return false; setStage('standard'); return true; }
/** Feed a player action ('left' | 'right' | 'jump' | 'boost' | 'ability' | 'swap') to the drill. */
export function drillEvent(ev) {
  if (!drilling || drillDone()) return;
  const n = stepDone(step, ev);
  if (n !== step) { step = n; refresh(null); }
}
/** Skip button: tutorial over for good. Returns true if the drill was running. */
export function skip() { const was = drilling; drilling = false; setStage('done'); return was; }
/** Cyan equipped (or not obtainable): the colour stage is over. */
export function syncColor() {
  if (stage() !== 'color') return;
  if (getSave().equipped.parts.glow === 'cyan' || !partOwned('glow', 'cyan')) setStage('play');
}
/** After a tutorial standard match: standard -> color, play -> done. */
export function matchFinished(which) { if (stage() === which) setStage(which === 'standard' ? 'color' : 'done'); }

// ---- on-screen prompt (DOM; only called from the browser) ----
const $ = (id) => document.getElementById(id);
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** screen = visible menu screen id or null (in game). Updates the prompt box, HUD highlight, skip button and body flags. */
export function refresh(screen) {
  if (typeof document === 'undefined') return; // node tests
  const st = stage();
  let title = '', sub = '', hi = '';
  if (screen) {
    if (st === 'color') { title = 'PICK CYAN'; sub = 'EQUIP THE CYAN COLOR TO CONTINUE'; }
    else if (matchStage()) { title = 'START A STANDARD MATCH'; sub = 'PLAY > SINGLEPLAYER > STANDARD'; }
  } else if (drilling) {
    if (drillDone()) { title = 'NICE!'; sub = 'NOW A REAL MATCH'; }
    else { const s = STEPS[step]; title = s.title; sub = stepHint(s, getBindings(), touch()); hi = s.hud || ''; }
  }
  const box = $('tutBox');
  box.hidden = !title;
  $('tutTitle').textContent = title; $('tutSub').textContent = sub;
  $('tutStep').textContent = drilling && !screen && !drillDone() ? `${step + 1} / ${STEPS.length}` : '';
  document.body.dataset.tut = hi; document.body.dataset.ts = st;
  document.body.classList.toggle('drill', drilling);
  $('tutSkip').hidden = !active();
}
