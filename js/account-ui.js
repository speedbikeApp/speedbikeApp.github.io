// ACCOUNT screen (login / register tabs, signed-in user panel) + main-menu status line. DOM only; talks to auth.js.
// User-provided strings are only ever written with textContent / .value. Passwords are never logged or stored here.
import * as auth from './auth.js';
import { setUsername, saveSoon } from './save.js';
import { setPlayerName } from './hud.js';

const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value;
let user = null, tab = 'login';
let onBack = () => {};

export const isSignedIn = () => !!user;
export const accountName = () => (user ? user.username : '');

function statusLine() {
  const s = auth.status(), mock = s.mode === 'mock' ? ' (DEV MOCK)' : '';
  $('mAcct').textContent = user ? `SIGNED IN AS ${user.username}${mock}` : s.configured ? `GUEST${mock}` : 'GUEST - OFFLINE';
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
      acRegUser: () => auth.validateUsername(val('acRegUser')),
      acRegEmail: () => auth.validateEmail(val('acRegEmail')),
      acRegPw: () => auth.validatePassword(val('acRegPw')),
      acRegPw2: () => (val('acRegPw2') === val('acRegPw') ? '' : 'Passwords do not match'),
    },
    run: async () => { await auth.register(val('acRegEmail'), val('acRegPw'), val('acRegUser')); },
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
  try { text = await f.run(); } catch (err) { setMsg(form, err && err.message ? err.message : 'Something went wrong', 'err'); text = false; }
  form.dataset.busy = '0'; btn.textContent = label;
  ctl.forEach((c, i) => { c.disabled = was[i]; });
  if (text) setMsg(form, text, 'ok');
  else if (text !== false && msgOf(form).classList.contains('wait')) setMsg(form, ''); // success after waiting for the login server
  if (id === 'acDelForm') validateForm(id, false);
}

function clearPw() { for (const id of ['acLoginPw', 'acRegPw', 'acRegPw2', 'acCurPw', 'acNewPw', 'acNewPw2', 'acDelPw']) $(id).value = ''; }
function resetForms() {
  clearPw(); touched.clear();
  for (const id of ['acLoginEmail', 'acRegUser', 'acRegEmail', 'acNewName', 'acDelName']) if (!(id === 'acLoginEmail' && $(id).value)) $(id).value = '';
  for (const id of Object.keys(FORMS)) { for (const fid of Object.keys(FORMS[id].fields)) showHint($(fid), ''); setMsg($(id), ''); }
  $('acDelForm').hidden = true; $('acDelShow').hidden = false;
  $('acDelForm').querySelector('button[type=submit]').disabled = true;
}

function setTab(t) {
  tab = t;
  for (const b of $('acTabs').children) b.classList.toggle('sel', b.dataset.tab === t);
  $('acLogin').hidden = t !== 'login'; $('acReg').hidden = t !== 'register';
}

// Show the right view for the current backend / sign-in state.
export function renderAccount() {
  const s = auth.status();
  $('acMock').hidden = s.mode !== 'mock';
  $('acOff').hidden = s.configured;
  $('acOffMsg').textContent = s.mode === 'error' ? 'Online accounts unavailable' : 'Online accounts not configured';
  $('acOut').hidden = !s.configured || !!user;
  $('acIn').hidden = !s.configured || !user;
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
  if (u) { const n = setUsername(u.username); setPlayerName(n); saveSoon(); }
  if (changed) { resetForms(); if (!u) tab = 'login'; }
  renderAccount();
}

export async function initAccountUi(h) {
  onBack = h.back;
  $('acBack').addEventListener('click', () => onBack());
  for (const b of $('acTabs').children) b.addEventListener('click', () => { setTab(b.dataset.tab); });
  for (const id of Object.keys(FORMS)) {
    const form = $(id);
    form.addEventListener('submit', (e) => submit(id, e));
    form.addEventListener('input', (e) => { if (e.target.id && FORMS[id].fields[e.target.id]) touched.add(e.target.id); if (form.dataset.busy !== '1') { setMsg(form, ''); validateForm(id, false); } });
  }
  $('acForgot').addEventListener('click', async () => {
    const form = $('acLogin'), err = auth.validateEmail(val('acLoginEmail'));
    if (err) { touched.add('acLoginEmail'); showHint($('acLoginEmail'), 'Password reset: enter your account email'); $('acLoginEmail').focus(); return; }
    setMsg(form, 'Sending...');
    try { await auth.resetPassword(val('acLoginEmail')); setMsg(form, 'If that email has an account, a reset link was sent', 'ok'); } catch (e) { setMsg(form, e.message, 'err'); }
  });
  $('acLogout').addEventListener('click', async () => { $('acLogout').disabled = true; try { await auth.logout(); } finally { $('acLogout').disabled = false; } });
  $('acDelShow').addEventListener('click', () => { $('acDelShow').hidden = true; $('acDelForm').hidden = false; validateForm('acDelForm', false); $('acDelPw').focus(); });
  $('acDelCancel').addEventListener('click', () => { resetForms(); $('acDelShow').focus(); });
  statusLine();
  await auth.init();
  auth.onAuthChange(onUser);
}
