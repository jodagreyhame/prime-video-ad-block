'use strict';
/**
 * Integration tests for the DOM probe, against markup shaped like the real
 * Prime Video web player. jsdom has no layout engine, so getBoundingClientRect
 * is stubbed: an element counts as laid out unless it (or an ancestor) is
 * display:none / visibility:hidden / opacity:0.
 */
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const D = require('../src/common/defaults.js');
const SM = require('../src/common/state-machine.js');

const ZERO_RECT = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };

function mount(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const win = dom.window;

  win.Element.prototype.getBoundingClientRect = function () {
    for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
      const s = win.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return ZERO_RECT;
    }
    const w = Number(this.dataset && this.dataset.w) || 320;
    const h = Number(this.dataset && this.dataset.h) || 24;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 };
  };

  global.document = win.document;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.PVAB = { defaults: D, stateMachine: SM };
  delete require.cache[require.resolve('../src/content/detect.js')];
  require('../src/content/detect.js');
  return { win, detect: globalThis.PVAB.detect };
}

const PLAYER = (inner, videoAttrs = '') => `
  <div id="dv-web-player" data-w="1280" data-h="720">
    <div class="rendererContainer" data-w="1280" data-h="720">
      <video ${videoAttrs} data-w="1280" data-h="720"></video>
    </div>
    <div class="atvwebplayersdk-overlays-container" data-w="1280" data-h="720">${inner}</div>
  </div>`;

const probe = (detect, overrides) =>
  detect.probe(
    D.cloneSettings(overrides),
    SM.compilePatterns(D.BUILTIN_TEXT_PATTERNS.concat((overrides || {}).customTextPatterns || []))
  );

test('a page with no player produces no signal', () => {
  const { detect } = mount('<h1>Prime Video</h1>');
  const r = probe(detect);
  assert.strictEqual(r.adSignal, false);
  assert.strictEqual(r.video, null);
});

test('an ordinary playing title produces no signal', () => {
  const { detect } = mount(
    PLAYER(`
      <button class="atvwebplayersdk-skipelements-button">Skip Intro</button>
      <div class="atvwebplayersdk-title-text">Season 2, Episode 4</div>
      <div class="atvwebplayersdk-timeindicator-text">32:10</div>`)
  );
  const r = probe(detect);
  assert.strictEqual(r.adSignal, false, `unexpected signals: ${r.signals}`);
  assert.ok(r.video, 'the player video should still be found');
});

test('the live ad timer is detected and yields the remaining seconds', () => {
  const { detect } = mount(
    PLAYER(`<div class="atvwebplayersdk-ad-timer-container">
              <span class="atvwebplayersdk-ad-timer-ad-text">Ad</span>
              <span class="atvwebplayersdk-ad-timer-remaining-time">0:23</span>
            </div>`)
  );
  const r = probe(detect);
  assert.strictEqual(r.adSignal, true);
  assert.ok(r.signals.includes('adRemaining'), `signals: ${r.signals}`);
  assert.strictEqual(r.remainingSec, 23);
});

test('the A/B variant of the timer class is caught by the prefix match', () => {
  const { detect } = mount(PLAYER('<div class="atvwebplayersdk-ad-timer-text">Ad0:20</div>'));
  const r = probe(detect);
  assert.strictEqual(r.adSignal, true);
  assert.ok(r.signals.includes('adTimer'));
});

test('an empty timer element between breaks is not a signal', () => {
  const { detect } = mount(
    PLAYER('<div class="atvwebplayersdk-ad-timer-remaining-time"></div>')
  );
  assert.strictEqual(probe(detect).adSignal, false);
});

test('a hidden ad label is not a signal', () => {
  const { detect } = mount(
    PLAYER('<div class="atvwebplayersdk-ad-timer-ad-text" style="display:none">Ad</div>')
  );
  assert.strictEqual(probe(detect).adSignal, false);
});

test('a "Skip Ad" button is a signal, a "Skip Intro" button is not', () => {
  const withAd = mount(PLAYER('<button class="atvwebplayersdk-skip-ad-button">Skip Ads</button>'));
  const r = probe(withAd.detect);
  assert.strictEqual(r.adSignal, true);
  assert.ok(r.signals.includes('adSkipButton'));
  assert.ok(withAd.detect.findSkipButton(), 'the button should be clickable');

  const withIntro = mount(
    PLAYER('<button class="atvwebplayersdk-skipelement-button">Skip Intro</button>')
  );
  assert.strictEqual(probe(withIntro.detect).adSignal, false);
  assert.strictEqual(withIntro.detect.findSkipButton(), null);
});

test('the permanent ad-free upsell button never counts as an ad', () => {
  // AD_TOKEN matches "atvwebplayersdk-go-ad-free-button", so without the
  // denylist the heuristic path would fire on every frame of every title.
  const html = PLAYER(
    '<button class="atvwebplayersdk-go-ad-free-button" data-w="120">Go ad free</button>'
  );
  const { detect } = mount(html);
  assert.strictEqual(probe(detect).adSignal, false);
  assert.strictEqual(probe(detect, { useHeuristicClassSignal: true }).adSignal, false);
  assert.strictEqual(
    probe(detect, { customSelectors: ['.atvwebplayersdk-go-ad-free-button'] }).adSignal,
    false,
    'the denylist must beat a user-supplied selector too'
  );
});

test('the CSS-hidden ad-resume message never produces a selector signal', () => {
  // It reports a non-zero rect while hidden, so the denylist - not visibility -
  // is what keeps it out. jsdom has no innerText, so the last-resort text net
  // still reads its copy here; in Chrome innerText skips hidden subtrees.
  const { detect } = mount(
    PLAYER('<div class="atvwebplayersdk-ad-resume-message">Your video continues here after</div>')
  );
  const r = probe(detect);
  assert.ok(
    !r.signals.some((id) => id !== 'text'),
    `expected no selector signal, got: ${r.signals}`
  );
});

test('overlay text catches an ad break when no known selector matches', () => {
  const { detect } = mount(PLAYER('<div class="renamed-by-amazon">Ad0:12</div>'));
  const r = probe(detect);
  assert.deepStrictEqual(r.signals, ['text']);
  assert.strictEqual(r.remainingSec, 12);
  assert.ok(r.evidence.textPattern);
});

test('overlay text still catches a non-English break after a full rename', () => {
  const { detect } = mount(PLAYER('<div class="hashed-classname">Anuncio0:20</div>'));
  const r = probe(detect);
  assert.deepStrictEqual(r.signals, ['text']);
  assert.strictEqual(r.remainingSec, 20);
});

test('a custom selector rescues detection after a rename', () => {
  const html = PLAYER('<div class="xyz-ad-slot-2026" data-w="90" data-h="20">&nbsp;</div>');
  const { detect } = mount(html);
  assert.strictEqual(probe(detect).adSignal, false);

  const r = probe(detect, { customSelectors: ['.xyz-ad-slot-2026'] });
  assert.strictEqual(r.adSignal, true);
  assert.deepStrictEqual(r.signals, ['custom:.xyz-ad-slot-2026']);
});

test('the broad class heuristic is off by default and opt-in', () => {
  const html = PLAYER('<div class="adOverlayThing" data-w="80" data-h="20">&nbsp;</div>');
  const { detect } = mount(html);
  assert.strictEqual(probe(detect).adSignal, false);
  const on = probe(detect, { useHeuristicClassSignal: true });
  assert.strictEqual(on.adSignal, true);
  assert.deepStrictEqual(on.signals, ['heuristicClass']);
});

test('the heuristic still ignores non-ad class names like "download"', () => {
  const { detect } = mount(PLAYER('<div class="downloadButton" data-w="80" data-h="20">Download</div>'));
  assert.strictEqual(probe(detect, { useHeuristicClassSignal: true }).adSignal, false);
});

test('mute state is read from the player video element', () => {
  const audible = mount(PLAYER(''));
  assert.strictEqual(probe(audible.detect).isMuted, false);

  // jsdom does not reflect the `muted` content attribute onto the IDL property,
  // so set it the way the player (and we) actually do.
  const muted = mount(PLAYER(''));
  muted.detect.findVideo().muted = true;
  assert.strictEqual(probe(muted.detect).isMuted, true);

  const silent = mount(PLAYER(''));
  silent.detect.findVideo().volume = 0;
  assert.strictEqual(probe(silent.detect).isMuted, true);
});

test('the largest video wins when hover previews are also on the page', () => {
  const { detect } = mount(`
    <video id="preview" data-w="240" data-h="135"></video>
    ${PLAYER('')}
    <video id="preview2" data-w="180" data-h="100"></video>`);
  const v = detect.findVideo();
  assert.strictEqual(v.getBoundingClientRect().width, 1280);
});

test('probe + decide together mute an ad break end to end', () => {
  const { detect, win } = mount(
    PLAYER('<div class="atvwebplayersdk-ad-timer-remaining-time">0:09</div>')
  );
  const settings = D.cloneSettings();
  const patterns = SM.compilePatterns(D.BUILTIN_TEXT_PATTERNS);
  let state = SM.createState();
  const video = detect.findVideo();

  const tick = (now) => {
    const p = detect.probe(settings, patterns);
    const out = SM.decide(state, {
      now,
      adSignal: p.adSignal,
      signals: p.signals,
      remainingSec: p.remainingSec,
      isMuted: p.isMuted,
      settings,
    });
    state = out.state;
    for (const a of out.actions) {
      if (a.type === 'mute') video.muted = true;
      if (a.type === 'unmute') video.muted = false;
    }
    return out.actions.map((a) => a.type);
  };

  assert.deepStrictEqual(tick(0), ['adStart', 'mute']);
  assert.strictEqual(video.muted, true);

  // ad ends: Prime removes the countdown label
  win.document.querySelector('.atvwebplayersdk-ad-timer-remaining-time').remove();
  assert.deepStrictEqual(tick(400), []); // inside the unmute grace window
  assert.strictEqual(video.muted, true);
  assert.deepStrictEqual(tick(1000), ['unmute', 'adEnd']);
  assert.strictEqual(video.muted, false);
});

test('probe + decide accelerate and then restore the playback rate', () => {
  const { detect, win } = mount(
    PLAYER('<div class="atvwebplayersdk-ad-timer-remaining-time">0:30</div>')
  );
  const settings = D.cloneSettings({ adAction: 'accelerate', accelRate: 8 });
  const patterns = SM.compilePatterns(D.BUILTIN_TEXT_PATTERNS);
  const video = detect.findVideo();
  let state = SM.createState();
  let rate = 1;

  const tick = (now) => {
    const p = detect.probe(settings, patterns);
    const out = SM.decide(state, {
      now,
      adSignal: p.adSignal,
      signals: p.signals,
      remainingSec: p.remainingSec,
      isMuted: p.isMuted,
      settings,
    });
    state = out.state;
    for (const a of out.actions) {
      if (a.type === 'mute') video.muted = true;
      if (a.type === 'unmute') video.muted = false;
      if (a.type === 'setRate') rate = a.rate;
      if (a.type === 'restoreRate') rate = 1;
    }
    return out.actions.map((a) => a.type);
  };

  assert.deepStrictEqual(tick(0), ['adStart', 'mute', 'setRate']);
  assert.strictEqual(rate, 8);

  win.document.querySelector('.atvwebplayersdk-ad-timer-remaining-time').remove();
  assert.deepStrictEqual(tick(1000), [], 'inside the unmute grace window');
  assert.strictEqual(rate, 8);
  assert.deepStrictEqual(tick(1600), ['unmute', 'restoreRate', 'adEnd']);
  assert.strictEqual(rate, 1, 'the film must never be left running fast');
  assert.strictEqual(video.muted, false);
});
