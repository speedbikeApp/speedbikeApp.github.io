// ACCOUNT screen (login / register tabs, signed-in user panel) + main-menu status line. DOM only; talks to auth.js.
// User-provided strings are only ever written with textContent / .value. Passwords are never logged or stored here.
import * as auth from './auth.js';
import { setUsername, saveSoon } from './save.js';
import { setPlayerName } from './hud.js';
import { cloudUserChanged, flushCloud, initCloudSave, setOnApplied } from './cloudsave.js';

const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value;
let user = null, tab = 'login';
let onBack = () => {}, openScreen = () => {};
let signup = null, resendAt = 0, resendTimer = 0; // sign-up in progress: {email, password} live in memory only; resend cooldown
let newAccount = () => {}, justRegistered = false; // chose the first username of a brand-new account: start the tutorial
let toMain = false; // login / sign-up in progress: go to the main menu once a NAMED user arrives
let resetToken = ''; // one-time token from ?reset=... of the mailed link
const VIEW = { login: 'acLogin', register: 'acReg', code: 'acCode', forgotpw: 'acFgPw', forgotuser: 'acFgUser', reset: 'acReset' };
const waking = (id) => ({ onStatus: (st) => { if (st === 'waking') setMsg($(id), 'Waking up the server... (can take up to a minute)', 'wait'); } });

export const isSignedIn = () => !!user && !!user.username;
export const accountName = () => (user ? user.username : '');

function statusLine() {
  const s = auth.status(), mock = s.mode === 'mock' ? ' (DEV MOCK)' : '';
  $('mAcct').textContent = user ? (user.username ? `SIGNED IN AS ${user.username}${mock}` : 'FINISH SIGN-UP: CHOOSE A USERNAME') : s.configured ? `GUEST${mock}` : 'GUEST - OFFLINE';
}

// ---- form plumbing ----
const msgOf = (form) => form.querySelector('.acMsg');
function setMsg(form, text, kind) { const m = msgOf(form); m.textContent = text || ''; m.className = 'acMsg' + (kind ? ' ' + kind : ''); }
function hintOf(input) { return input.parentElement.querySelector('.hint'); }
function showHint(input, text) { hintOf(input).textContent = text || ''; input.classList.toggle('bad', !!text); }

// Each form: field validators (id -> () => error string), optional extra enable-check, and run() -> success text.
const FORMS = {
  acLogin: {
    // Value with '@' = email login, anything else = username login (validated server-side; bad names just get the generic error).
    fields: { acLoginEmail: () => { const v = val('acLoginEmail').trim(); return !v ? 'Enter your email or username' : v.includes('@') ? auth.validateEmail(v) : ''; }, acLoginPw: () => (val('acLoginPw') ? '' : 'Enter your password') },
    run: async () => { await auth.login(val('acLoginEmail'), val('acLoginPw'), { onStatus: (s) => { if (s === 'waking') setMsg($('acLogin'), 'Waking up the login server… (can take up to a minute)', 'wait'); } }); },
  },
  acReg: {
    fields: {
      acRegEmail: () => auth.validateEmail(val('acRegEmail')),
      acRegPw: () => auth.validatePassword(val('acRegPw')),
      acRegPw2: () => (val('acRegPw2') === val('acRegPw') ? '' : 'Passwords do not match'),
    },
    run: async () => {
      const email = val('acRegEmail').trim(), password = val('acRegPw');
      const r = await auth.signupStart(email, password, waking('acReg'));
      signup = { email, password }; resendAt = Date.now() + r.resendIn * 1000;
      $('acCodeInfo').textContent = `We sent a 6-digit code to ${email}. It expires in 10 minutes. Can't find it? Check your Spam folder.`;
      setTab('code'); $('acCodeIn').focus();
    },
  },
  acCode: {
    fields: { acCodeIn: () => (/^\d{6}$/.test(val('acCodeIn').trim()) ? '' : 'Enter the 6 digits from the email') },
    run: async () => { if (!signup) { setTab('register'); return; } await auth.signupVerify(signup.email, signup.password, val('acCodeIn'), waking('acCode')); signup = null; }, // then onUser shows the username picker
  },
  acFgPw: {
    fields: { acFgPwId: () => { const v = val('acFgPwId').trim(); return !v ? 'Enter your email or username' : v.includes('@') ? auth.validateEmail(v) : auth.validateUsername(v); } },
    run: async () => { await auth.forgotPassword(val('acFgPwId'), waking('acFgPw')); return 'If an account exists, we emailed a link. It works for 3 minutes, on this network only. Check your Spam folder too.'; },
  },
  acFgUser: {
    fields: { acFgUserEmail: () => auth.validateEmail(val('acFgUserEmail')) },
    run: async () => { await auth.forgotUsername(val('acFgUserEmail'), waking('acFgUser')); return 'If an account exists, we emailed the username. Check your Spam folder too.'; },
  },
  acReset: {
    fields: { acResetPw: () => auth.validatePassword(val('acResetPw')), acResetPw2: () => (val('acResetPw2') === val('acResetPw') ? '' : 'Passwords do not match') },
    run: async () => {
      try { await auth.resetPassword(resetToken, val('acResetPw'), waking('acReset')); } catch (e) { if (e.code === 'invalid-token') stripReset(); throw e; }
      stripReset(); setTab('login'); setMsg($('acLogin'), 'Password changed. Log in with your new password.', 'ok');
    },
  },
  acPick: {
    fields: { acPickName: () => auth.validateUsername(val('acPickName')) },
    run: async () => { await auth.chooseUsername(val('acPickName')); justRegistered = true; }, // onUser then shows the signed-in panel
  },
  acNameForm: {
    fields: { acNewName: () => auth.validateUsername(val('acNewName')) },
    run: async () => { await auth.changeUsername(val('acNewName')); $('acNewName').value = ''; return 'Username changed'; },
  },
  acPwForm: {
    fields: {
      acCurPw: () => (val('acCurPw') ? '' : 'Enter your current password'),
      acNewPw: () => auth.validatePassword(val('acNewPw')),
      acNewPw2: () => (val('acNewPw2') === val('acNewPw') ? '' : 'Passwords do not match'),
    },
    run: async () => { await auth.changePassword(val('acCurPw'), val('acNewPw')); clearPw(); return 'Password changed'; },
  },
  acDelForm: {
    fields: { acDelPw: () => (val('acDelPw') ? '' : 'Enter your current password'), acDelName: () => (user && val('acDelName') === user.username ? '' : 'Type your username exactly') },
    run: async () => {
      await auth.deleteAccount(val('acDelPw'));
      setTab('login'); setMsg($('acLogin'), 'Account deleted', 'ok');
    },
  },
};
const touched = new Set();

function validateForm(id, showAll) {
  const f = FORMS[id], form = $(id);
  let first = null, ok = true;
  for (const [fid, fn] of Object.entries(f.fields)) {
    const err = fn(), inp = $(fid);
    if (err) { ok = false; if (!first) first = inp; }
    showHint(inp, err && (showAll || touched.has(fid)) ? err : '');
  }
  if (id === 'acDelForm') form.querySelector('button[type=submit]').disabled = !ok || form.dataset.busy === '1';
  return { ok, first };
}

async function submit(id, e) {
  e.preventDefault();
  const form = $(id), f = FORMS[id];
  if (form.dataset.busy === '1') return;
  const { ok, first } = validateForm(id, true);
  if (!ok) { setMsg(form, ''); if (first) first.focus(); return; }
  form.dataset.busy = '1';
  const ctl = [...form.querySelectorAll('input, button')], was = ctl.map((c) => c.disabled), btn = form.querySelector('button[type=submit]'), label = btn.textContent;
  ctl.forEach((c) => { c.disabled = true; }); btn.textContent = 'PLEASE WAIT...'; setMsg(form, '');
  let text = null;
  if (id === 'acLogin' || id === 'acCode' || id === 'acPick') toMain = true;
  try { text = await f.run(); } catch (err) { setMsg(form, err && err.message ? err.message : 'Something went wrong', 'err'); text = false; toMain = false; }
  form.dataset.busy = '0'; btn.textContent = label;
  ctl.forEach((c, i) => { c.disabled = was[i]; });
  if (text) setMsg(form, text, 'ok');
  else if (text !== false && msgOf(form).classList.contains('wait')) setMsg(form, ''); // success after waiting for the login server
  if (id === 'acDelForm') validateForm(id, false);
}

function clearPw() { for (const id of ['acLoginPw', 'acRegPw', 'acRegPw2', 'acCurPw', 'acNewPw', 'acNewPw2', 'acDelPw', 'acResetPw', 'acResetPw2']) $(id).value = ''; }
function resetForms() {
  clearPw(); touched.clear();
  for (const id of ['acLoginEmail', 'acRegEmail', 'acNewName', 'acDelName', 'acCodeIn', 'acFgPwId', 'acFgUserEmail', 'acPickName']) if (!(id === 'acLoginEmail' && $(id).value)) $(id).value = '';
  for (const id of Object.keys(FORMS)) { for (const fid of Object.keys(FORMS[id].fields)) showHint($(fid), ''); setMsg($(id), ''); }
  $('acDelForm').hidden = true; $('acDelShow').hidden = false;
  $('acDelForm').querySelector('button[type=submit]').disabled = true;
}

function setTab(t) {
  tab = t;
  for (const b of $('acTabs').children) b.classList.toggle('sel', b.dataset.tab === t);
  for (const [k, id] of Object.entries(VIEW)) $(id).hidden = k !== t;
  $('acTabs').hidden = t !== 'login' && t !== 'register';
  if (t === 'forgotpw' && !val('acFgPwId')) $('acFgPwId').value = val('acLoginEmail');
  clearInterval(resendTimer); resendTimer = 0;
  if (t === 'code') { resendTimer = setInterval(tickResend, 500); tickResend(); }
}
function tickResend() {
  const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000)), b = $('acResend');
  if ($('acCode').dataset.busy !== '1') b.disabled = left > 0 || b.dataset.busy === '1';
  b.textContent = left > 0 ? `RESEND (${left})` : 'RESEND';
}
function stripReset() { resetToken = ''; try { const u = new URL(location.href); u.searchParams.delete('reset'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch { /* ignore */ } }

// Show the right view for the current backend / sign-in state.
export function renderAccount() {
  const s = auth.status();
  $('acMock').hidden = s.mode !== 'mock';
  $('acOff').hidden = s.configured;
  $('acOffMsg').textContent = s.mode === 'error' ? 'Online accounts unavailable' : 'Online accounts not configured';
  const pick = !!user && !user.username;
  $('acOut').hidden = !s.configured || (!!user && tab !== 'reset');
  $('acPickBox').hidden = !s.configured || !pick || tab === 'reset';
  $('acIn').hidden = !s.configured || !user || pick || tab === 'reset';
  if (user) { $('acName').textContent = user.username; $('acMail').textContent = user.email; }
  setTab(tab);
  statusLine();
}

/** Called by menu.js when the screen opens. */
export function openAccount() { resetForms(); renderAccount(); }

/** True if Esc was consumed (closes the delete confirmation first). */
export function accountEsc() {
  if (!$('acDelForm').hidden) { resetForms(); $('acDelShow').focus(); return true; }
  return false;
}

function onUser(u) {
  const changed = (user && user.uid) !== (u && u.uid);
  user = u;
  const named = u && u.username ? u : null; // a signed-in account without a username only sees the username picker
  if (named) { const n = setUsername(named.username); setPlayerName(n); saveSoon(); }
  cloudUserChanged(named); // load + merge account progress (silent on failure)
  if (changed) { resetForms(); if (!u) tab = 'login'; }
  renderAccount();
  if (!u) toMain = false;
  else if (named && toMain) { toMain = false; if (justRegistered) { justRegistered = false; newAccount(); } else onBack(); return; }
  if (u && !u.username && tab !== 'reset') { try { openScreen(); } catch { /* menu not ready */ } }
}

export async function initAccountUi(h) {
  newAccount = h.newAccount || newAccount; onBack = h.back; openScreen = h.open || openScreen; setOnApplied(h.refresh || (() => {})); initCloudSave();
  $('acBack').addEventListener('click', () => onBack());
  for (const b of document.querySelectorAll('#acOut [data-tab]')) b.addEventListener('click', () => { setTab(b.dataset.tab); });
  for (const id of Object.keys(FORMS)) {
    const form = $(id);
    form.addEventListener('submit', (e) => submit(id, e));
    form.addEventListener('input', (e) => { if (e.target.id && FORMS[id].fields[e.target.id]) touched.add(e.target.id); if (form.dataset.busy !== '1') { setMsg(form, ''); validateForm(id, false); } });
  }
  $('acForgot').addEventListener('click', () => setTab('forgotpw'));
  $('acForgotUser').addEventListener('click', () => setTab('forgotuser'));
  $('acCodeBack').addEventListener('click', () => setTab('register'));
  $('acPickOut').addEventListener('click', () => auth.logout());
  $('acResend').addEventListener('click', async () => {
    const b = $('acResend'), form = $('acCode'); if (!signup || b.disabled) return;
    b.dataset.busy = '1'; b.disabled = true; setMsg(form, 'Sending...', 'wait');
    try { const r = await auth.signupStart(signup.email, signup.password, waking('acCode')); resendAt = Date.now() + r.resendIn * 1000; setMsg(form, 'New code sent', 'ok'); }
    catch (e) { if (e.retryAfter) resendAt = Date.now() + e.retryAfter * 1000; setMsg(form, e.message, 'err'); }
    b.dataset.busy = '0'; tickResend();
  });
  $('acLogout').addEventListener('click', async () => { $('acLogout').disabled = true; try { await Promise.race([flushCloud(), new Promise((r) => setTimeout(r, 2000))]); await auth.logout(); } finally { $('acLogout').disabled = false; } });
  $('acDelShow').addEventListener('click', () => { $('acDelShow').hidden = true; $('acDelForm').hidden = false; validateForm('acDelForm', false); $('acDelPw').focus(); });
  $('acDelCancel').addEventListener('click', () => { resetForms(); $('acDelShow').focus(); });
  statusLine();
  await auth.init();
  auth.onAuthChange(onUser);
  resetToken = auth.resetTokenOf(globalThis.location?.search || '');
  if (resetToken) { setTab('reset'); renderAccount(); try { openScreen(); } catch { /* ignore */ } } // opened from the mailed link
}
