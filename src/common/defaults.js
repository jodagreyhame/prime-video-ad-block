/**
 * Prime Video Ad Block — shared defaults.
 *
 * Loaded three ways, so it stays dependency-free and UMD-ish:
 *   - as a classic content script  -> globalThis.PVAB.defaults
 *   - as a <script> on the options/popup pages
 *   - as a CommonJS module in the Node tests
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PVAB = root.PVAB || {};
    root.PVAB.defaults = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  /** Prime's own skip button, when a pod happens to carry a skip offset. */
  const SKIP_AD_SELECTOR =
    '.atvwebplayersdk-skip-ad-button, #atvwebplayersdk-skip-ad-button';

  const DEFAULT_SETTINGS = {
    // master switch
    enabled: true,

    // what to do about an ad break
    adAction: 'mute', // 'mute' (safe default) | 'accelerate'
    accelRate: 8, // playbackRate during a break; Chromium throws above 16
    clickNativeSkip: true, // click Prime's own Skip Ad button when it renders

    // muting
    muteDuringAds: true,
    muteTarget: 'video', // 'video' | 'tab' | 'both'
    muteDelayMs: 0, // wait this long after an ad signal before muting
    unmuteDelayMs: 500, // wait this long after the signal clears before unmuting
    maxAdMuteMs: 600000, // safety valve: never stay muted longer than this (10 min)
    respectManualUnmute: true, // if you unmute by hand mid-ad, stop fighting you

    // alerts
    showToast: true, // in-page badge over the player
    toastCountdown: true, // include "resumes in Ns" when Prime tells us
    chimeOnAdEnd: false, // short WebAudio tone when the show comes back
    chimeOnAdStart: false,
    notifyOnAdStart: false, // desktop notification (needs optional permission)
    notifyOnAdEnd: false,
    badge: true, // "AD" on the toolbar icon

    // detection
    pollMs: 400,
    adPollMs: 100, // faster ticking during a break: at 8x, 400ms of lag costs 3.2s of feature
    useHeuristicClassSignal: false, // broad [class*=ad] scan; more reach, more false positives
    customSelectors: [], // extra CSS selectors that mean "an ad is on screen"
    customTextPatterns: [], // extra regex sources matched against player overlay text

    // diagnostics
    debug: false,
    showHud: false, // the live readout pinned over the player; independent of console logging
  };

  /**
   * Built-in DOM signals. Any visible match means "ad playing".
   *
   * These target the `atvwebplayersdk-ad-timer-*` family that ships in the
   * current player. The previous generation (`-adtimeindicator-text`,
   * `-adbadge-text`, `.adSkipButton`, `[data-testid="ad-*"]`) has zero
   * occurrences in the shipping bundle.
   *
   * Two things can still blind every selector here, so treat detection as
   * best-effort rather than guaranteed:
   *   - the ad-timer subtree only mounts when the VAST sets `showCountdownTimer`,
   *     a per-ad server field;
   *   - a second player UI ships with hashed CSS-module classnames and no
   *     `atvwebplayersdk-ad-*` hooks at all.
   */
  const BUILTIN_SELECTOR_SIGNALS = [
    // Prefix-match the family: Amazon A/B-tests -ad-timer-text against
    // -ad-timer-remaining-time and both ship in the same bundle today.
    // requireText also guards the container: textContent includes descendants,
    // so a mounted-but-empty timer between breaks is not a signal.
    { id: 'adTimer', selector: '[class*="atvwebplayersdk-ad-timer"]', requireText: true },
    { id: 'adRemaining', selector: '.atvwebplayersdk-ad-timer-remaining-time', requireText: true },
    { id: 'adText', selector: '.atvwebplayersdk-ad-timer-ad-text', requireText: true },
    { id: 'adSkipButton', selector: SKIP_AD_SELECTOR },
    { id: 'adAria', selector: '[aria-label*="playing ad" i]' },
  ];

  /**
   * Never treat these as an ad signal: permanent chrome, CSS-hidden elements
   * that still report a box, or the skip-INTRO button.
   */
  const SELECTOR_DENYLIST = [
    '.atvwebplayersdk-go-ad-free-button', // the ad-free upsell, always present
    '.atvwebplayersdk-ad-resume-message', // non-zero rect while CSS-hidden
    '.atvwebplayersdk-skipelement-button', // skip INTRO / RECAP, not ads
    '.atvwebplayersdk-skipelements-button',
  ];

  /**
   * Text that appears on the player overlay during an ad break.
   *
   * The live timer renders as "Ad0:20" — note the digits abut the word, so the
   * obvious `\bad\b\s*\d+:\d\d` does NOT match it. The locale alternation is
   * what has kept detection alive outside en-US.
   */
  const BUILTIN_TEXT_PATTERNS = [
    // "Ad0:20", "Ad 0:20", "Anuncio0:20", "Publicidad 1:05", "Werbung0:15"
    '(?:^|[^a-z])(?:ad|anuncio|publicidad|werbung|publicit\u00e9|pubblicit\u00e0|reclame|reklam)' +
      '[^0-9a-z]{0,3}\\d{1,2}:\\d{2}',
    'fast forward and rewind unavailable during ads', // avod.seekingUnavailable
    'your video continues here after', // avod.newPositionHint
    // Older pod-position and countdown copy. Kept as a net for the case where
    // every selector has been renamed; both are unobserved in the current build.
    '(?:^|[^a-z])ads?\\s*\\d+\\s*(?:of|/)\\s*\\d+',
    'your (?:program|video|show|movie|title)\\s+(?:will\\s+)?resumes?\\s+in',
  ];

  /** Containers we are willing to read text out of (keeps text matching scoped). */
  const PLAYER_CONTAINERS = [
    '#dv-web-player',
    '.webPlayerUIContainer',
    '.atvwebplayersdk-overlays-container',
    '.atvwebplayersdk-player-container',
    '[data-testid="video-player"]',
    '.dv-player-fullscreen',
    '.rendererContainer',
  ];

  function cloneSettings(overrides) {
    return Object.assign({}, DEFAULT_SETTINGS, overrides || {});
  }

  return {
    DEFAULT_SETTINGS,
    SKIP_AD_SELECTOR,
    BUILTIN_SELECTOR_SIGNALS,
    SELECTOR_DENYLIST,
    BUILTIN_TEXT_PATTERNS,
    PLAYER_CONTAINERS,
    cloneSettings,
  };
});
