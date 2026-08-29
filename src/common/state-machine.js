/**
 * Prime Video Ad Block — pure ad-state machine.
 *
 * No DOM, no chrome.* — everything here is a pure function of (state, input),
 * which is what makes the mute/unmute behaviour testable without a browser.
 *
 * Phases:
 *   idle  — no ad signal
 *   ad    — ad signal confirmed; we may be holding the mute
 *   stuck — an ad signal has been stuck on for longer than maxAdMuteMs; we bail
 *           out and refuse to re-arm until the signal actually clears, so a
 *           renamed/misconfigured selector can never mute a whole film.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PVAB = root.PVAB || {};
    root.PVAB.stateMachine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  function createState() {
    return {
      phase: 'idle',
      signalSince: null, // when the ad signal first appeared
      goneSince: null, // when the ad signal first went away
      adStartedAt: null,
      signals: [], // which detectors fired for the current ad
      mutedByUs: false, // we own the current mute and must give it back
      rateOwnedByUs: false, // we raised playbackRate and must put it back
      handsOff: false, // user was already muted, or unmuted by hand: don't touch
      didMute: false, // did we mute at any point during this break (for stats)
    };
  }

  /**
   * @param {object} prev   previous state (from createState)
   * @param {object} input  { now, adSignal, signals, remainingSec, isMuted, settings }
   * @returns {{state: object, actions: Array<object>}}
   */
  function decide(prev, input) {
    const s = Object.assign({}, prev);
    const actions = [];
    const now = input.now;
    const settings = input.settings;
    const isMuted = !!input.isMuted;

    const endAd = (reason) => {
      if (s.mutedByUs) actions.push({ type: 'unmute', reason: reason });
      if (s.rateOwnedByUs) actions.push({ type: 'restoreRate', reason: reason });
      actions.push({
        type: 'adEnd',
        reason: reason,
        durationMs: s.adStartedAt == null ? 0 : now - s.adStartedAt,
        muted: s.didMute,
        signals: s.signals,
      });
    };

    // Master switch off (or turned off mid-ad): hand the audio back and reset.
    if (!settings.enabled) {
      if (s.phase === 'ad') endAd('disabled');
      return { state: createState(), actions: actions };
    }

    if (input.adSignal) {
      s.goneSince = null;
      if (s.signalSince == null) s.signalSince = now;

      if (s.phase === 'stuck') {
        return { state: s, actions: actions }; // wait for the signal to clear
      }

      if (s.phase === 'idle') {
        if (now - s.signalSince < (settings.muteDelayMs || 0)) {
          return { state: s, actions: actions };
        }
        s.phase = 'ad';
        s.adStartedAt = now;
        s.signals = input.signals || [];
        s.mutedByUs = false;
        s.didMute = false;
        s.handsOff = false;
        actions.push({
          type: 'adStart',
          signals: s.signals,
          remainingSec: input.remainingSec == null ? null : input.remainingSec,
        });
        if (settings.muteDuringAds) {
          if (isMuted) {
            // Already silent before the ad — leave it exactly as we found it.
            s.handsOff = true;
          } else {
            actions.push({ type: 'mute' });
            s.mutedByUs = true;
            s.didMute = true;
          }
        }
        if (settings.adAction === 'accelerate') {
          actions.push({ type: 'setRate', rate: settings.accelRate });
          s.rateOwnedByUs = true;
        }
        return { state: s, actions: actions };
      }

      // phase === 'ad'
      if (settings.maxAdMuteMs > 0 && now - s.adStartedAt >= settings.maxAdMuteMs) {
        endAd('timeout');
        const stuck = createState();
        stuck.phase = 'stuck';
        stuck.signalSince = s.signalSince;
        return { state: stuck, actions: actions };
      }

      if (settings.muteDuringAds && !s.handsOff) {
        if (s.mutedByUs && !isMuted) {
          if (settings.respectManualUnmute) {
            s.mutedByUs = false;
            s.handsOff = true;
            actions.push({ type: 'userOverride' });
          } else {
            actions.push({ type: 'mute' }); // player reset the flag; take it back
          }
        } else if (!s.mutedByUs && !isMuted) {
          // muteDuringAds was switched on mid-break.
          actions.push({ type: 'mute' });
          s.mutedByUs = true;
          s.didMute = true;
        }
      }

      // The action can change mid-break: the viewer flips the setting, or the
      // content script demotes itself down the fallback ladder.
      if (settings.adAction === 'accelerate' && !s.rateOwnedByUs) {
        actions.push({ type: 'setRate', rate: settings.accelRate });
        s.rateOwnedByUs = true;
      } else if (settings.adAction !== 'accelerate' && s.rateOwnedByUs) {
        actions.push({ type: 'restoreRate', reason: 'action changed' });
        s.rateOwnedByUs = false;
      }
      return { state: s, actions: actions };
    }

    // ---- no ad signal ----
    s.signalSince = null;

    if (s.phase === 'stuck') {
      return { state: createState(), actions: actions };
    }

    if (s.phase === 'ad') {
      if (s.goneSince == null) s.goneSince = now;
      if (now - s.goneSince >= (settings.unmuteDelayMs || 0)) {
        endAd('clear');
        return { state: createState(), actions: actions };
      }
    }

    return { state: s, actions: actions };
  }

  /**
   * Pull "seconds until the show resumes" out of Prime's countdown label.
   * Handles "Your program resumes in 23 sec", "23s", "0:23", "1:05".
   */
  /**
   * Should the exact-stop brake hand the rate back on this frame?
   *
   * Pure so the boundary condition is testable without a media element.
   *
   * @param {object} i { phase, ourRate, adEndAt, mediaTime, epsilon }
   * @returns {'brake'|'continue'|'stop'} 'stop' = tear the loop down, nothing to do
   */
  function shouldBrake(i) {
    if (i.phase !== 'ad' || i.ourRate == null) return 'stop';
    if (i.adEndAt == null || typeof i.mediaTime !== 'number') return 'continue';
    return i.mediaTime >= i.adEndAt - (i.epsilon || 0) ? 'brake' : 'continue';
  }

  /**
   * Re-anchor the end-of-break prediction, but only on the counter's decrement
   * edge — a single reading of an integer counter is a second wide, its
   * transition is exact.
   *
   * @returns {{adEndAt:number|null, anchor:number|null, changed:boolean}}
   */
  function anchorAdEnd(prev, remainingSec, currentTime) {
    if (remainingSec == null || typeof currentTime !== 'number') {
      return { adEndAt: prev.adEndAt, anchor: prev.anchor, changed: false };
    }
    if (remainingSec === prev.anchor) {
      return { adEndAt: prev.adEndAt, anchor: prev.anchor, changed: false };
    }
    return { adEndAt: currentTime + remainingSec, anchor: remainingSec, changed: true };
  }

  function parseAdRemaining(text) {
    if (!text) return null;
    const t = String(text);

    const clock = t.match(/(\d{1,2}):(\d{2})/);
    if (clock) return parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);

    const resumes = t.match(/resumes?\s+in\s+(\d{1,4})/i);
    if (resumes) return parseInt(resumes[1], 10);

    const secs = t.match(/(\d{1,4})\s*(?:s|sec|secs|second|seconds)\b/i);
    if (secs) return parseInt(secs[1], 10);

    return null;
  }

  /** Compile pattern sources once; invalid user regexes are skipped, not thrown. */
  function compilePatterns(sources) {
    const out = [];
    (sources || []).forEach(function (src) {
      if (!src) return;
      try {
        out.push(src instanceof RegExp ? src : new RegExp(src, 'i'));
      } catch (e) {
        /* ignore a bad user-supplied pattern */
      }
    });
    return out;
  }

  function matchTextPatterns(text, patterns) {
    if (!text) return null;
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text)) return patterns[i].source;
    }
    return null;
  }

  /**
   * The rate watchdog's decision, kept pure for the same reason decide() is:
   * its one hard requirement — never leave the feature running fast — deserves
   * tests, and it must work even when the state machine itself is wedged.
   *
   * @param {object} input { want, ourRate, actualRate, resetStreak, fightLimit, targetRate }
   * @returns {{action:'none'|'restore'|'reassert'|'apply'|'demote', resetStreak:number}}
   */
  function rateWatchdog(input) {
    const ours = input.ourRate;
    const streak = input.resetStreak || 0;

    // Not wanted any more (break ended, setting changed, ladder demoted).
    if (ours != null && !input.want) return { action: 'restore', resetStreak: 0 };

    if (ours != null && input.actualRate !== ours) {
      const next = streak + 1;
      // One reset per clip is normal in a multi-ad pod; sustained resetting
      // means the player is actively fighting us and we should stand down.
      if (next >= input.fightLimit) return { action: 'demote', resetStreak: next };
      return { action: 'reassert', resetStreak: next };
    }

    if (ours != null) return { action: 'none', resetStreak: 0 };

    // Re-arm: this is what makes a hidden -> visible round trip correct, since
    // decide() will not re-emit setRate while the phase is already 'ad'.
    if (input.want) return { action: 'apply', resetStreak: 0 };

    return { action: 'none', resetStreak: 0 };
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? m + 'm ' + s + 's' : s + 's';
  }

  return {
    createState,
    decide,
    rateWatchdog,
    shouldBrake,
    anchorAdEnd,
    parseAdRemaining,
    compilePatterns,
    matchTextPatterns,
    formatDuration,
  };
});
