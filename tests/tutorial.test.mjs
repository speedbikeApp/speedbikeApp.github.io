import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const S = await import('../js/save.js');
const T = await import('../js/tutorial.js');
const { defaultKeys } = await import('../js/input.js');

{ // steps advance only on the expected action, in order: turns -> jump / boost -> power-up / swap
  let i = 0;
  for (const ev of ['boost', 'right', 'left']) assert.equal(T.stepDone(i, ev), 0 + (ev === 'left' ? 1 : 0));
  i = 1;
  for (const ev of ['right', 'jump', 'boost', 'ability', 'swap']) { assert.equal(T.stepDone(i, 'nope'), i); i = T.stepDone(i, ev); }
  assert.equal(i, T.STEPS.length); assert.equal(T.stepDone(i, 'left'), i);
  assert.deepEqual(T.STEPS.map((s) => s.id), ['left', 'right', 'jump', 'boost', 'ability', 'swap']);
}
{ // hints show the real key bindings / the touch control
  const keys = defaultKeys(); keys.jump = ['KeyJ'];
  assert.equal(T.stepHint(T.STEPS[2], keys, false), 'PRESS J');
  assert.equal(T.stepHint(T.STEPS[3], keys, false), 'PRESS SHIFT');
  assert.equal(T.stepHint(T.STEPS[0], keys, false), 'PRESS A / ←');
  assert.match(T.stepHint(T.STEPS[3], keys, true), /BOOST/);
}
{ // menu locks
  assert.equal(T.gateScreen('scrStats', 'color'), 'scrGarage');
  assert.equal(T.gateScreen('scrMain', 'color'), 'scrGarage');
  assert.equal(T.gateScreen(null, 'color'), null);
  assert.equal(T.gateScreen('scrMulti', 'play'), 'scrMain');
  assert.equal(T.gateScreen('scrMode', 'standard'), 'scrMode');
  assert.equal(T.gateScreen('scrStats', 'done'), 'scrStats');
  assert.equal(T.gateScreen('scrStats', 'drill'), 'scrStats');
}
{ // stage persistence + sanitizing; veterans never get the tutorial forced
  store.clear(); S.loadSave();
  assert.equal(T.stage(), 'new'); assert.ok(!T.active()); assert.ok(T.menuButton(false)); assert.ok(!T.menuButton(true));
  store.set(S.KEY, JSON.stringify({ tutorial: 'bogus' })); assert.equal(S.loadSave().tutorial, 'new');
  store.set(S.KEY, JSON.stringify({ tutorial: 'color' })); assert.equal(S.loadSave().tutorial, 'color');
  store.set(S.KEY, JSON.stringify({ stats: { matches: 3 } })); assert.equal(S.loadSave().tutorial, 'done');
  assert.ok(!('tutorial' in S.progressOf(S.getSave()))); // not synced to the account
}
{ // full flow
  store.clear(); S.loadSave();
  T.beginDrill(); assert.equal(T.stage(), 'drill'); assert.ok(T.active() && T.isDrilling());
  for (const id of ['left', 'right', 'jump', 'boost', 'ability', 'swap']) { assert.ok(!T.drillDone()); T.drillEvent(id); }
  assert.ok(T.drillDone());
  assert.equal(T.finishDrill(), true); assert.equal(T.stage(), 'standard'); assert.equal(T.matchStage(), 'standard');
  T.matchFinished('standard'); assert.equal(T.stage(), 'color');
  assert.ok(T.menuButton(true) === false);
  T.syncColor(); assert.equal(T.stage(), 'color'); // orange equipped: still forced
  S.equipPart('glow', 'cyan'); T.syncColor(); assert.equal(T.stage(), 'play');
  T.matchFinished('standard'); assert.equal(T.stage(), 'play'); // wrong match kind: ignored
  T.matchFinished('play'); assert.equal(T.stage(), 'done'); assert.ok(!T.active());
}
{ // skip ends everything; a replay after done keeps the stage
  store.clear(); S.loadSave(); T.setStage('color');
  assert.equal(T.skip(), false); assert.equal(T.stage(), 'done'); assert.ok(!T.active());
  T.beginDrill(); assert.equal(T.stage(), 'done'); assert.ok(T.active());
  assert.equal(T.finishDrill(), false); assert.ok(!T.active());
}
console.log('tutorial ok');
