'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SM = require('../src/common/state-machine.js');
const D = require('../src/common/defaults.js');

const patterns = SM.compilePatterns(D.BUILTIN_TEXT_PATTERNS);

test('parseAdRemaining reads Prime countdown labels', () => {
  assert.strictEqual(SM.parseAdRemaining('Ad0:20'), 20); // the live timer shape
  assert.strictEqual(SM.parseAdRemaining('Anuncio1:05'), 65);
  assert.strictEqual(SM.parseAdRemaining('Your program resumes in 23 sec'), 23);
  assert.strictEqual(SM.parseAdRemaining('Your video will resume in 5 seconds'), 5);
  assert.strictEqual(SM.parseAdRemaining('8s'), 8);
  assert.strictEqual(SM.parseAdRemaining('0:23'), 23);
  assert.strictEqual(SM.parseAdRemaining('1:05'), 65);
  assert.strictEqual(SM.parseAdRemaining(''), null);
  assert.strictEqual(SM.parseAdRemaining(null), null);
  assert.strictEqual(SM.parseAdRemaining('Skip Intro'), null);
});

test('built-in text patterns match real ad overlay copy', () => {
  const positives = [
    // the live timer, en-US and the locales that kept detection alive
    'Ad0:20',
    'Ad 0:20',
    'Anuncio0:20',
    'Publicidad 1:05',
    'Werbung0:15',
    // other copy the player shows during a break
    'Fast forward and rewind unavailable during ads',
    'Your video continues here after',
    // legacy nets, unobserved in the current build but harmless
    'Ad 1 of 3',
    'Your program resumes in 14 sec',
  ];
  for (const text of positives) {
    assert.ok(SM.matchTextPatterns(text, patterns), `expected a match for: ${text}`);
  }
});

test('built-in text patterns do not fire on ordinary player copy', () => {
  const negatives = [
    'Skip Intro',
    'Skip Recap',
    'Next episode in 10 sec',
    'Season 2, Episode 4 — Download',
    'Audio and Subtitles',
    'X-Ray',
    'Paid for by advertisers of tomorrow',
    // the traps the live "Ad0:20" shape creates: a word ending in "ad" or
    // containing it, immediately followed by a clock.
    'Add 0:20',
    'Loaded 1:05',
    'Upload 0:30',
    '32:10',
    'Downloads',
  ];
  for (const text of negatives) {
    assert.strictEqual(
      SM.matchTextPatterns(text, patterns),
      null,
      `unexpected match for: ${text}`
    );
  }
});

test('compilePatterns skips invalid user regexes instead of throwing', () => {
  const compiled = SM.compilePatterns(['valid', '([unclosed', 'also valid']);
  assert.strictEqual(compiled.length, 2);
});

test('formatDuration is human readable', () => {
  assert.strictEqual(SM.formatDuration(4000), '4s');
  assert.strictEqual(SM.formatDuration(95000), '1m 35s');
});

test('the ad-class heuristic token regex is not fooled by ordinary class names', () => {
  // Mirrors src/content/detect.js AD_TOKEN.
  const AD_TOKEN = /(?:^|[\s_-])ads?(?:[\s_-]|[A-Z]|$)/;
  for (const cls of ['adBadge', 'ad-timer', 'ads_slot', 'player ad', 'ad']) {
    assert.ok(AD_TOKEN.test(cls), `expected ad-ish: ${cls}`);
  }
  for (const cls of ['download', 'header', 'loading', 'adaptive', 'thread-add']) {
    assert.strictEqual(AD_TOKEN.test(cls), false, `expected not ad-ish: ${cls}`);
  }
});

test('the "Ad0:20" shape defeats the obvious word-boundary regex', () => {
  // Why BUILTIN_TEXT_PATTERNS does not use \\bad\\b: the digits abut the word.
  assert.strictEqual(/\bad\b\s*\d{1,2}:\d{2}/i.test('Ad0:20'), false);
  assert.ok(SM.matchTextPatterns('Ad0:20', patterns), 'the shipped pattern must still match');
});

test('every shipped selector signal targets the live ad-timer family', () => {
  const dead = [
    'adtimeindicator',
    'adbadge',
    'adCountDown',
    'data-testid="ad-',
    'adPlaybackContainer',
    'ad-marker',
  ];
  const all = D.BUILTIN_SELECTOR_SIGNALS.map((s) => s.selector).join(' ');
  for (const gone of dead) {
    assert.ok(!all.includes(gone), `${gone} has zero occurrences in the shipping player`);
  }
  assert.ok(all.includes('atvwebplayersdk-ad-timer'));
});
