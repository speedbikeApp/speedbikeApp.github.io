// WebAudio only, fully procedural (no files). Browser-only module; every call is a safe no-op until the context is unlocked.
import { CFG } from './config.js';

let ctx = null, master, musicBus, sfxBus, noiseBuf;
const vol = { master: CFG.audio.master, music: CFG.audio.music, sfx: CFG.audio.sfx, engine: 0.3, muted: false };
let gamePaused = false, wantMusic = false, musicOn = false, timer = null, nextT = 0, step16 = 0;
let engine = null;

const ok = () => ctx && ctx.state === 'running';
const applyVol = () => {
  if (!ctx) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(vol.muted ? 0 : vol.master, t, 0.02);
  musicBus.gain.setTargetAtTime(vol.music, t, 0.02);
  sfxBus.gain.setTargetAtTime(vol.sfx, t, 0.02);
};
export const setMasterVolume = (v) => { vol.master = Math.min(1, Math.max(0, v)); applyVol(); };
export const setMusicVolume = (v) => { vol.music = Math.min(1, Math.max(0, v)); applyVol(); };
export const setSfxVolume = (v) => { vol.sfx = Math.min(1, Math.max(0, v)); applyVol(); };
export const setEngineVolume = (v) => { vol.engine = Math.min(1, Math.max(0, +v || 0)); if (engine && engine.on) engine.g.gain.setTargetAtTime(engineLevel(true), ctx.currentTime, 0.05); };
export const setMuted = (m) => { vol.muted = !!m; applyVol(); };
export const getVolumes = () => ({ ...vol });

// Suspend while the tab is hidden or the game is paused.
function syncSuspend() {
  if (!ctx) return;
  const stop = document.hidden || gamePaused;
  if (stop) killEngine(); // never resume into a stale hum
  if (stop && ctx.state === 'running') ctx.suspend();
  else if (!stop && ctx.state === 'suspended') ctx.resume();
}
export function setPaused(p) { gamePaused = !!p; syncSuspend(); }

function create() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); musicBus = ctx.createGain(); sfxBus = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  musicBus.connect(master); sfxBus.connect(master); master.connect(comp); comp.connect(ctx.destination);
  applyVol();
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  ctx.onstatechange = () => { if (ctx.state === 'running') { if (wantMusic) startMusicLoop(); } else stopMusicLoop(); };
}

// Call once at startup: creates/unlocks the context on the first user gesture, wires page-visibility suspend.
export function initAudio() {
  const unlock = () => {
    if (!ctx) create();
    if (ctx && ctx.state === 'suspended' && !document.hidden && !gamePaused) ctx.resume();
    if (ctx && ctx.state === 'running') for (const e of ['pointerdown', 'keydown', 'touchend']) removeEventListener(e, unlock, true);
  };
  for (const e of ['pointerdown', 'keydown', 'touchend']) addEventListener(e, unlock, true);
  document.addEventListener('visibilitychange', syncSuspend);
}

// ---- helpers ----
function osc(type, f0, f1, t, dur, peak, dest = sfxBus, filt = null) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.01, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(filt || g); if (filt) { filt.connect(g); } g.connect(dest);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise(t, dur, peak, type, f0, f1, q = 1, dest = sfxBus) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.03, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(dest); s.start(t); s.stop(t + dur + 0.05);
}

// ---- sfx ----
export function turn() { if (!ok()) return; const t = ctx.currentTime; osc('square', 900, 600, t, 0.05, 0.12); }
export function boost() { if (!ok()) return; const t = ctx.currentTime; noise(t, 0.7, 0.5, 'bandpass', 300, 3500, 1.5); osc('sawtooth', 120, 400, t, 0.5, 0.15); }
export function jump() { if (!ok()) return; const t = ctx.currentTime; osc('sine', 260, 760, t, 0.22, 0.3); osc('triangle', 520, 1500, t, 0.18, 0.1); }
export function crash(loud = true) {
  if (!ok()) return;
  const t = ctx.currentTime, k = loud ? 1 : 0.5;
  noise(t, 1.2, 0.9 * k, 'lowpass', 5000, 80, 0.7);
  osc('sine', 140, 28, t, 0.7, 0.9 * k);
  noise(t, 0.25, 0.4 * k, 'highpass', 3000, 1500);
}
export function countdownBeep() { if (!ok()) return; osc('square', 440, 440, ctx.currentTime, 0.16, 0.2); }
export function goBeep() { if (!ok()) return; const t = ctx.currentTime; osc('square', 880, 880, t, 0.45, 0.22); osc('sawtooth', 440, 440, t, 0.45, 0.1); }
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function arpeggio(notes, gap) {
  if (!ok()) return;
  const t = ctx.currentTime + 0.02;
  notes.forEach((m, i) => { osc('square', hz(m), hz(m), t + i * gap, 0.28, 0.16); osc('triangle', hz(m - 12), hz(m - 12), t + i * gap, 0.3, 0.2); });
}
export function roundWin() { arpeggio([69, 73, 76, 81], 0.11); }
export function roundLose() { arpeggio([69, 65, 62, 57], 0.16); }

// Engine hum for the player's bike: call every frame. active=false fades it out.
// Design: soft, no beating. A low sine fundamental + a quiet low-passed triangle octave + a low-passed noise "rumble"
// (single oscillators, no detuned pair). Pitch glides gently with speed. Level = vol.engine (0 = off).
// A watchdog silences and tears it down if setEngine stops being called (menus, pause, tab hidden, round over).
const engineLevel = (on) => (on ? vol.engine * 0.22 : 0);
let engineLast = 0, engineWatch = null;
function killEngine() {
  if (engineWatch) { clearInterval(engineWatch); engineWatch = null; }
  if (!engine) return;
  const e = engine; engine = null;
  try { e.g.gain.cancelScheduledValues(0); e.g.gain.value = 0; e.a.stop(); e.b.stop(); e.n.stop(); e.g.disconnect(); } catch { /* already stopped */ }
}
function watchEngine() {
  if (!engine) return;
  const now = performance.now();
  if (now - engineLast > 200 && engine.on) { engine.on = false; engine.offAt = now; engine.g.gain.setTargetAtTime(0, ctx.currentTime, 0.08); }
  if (!engine.on && now - engine.offAt > 1500) killEngine(); // fully off for a while: free the nodes
}
export function setEngine(active, speed, baseSpeed, boosting) {
  if (!ok()) { if (engine && !active) killEngine(); return; }
  const on = !!active && vol.engine > 0;
  engineLast = performance.now();
  if (!engine) {
    if (!on) return;
    const g = ctx.createGain(), fl = ctx.createBiquadFilter(), fn = ctx.createBiquadFilter();
    const a = ctx.createOscillator(), b = ctx.createOscillator(), n = ctx.createBufferSource();
    const ga = ctx.createGain(), gb = ctx.createGain(), gn = ctx.createGain();
    a.type = 'sine'; b.type = 'triangle'; fl.type = 'lowpass'; fl.frequency.value = 260; fl.Q.value = 0.3;
    fn.type = 'lowpass'; fn.frequency.value = 170; fn.Q.value = 0.3;
    ga.gain.value = 0.55; gb.gain.value = 0.16; gn.gain.value = 2.2;
    n.buffer = noiseBuf; n.loop = true;
    a.connect(ga); b.connect(gb); ga.connect(fl); gb.connect(fl); n.connect(fn); fn.connect(gn); gn.connect(fl);
    fl.connect(g); g.gain.value = 0; g.connect(sfxBus);
    a.start(); b.start(); n.start();
    engine = { g, f: fl, a, b, n, on: false, offAt: performance.now() };
    engineWatch = setInterval(watchEngine, 100);
  }
  const t = ctx.currentTime, r = Math.min(2.5, Math.max(0.5, speed / (baseSpeed || 1)));
  const fr = 50 + (r - 1) * 22 + (boosting ? 6 : 0); // gentle glide
  engine.a.frequency.setTargetAtTime(fr, t, 0.25); engine.b.frequency.setTargetAtTime(fr * 2, t, 0.25);
  engine.f.frequency.setTargetAtTime(240 + (r - 1) * 60 + (boosting ? 80 : 0), t, 0.25);
  if (on !== engine.on) { engine.on = on; if (!on) engine.offAt = performance.now(); engine.g.gain.setTargetAtTime(engineLevel(on), t, on ? 0.35 : 0.08); }
  else if (on) engine.g.gain.setTargetAtTime(engineLevel(true) * (boosting ? 1.2 : 1), t, 0.2);
}

// ---- music: bass + arp + drums, 4-bar loop in A minor, scheduled with a look-ahead timer ----
const PROG = [[45, [57, 60, 64]], [41, [53, 57, 60]], [48, [60, 64, 67]], [43, [55, 59, 62]]]; // [bass root, chord]
const ARP = [0, 1, 2, 1, 0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1];
function scheduleStep(n, t, sp) {
  const bar = (n >> 4) & 3, s = n & 15, [root, chord] = PROG[bar];
  if (s % 4 === 0) { osc('sine', 120, 45, t, 0.18, 0.5, musicBus); }                       // kick
  if (s % 4 === 2) noise(t, 0.05, 0.12, 'highpass', 7000, 6000, 1, musicBus);              // hat
  if (s === 4 || s === 12) noise(t, 0.16, 0.25, 'bandpass', 1800, 1500, 0.8, musicBus);    // snare
  if (s % 2 === 0) { // bass 8ths, octave pump
    const f = hz(s % 4 === 0 ? root : root + 12);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    osc('sawtooth', f, f, t, sp * 1.8, 0.2, musicBus, lp);
  }
  const m = chord[ARP[s]] + 12;                              // arp 16ths
  const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 2400;
  osc('square', hz(m), hz(m), t, sp * 0.9, 0.05, musicBus, lp2);
  if (s === 0) { // pad swell
    for (const c of chord) osc('triangle', hz(c), hz(c), t, sp * 15, 0.05, musicBus);
  }
}
function pump() {
  if (!ok()) return;
  const sp = 60 / CFG.audio.bpm / 4;
  while (nextT < ctx.currentTime + 0.2) { scheduleStep(step16, Math.max(nextT, ctx.currentTime), sp); step16 = (step16 + 1) & 63; nextT += sp; }
}
function startMusicLoop() {
  if (!ok() || musicOn) return;
  musicOn = true; step16 = 0; nextT = ctx.currentTime + 0.1;
  timer = setInterval(pump, 40);
}
function stopMusicLoop() { musicOn = false; if (timer) { clearInterval(timer); timer = null; } }
export function startMusic() { wantMusic = true; if (ok()) startMusicLoop(); }
export function stopMusic() { wantMusic = false; stopMusicLoop(); }
