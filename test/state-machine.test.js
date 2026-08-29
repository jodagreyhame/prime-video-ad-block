'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SM = require('../src/common/state-machine.js');
const D = require('../src/common/defaults.js');

/**
 * Drives the state machine through a scripted timeline.
 * Each step is { t, ad, userMute? } — userMute simulates the viewer reaching
 * for the mute button between ticks.
 */
function run(steps, overrides) {
  const settings = D.cloneSettings(overrides);
  let state = SM.createState();
  let muted = false;
  const log = [];
  for (const step of steps) {
    if (step.userMute !== undefined) muted = step.userMute;
    const out = SM.decide(state, {
      now: step.t,
      adSignal: !!step.ad,
      signals: step.ad ? ['adTimeIndicator'] : [],
      remainingSec: step.remainingSec == null ? null : step.remainingSec,
      isMuted: muted,
      settings,
    });
    state = out.state;
    for (const a of out.actions) {
      if (a.type === 'mute') muted = true;
      if (a.type === 'unmute') muted = false;
      log.push(Object.assign({ t: step.t }, a));
    }
  }
  return { state, muted, log, types: log.map((a) => a.type) };
}

test('mutes as soon as an ad signal appears and unmutes after the grace delay', () => {
  const r = run([
    { t: 0, ad: false },
    { t: 400, ad: true },
    { t: 800, ad: true },
    { t: 1200, ad: false }, // signal gone, grace period starts
    { t: 1400, ad: false }, // still inside the 500ms grace
    { t: 1800, ad: false }, // grace elapsed
  ]);
  assert.deepStrictEqual(r.types, ['adStart', 'mute', 'unmute', 'adEnd']);
  assert.strictEqual(r.muted, false);
  assert.strictEqual(r.state.phase, 'idle');
  const end = r.log.find((a) => a.type === 'adEnd');
  assert.strictEqual(end.reason, 'clear');
  assert.strictEqual(end.muted, true);
  assert.strictEqual(end.durationMs, 1800 - 400);
});

test('does not unmute during a gap shorter than the grace delay (ad pods)', () => {
  const r = run([
    { t: 0, ad: true },
    { t: 400, ad: false }, // gap between two ads in the same pod
    { t: 700, ad: true },
    { t: 1100, ad: true },
  ]);
  assert.deepStrictEqual(r.types, ['adStart', 'mute']);
  assert.strictEqual(r.muted, true, 'should still be holding the mute');
  assert.strictEqual(r.state.phase, 'ad');
});

test('leaves audio alone when the viewer was already muted before the ad', () => {
  const r = run([
    { t: 0, ad: false, userMute: true },
    { t: 400, ad: true },
    { t: 800, ad: false },
    { t: 1400, ad: false },
  ]);
  assert.deepStrictEqual(r.types, ['adStart', 'adEnd']);
  assert.strictEqual(r.muted, true, 'must not unmute audio we never muted');
  assert.strictEqual(r.log.find((a) => a.type === 'adEnd').muted, false);
});

test('stands down for the rest of the break if the viewer unmutes by hand', () => {
  const r = run([
    { t: 0, ad: true },
    { t: 400, ad: true, userMute: false }, // viewer hits unmute
    { t: 800, ad: true },
    { t: 1200, ad: true },
    { t: 1600, ad: false },
    { t: 2400, ad: false },
  ]);
  assert.deepStrictEqual(r.types, ['adStart', 'mute', 'userOverride', 'adEnd']);
  assert.strictEqual(r.muted, false, 'must not re-mute against the viewer');
});

test('re-takes the mute when respectManualUnmute is off', () => {
  const r = run(
    [
      { t: 0, ad: true },
      { t: 400, ad: true, userMute: false },
      { t: 800, ad: true },
    ],
    { respectManualUnmute: false }
  );
  assert.deepStrictEqual(r.types, ['adStart', 'mute', 'mute']);
  assert.strictEqual(r.muted, true);
});

test('honours muteDelayMs before muting', () => {
  const r = run(
    [
      { t: 0, ad: true },
      { t: 400, ad: true }, // still inside the 1000ms delay
      { t: 1100, ad: true },
    ],
    { muteDelayMs: 1000 }
  );
  assert.deepStrictEqual(r.types, ['adStart', 'mute']);
  assert.strictEqual(r.log[0].t, 1100);
});

test('safety release: a stuck ad signal cannot mute forever', () => {
  const steps = [];
  for (let t = 0; t <= 700000; t += 100000) steps.push({ t, ad: true });
  const r = run(steps);
  assert.deepStrictEqual(r.types, ['adStart', 'mute', 'unmute', 'adEnd']);
  assert.strictEqual(r.log.find((a) => a.type === 'adEnd').reason, 'timeout');
  assert.strictEqual(r.muted, false);
  assert.strictEqual(r.state.phase, 'stuck', 'stays stuck until the signal clears');
});

test('after a safety release it re-arms only once the signal actually clears', () => {
  let state = SM.createState();
  const settings = D.cloneSettings();
  let muted = false;
  const fire = (t, ad) => {
    const out = SM.decide(state, {
      now: t,
      adSignal: ad,
      signals: [],
      remainingSec: null,
      isMuted: muted,
      settings,
    });
    state = out.state;
    out.actions.forEach((a) => {
      if (a.type === 'mute') muted = true;
      if (a.type === 'unmute') muted = false;
    });
    return out.actions.map((a) => a.type);
  };

  fire(0, true);
  fire(settings.maxAdMuteMs + 1, true); // times out -> stuck
  assert.strictEqual(state.phase, 'stuck');
  assert.deepStrictEqual(fire(settings.maxAdMuteMs + 2, true), [], 'no re-mute while stuck');
  assert.strictEqual(muted, false);

  fire(settings.maxAdMuteMs + 3, false); // signal finally clears -> idle
  assert.strictEqual(state.phase, 'idle');
  assert.deepStrictEqual(fire(settings.maxAdMuteMs + 4, true), ['adStart', 'mute']);
});

test('turning the extension off mid-ad hands the audio straight back', () => {
  let state = SM.createState();
  let muted = false;
  const on = D.cloneSettings();
  const off = D.cloneSettings({ enabled: false });

  let out = SM.decide(state, { now: 0, adSignal: true, signals: [], isMuted: muted, settings: on });
  state = out.state;
  muted = true;
  assert.deepStrictEqual(out.actions.map((a) => a.type), ['adStart', 'mute']);

  out = SM.decide(state, { now: 400, adSignal: true, signals: [], isMuted: muted, settings: off });
  assert.deepStrictEqual(out.actions.map((a) => a.type), ['unmute', 'adEnd']);
  assert.strictEqual(out.state.phase, 'idle');
});

test('alert-only mode reports ads without touching the audio', () => {
  const r = run(
    [
      { t: 0, ad: true },
      { t: 400, ad: true },
      { t: 800, ad: false },
      { t: 1500, ad: false },
    ],
    { muteDuringAds: false }
  );
  assert.deepStrictEqual(r.types, ['adStart', 'adEnd']);
  assert.strictEqual(r.muted, false);
});

test('switching mute-during-ads on mid-break takes effect immediately', () => {
  let state = SM.createState();
  let muted = false;
  const off = D.cloneSettings({ muteDuringAds: false });
  const on = D.cloneSettings({ muteDuringAds: true });

  let out = SM.decide(state, { now: 0, adSignal: true, signals: [], isMuted: muted, settings: off });
  state = out.state;
  out = SM.decide(state, { now: 400, adSignal: true, signals: [], isMuted: muted, settings: on });
  assert.deepStrictEqual(out.actions.map((a) => a.type), ['mute']);
  assert.strictEqual(out.state.mutedByUs, true);
});

test('adStart carries the detectors that fired and the countdown', () => {
  const settings = D.cloneSettings();
  const out = SM.decide(SM.createState(), {
    now: 10,
    adSignal: true,
    signals: ['adTimeIndicator', 'text'],
    remainingSec: 22,
    isMuted: false,
    settings,
  });
  const start = out.actions[0];
  assert.strictEqual(start.type, 'adStart');
  assert.deepStrictEqual(start.signals, ['adTimeIndicator', 'text']);
  assert.strictEqual(start.remainingSec, 22);
});

test('decide never mutates the state object it was given', () => {
  const before = SM.createState();
  const snapshot = JSON.stringify(before);
  SM.decide(before, {
    now: 0,
    adSignal: true,
    signals: [],
    isMuted: false,
    settings: D.cloneSettings(),
  });
  assert.strictEqual(JSON.stringify(before), snapshot);
});

test('accelerate raises the rate on ad start and puts it back on ad end', () => {
  const r = run(
    [
      { t: 0, ad: true },
      { t: 400, ad: true },
      { t: 800, ad: false },
      { t: 1500, ad: false },
    ],
    { adAction: 'accelerate', accelRate: 8 }
  );
  assert.deepStrictEqual(r.types, ['adStart', 'mute', 'setRate', 'unmute', 'restoreRate', 'adEnd']);
  assert.strictEqual(r.log.find((a) => a.type === 'setRate').rate, 8);
});

test('the safety release restores the rate as well as the audio', () => {
  const steps = [];
  for (let t = 0; t <= 700000; t += 100000) steps.push({ t, ad: true });
  const r = run(steps, { adAction: 'accelerate' });
  assert.deepStrictEqual(r.types, ['adStart', 'mute', 'setRate', 'unmute', 'restoreRate', 'adEnd']);
  assert.strictEqual(r.log.find((a) => a.type === 'adEnd').reason, 'timeout');
  assert.strictEqual(r.state.phase, 'stuck');
});

test('turning the extension off mid-ad also restores the rate', () => {
  let state = SM.createState();
  const on = D.cloneSettings({ adAction: 'accelerate' });
  const off = D.cloneSettings({ adAction: 'accelerate', enabled: false });

  let out = SM.decide(state, { now: 0, adSignal: true, signals: [], isMuted: false, settings: on });
  state = out.state;
  assert.ok(out.actions.some((a) => a.type === 'setRate'));

  out = SM.decide(state, { now: 400, adSignal: true, signals: [], isMuted: true, settings: off });
  assert.deepStrictEqual(out.actions.map((a) => a.type), ['unmute', 'restoreRate', 'adEnd']);
});

test('demoting down the fallback ladder mid-break gives the rate straight back', () => {
  // main.js demotes by handing decide() a settings object with adAction:'mute'.
  let state = SM.createState();
  const fast = D.cloneSettings({ adAction: 'accelerate' });
  const demoted = D.cloneSettings({ adAction: 'mute' });

  let out = SM.decide(state, { now: 0, adSignal: true, signals: [], isMuted: false, settings: fast });
  state = out.state;
  assert.strictEqual(state.rateOwnedByUs, true);

  out = SM.decide(state, { now: 400, adSignal: true, signals: [], isMuted: true, settings: demoted });
  assert.deepStrictEqual(out.actions.map((a) => a.type), ['restoreRate']);
  assert.strictEqual(out.state.rateOwnedByUs, false);
  assert.strictEqual(out.state.phase, 'ad', 'the break itself is still running');
});

test('promoting to accelerate mid-break takes effect immediately', () => {
  let state = SM.createState();
  const slow = D.cloneSettings({ adAction: 'mute' });
  const fast = D.cloneSettings({ adAction: 'accelerate', accelRate: 6 });

  let out = SM.decide(state, { now: 0, adSignal: true, signals: [], isMuted: false, settings: slow });
  state = out.state;
  assert.ok(!out.actions.some((a) => a.type === 'setRate'));

  out = SM.decide(state, { now: 400, adSignal: true, signals: [], isMuted: true, settings: fast });
  assert.deepStrictEqual(out.actions.map((a) => a.type), ['setRate']);
  assert.strictEqual(out.actions[0].rate, 6);
});

// --- rate watchdog ---------------------------------------------------------
// Its one hard requirement: the feature is never left running fast.

const WD = { fightLimit: 4 };
const watch = (o) => SM.rateWatchdog(Object.assign({ resetStreak: 0 }, WD, o));

test('watchdog arms the rate when a break starts and the rate is not ours yet', () => {
  assert.deepStrictEqual(watch({ want: true, ourRate: null, actualRate: 1 }), {
    action: 'apply',
    resetStreak: 0,
  });
});

test('watchdog hands the rate back the moment it is no longer wanted', () => {
  for (const actual of [8, 1, 2]) {
    assert.strictEqual(
      watch({ want: false, ourRate: 8, actualRate: actual }).action,
      'restore',
      'a break that ended, a setting change, or a demotion must all restore'
    );
  }
});

test('watchdog re-asserts a per-clip reset inside a pod without demoting', () => {
  let streak = 0;
  for (let i = 0; i < WD.fightLimit - 1; i++) {
    const out = watch({ want: true, ourRate: 8, actualRate: 1, resetStreak: streak });
    assert.strictEqual(out.action, 'reassert');
    streak = out.resetStreak;
  }
  // the clip boundary passes and the rate sticks
  assert.deepStrictEqual(watch({ want: true, ourRate: 8, actualRate: 8, resetStreak: streak }), {
    action: 'none',
    resetStreak: 0,
  });
});

test('watchdog demotes when the player keeps fighting', () => {
  let streak = 0;
  let actions = [];
  for (let i = 0; i < 6; i++) {
    const out = watch({ want: true, ourRate: 8, actualRate: 1, resetStreak: streak });
    streak = out.resetStreak;
    actions.push(out.action);
    if (out.action === 'demote') break;
  }
  assert.deepStrictEqual(actions, ['reassert', 'reassert', 'reassert', 'demote']);
});

test('watchdog does nothing when there is nothing to do', () => {
  assert.strictEqual(watch({ want: false, ourRate: null, actualRate: 1 }).action, 'none');
  assert.strictEqual(watch({ want: true, ourRate: 8, actualRate: 8 }).action, 'none');
});

test('a backgrounded tab that comes back re-arms rather than staying at 1x', () => {
  // decide() will not re-emit setRate while the phase is already 'ad', so this
  // branch is the only thing that recovers a hidden -> visible round trip.
  const out = watch({ want: true, ourRate: null, actualRate: 1, resetStreak: 3 });
  assert.strictEqual(out.action, 'apply');
  assert.strictEqual(out.resetStreak, 0);
});

// --------------------------------------------------------------- exact-stop brake

test('the brake anchors only on the counter decrement edge', () => {
  let s = { adEndAt: null, anchor: null };

  // First sighting anchors: 20s left at t=100 means the break ends at t=120.
  s = SM.anchorAdEnd(s, 20, 100);
  assert.equal(s.adEndAt, 120);
  assert.equal(s.changed, true);

  // Same integer read again 0.4s later must NOT re-anchor — that would drag the
  // target forward every poll and the brake would never fire.
  const same = SM.anchorAdEnd(s, 20, 100.4);
  assert.equal(same.adEndAt, 120);
  assert.equal(same.changed, false);

  // The decrement edge is exact: 19 left at t=101 still ends at 120.
  const edge = SM.anchorAdEnd(s, 19, 101);
  assert.equal(edge.adEndAt, 120);
  assert.equal(edge.changed, true);
});

test('a missing counter leaves the existing target untouched', () => {
  const prev = { adEndAt: 120, anchor: 20 };
  assert.deepEqual(SM.anchorAdEnd(prev, null, 105), {
    adEndAt: 120,
    anchor: 20,
    changed: false,
  });
});

test('the brake fires one epsilon before the boundary, not after', () => {
  const base = { phase: 'ad', ourRate: 12, adEndAt: 120, epsilon: 0.05 };
  assert.equal(SM.shouldBrake({ ...base, mediaTime: 119.0 }), 'continue');
  assert.equal(SM.shouldBrake({ ...base, mediaTime: 119.94 }), 'continue');
  assert.equal(SM.shouldBrake({ ...base, mediaTime: 119.95 }), 'brake');
  assert.equal(SM.shouldBrake({ ...base, mediaTime: 120.5 }), 'brake');
});

test('the brake loop tears down once the break ends or the rate is handed back', () => {
  const at = { adEndAt: 120, mediaTime: 119, epsilon: 0.05 };
  assert.equal(SM.shouldBrake({ ...at, phase: 'idle', ourRate: 12 }), 'stop');
  assert.equal(SM.shouldBrake({ ...at, phase: 'ad', ourRate: null }), 'stop');
});

test('with no target yet the brake waits rather than stopping the loop', () => {
  assert.equal(
    SM.shouldBrake({ phase: 'ad', ourRate: 12, adEndAt: null, mediaTime: 119 }),
    'continue'
  );
});
