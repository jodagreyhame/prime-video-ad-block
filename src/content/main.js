/**
 * Prime Video Ad Block — content controller.
 *
 * Loop: probe the DOM -> pure decide() -> apply actions (mute, toast, chime,
 * notification, badge, stats). All policy lives in the state machine; this file
 * only knows how to *do* things.
 */
(function (root) {
  'use strict';
  const PVAB = root.PVAB;
  if (!PVAB || !PVAB.detect) return;
  const D = PVAB.defaults;
  const SM = PVAB.stateMachine;
  const DET = PVAB.detect;

  const IDLE_POLL_MS = 2000; // no <video> on the page yet

  let settings = D.cloneSettings();
  let patterns = SM.compilePatterns(D.BUILTIN_TEXT_PATTERNS);
  let state = SM.createState();
  let timer = null;
  let timerMs = 0;
  let tabMuted = false; // mirrored from the background page
  let lastProbe = null;
  let audioCtx = null;

  // Rate control. `ourRate` is the sentinel: restore keys on it rather than on
  // detection, so a selector rename can never strand the film at 8x.
  let ourRate = null;
  let savedRate = null;
  let rateResetStreak = 0; // consecutive watchdog ticks where the player fought us
  let demoted = false; // fallback ladder: accelerate -> mute, for this page load
  let lastSkipClickAt = 0;

  // Exact-stop brake. The DOM poll is wall-clock; the cost of its lag is paid in
  // stream time, so at 12x a 100ms tick overshoots the end of the break by 1.2s
  // of feature. SSAI puts ads and feature on one continuous timeline, so
  // video.currentTime is authoritative: a break reporting R seconds left ends at
  // currentTime + R. We ride that number instead of waiting for the poll.
  let adEndAt = null; // currentTime (stream seconds) at which the break ends
  let anchorRemaining = null; // last displayed integer we anchored against
  let brakeHandle = null;
  // One frame of slack. rVFC fires per *presented* frame, so its granularity is
  // frame-rate bound in stream time no matter what rate we set.
  const BRAKE_EPSILON = 0.05;

  const WATCHDOG_MS = 500;
  // One reset per ad clip is normal in a multi-ad pod and is simply re-asserted.
  // Sustained resetting (~2s of them) means the player is actively fighting us.
  const RATE_FIGHT_LIMIT = 4;

  function log() {
    if (!settings.debug) return;
    const args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[PVAB]'].concat(args));
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        void chrome.runtime.lastError; // background may be asleep; harmless
      });
    } catch (e) {
      /* extension context invalidated on reload */
    }
  }

  // ---------------------------------------------------------------- settings
  function recompile() {
    patterns = SM.compilePatterns(
      D.BUILTIN_TEXT_PATTERNS.concat(settings.customTextPatterns || [])
    );
  }

  function loadSettings(cb) {
    try {
      chrome.storage.sync.get(D.DEFAULT_SETTINGS, function (stored) {
        settings = D.cloneSettings(stored);
        recompile();
        if (cb) cb();
      });
    } catch (e) {
      if (cb) cb();
    }
  }

  // ------------------------------------------------------------------ muting
  function wantVideoMute() {
    return settings.muteTarget === 'video' || settings.muteTarget === 'both';
  }
  function wantTabMute() {
    return settings.muteTarget === 'tab' || settings.muteTarget === 'both';
  }

  /**
   * Every video element we might be holding. After an SPA navigation the probe's
   * element can be detached while the watchdog is acting on a fresh one — hand
   * back to both, or the old film is stranded muted or at 8x.
   */
  function heldVideos() {
    const out = [];
    const fresh = DET.findVideo();
    if (fresh) out.push(fresh);
    const stale = lastProbe && lastProbe.video;
    if (stale && stale !== fresh) out.push(stale);
    return out;
  }

  function applyMute(on) {
    if (wantVideoMute()) {
      heldVideos().forEach(function (v) {
        try {
          v.muted = on;
        } catch (e) {
          /* ignore */
        }
      });
    }
    if (wantTabMute()) {
      tabMuted = on;
      send({ type: 'setTabMuted', muted: on });
    }
    log(on ? 'muted' : 'unmuted', settings.muteTarget);
  }

  /** What the state machine should treat as "audio is currently silenced". */
  function observedMuted(probe) {
    if (wantVideoMute() && probe.video) return !!(probe.video.muted || probe.video.volume === 0);
    if (wantTabMute()) return tabMuted;
    return false;
  }

  /**
   * Settings as the state machine should see them: the fallback ladder demotes
   * `accelerate` to `mute` for the rest of this page load, without touching
   * what the viewer saved.
   */
  function effectiveSettings() {
    if (!demoted || settings.adAction !== 'accelerate') return settings;
    return Object.assign({}, settings, { adAction: 'mute' });
  }

  function applyRate(rate) {
    const v = DET.findVideo();
    if (!v) return;
    if (ourRate === null) savedRate = v.playbackRate || 1;
    try {
      // Chromium THROWS NotSupportedError out of range and keeps the previous
      // value — it does not clamp, so a bad setting silently leaves you at 1x.
      v.playbackRate = rate;
      ourRate = rate;
      rateResetStreak = 0;
      log('rate ->', rate);
      startBrake(v);
    } catch (e) {
      ourRate = null;
      log('rate rejected', e && e.message);
      demote('the browser rejected playbackRate ' + rate);
    }
  }

  function restoreRate() {
    heldVideos().forEach(function (v) {
      try {
        v.playbackRate = savedRate || 1;
      } catch (e) {
        /* element gone */
      }
    });
    ourRate = null;
    rateResetStreak = 0;
  }

  /**
   * Re-anchor the predicted end of the break.
   *
   * The displayed counter is an integer, so a single reading is only good to
   * within a second. Its *decrement edge*, though, is exact: the instant the
   * text changes from 21 to 20 there really are 20 seconds left. So we re-anchor
   * only on change, and every edge sharpens the estimate for the rest of the pod.
   */
  function updateAdEndEstimate(probe) {
    const v = probe.video;
    if (!v) return;
    const next = SM.anchorAdEnd(
      { adEndAt: adEndAt, anchor: anchorRemaining },
      probe.remainingSec,
      v.currentTime
    );
    adEndAt = next.adEndAt;
    anchorRemaining = next.anchor;
    if (next.changed) {
      log('end estimate ->', adEndAt.toFixed(2), '(' + probe.remainingSec + 's left)');
    }
  }

  function clearAdEndEstimate() {
    adEndAt = null;
    anchorRemaining = null;
    brakeHandle = null;
  }

  /**
   * Ride the video clock down to adEndAt and hand the rate back the moment we
   * cross it — before the poll would have noticed.
   *
   * Deliberately only touches the *rate*. Unmuting stays signal-driven: braking
   * early costs a second of ad at 1x (silent, harmless), whereas unmuting early
   * would play ad audio, which is the one thing this extension exists to prevent.
   */
  function startBrake(v) {
    if (brakeHandle !== null) return;
    if (typeof v.requestVideoFrameCallback !== 'function') return; // poll covers it
    const step = function (now, meta) {
      brakeHandle = null;
      const t = meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : v.currentTime;
      const verdict = SM.shouldBrake({
        phase: state.phase,
        ourRate: ourRate,
        adEndAt: adEndAt,
        mediaTime: t,
        epsilon: BRAKE_EPSILON,
      });
      if (verdict === 'stop') return;
      if (verdict === 'brake') {
        restoreRate();
        log('braked at', t.toFixed(2), 'target', adEndAt.toFixed(2));
        return;
      }
      brakeHandle = v.requestVideoFrameCallback(step);
    };
    brakeHandle = v.requestVideoFrameCallback(step);
  }

  /** Drop one rung down the fallback ladder. Never persisted. */
  function demote(reason) {
    if (demoted) return;
    demoted = true;
    restoreRate();
    log('demoted to mute:', reason);
    showToast('Ad muted', 'speed-up unavailable', false, 3000);
  }

  /**
   * Rate watchdog, deliberately independent of decide(): it survives a selector
   * rename, a torn-down media element, a stuck state machine and a backgrounded
   * tab. There is intentionally no visibilitychange handler — restoring there
   * would strand the ad at 1x. SM.rateWatchdog holds the policy; this applies it.
   */
  function rateWatchdog() {
    const v = DET.findVideo();
    if (!v) return;
    const out = SM.rateWatchdog({
      want: state.phase === 'ad' && effectiveSettings().adAction === 'accelerate',
      ourRate: ourRate,
      actualRate: v.playbackRate,
      resetStreak: rateResetStreak,
      fightLimit: RATE_FIGHT_LIMIT,
    });
    rateResetStreak = out.resetStreak;
    switch (out.action) {
      case 'restore':
        restoreRate();
        break;
      case 'reassert':
        try {
          v.playbackRate = ourRate; // per-clip reset inside a pod
        } catch (e) {
          demote('playbackRate rejected on re-assert');
        }
        break;
      case 'demote':
        demote('the player kept resetting playbackRate');
        break;
      case 'apply':
        applyRate(settings.accelRate);
        break;
    }
  }

  /** Prime's own Skip Ad button, when a pod happens to carry a skip offset. */
  function clickNativeSkip(now) {
    if (!settings.clickNativeSkip) return;
    if (now - lastSkipClickAt < 1500) return;
    const btn = DET.findSkipButton();
    if (!btn) return;
    lastSkipClickAt = now;
    try {
      btn.click();
      log('clicked the native Skip Ad button');
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------- toast
  let toastHost = null;
  let toastShadow = null;
  let toastEl = null;
  let toastHideAt = 0;

  const TOAST_CSS = [
    ':host { all: initial; }',
    '.box {',
    '  position: fixed; top: 5.5vh; left: 50%; transform: translateX(-50%);',
    '  z-index: 2147483647; pointer-events: none;',
    '  display: flex; align-items: center; gap: 10px;',
    '  padding: 10px 16px; border-radius: 999px;',
    '  background: rgba(12,17,22,.86); color: #fff;',
    '  font: 600 14px/1.2 "Amazon Ember", system-ui, -apple-system, Segoe UI, Roboto, sans-serif;',
    '  box-shadow: 0 6px 24px rgba(0,0,0,.45);',
    '  border: 1px solid rgba(255,255,255,.14);',
    '  opacity: 0; transition: opacity .18s ease;',
    '  -webkit-font-smoothing: antialiased;',
    '}',
    '.box.show { opacity: 1; }',
    '.dot { width: 9px; height: 9px; border-radius: 50%; background: #f5a623; flex: none; }',
    '.box.ok .dot { background: #00a8e1; }',
    '.sub { opacity: .72; font-weight: 500; }',
  ].join('\n');

  function ensureToast() {
    if (toastHost && toastHost.isConnected) return;
    toastHost = document.createElement('div');
    toastHost.setAttribute('data-pvab', 'toast');
    toastShadow = toastHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    toastEl = document.createElement('div');
    toastEl.className = 'box';
    toastEl.innerHTML = '<span class="dot"></span><span class="label"></span>';
    toastShadow.appendChild(style);
    toastShadow.appendChild(toastEl);
    mountToast();
  }

  /** Fullscreen puts a single element in the top layer — live inside it. */
  function mountToast() {
    if (!toastHost) return;
    const parent =
      document.fullscreenElement ||
      (lastProbe && lastProbe.container) ||
      document.body ||
      document.documentElement;
    if (parent && toastHost.parentNode !== parent) parent.appendChild(toastHost);
  }

  function showToast(label, sub, ok, holdMs) {
    if (!settings.showToast) return;
    ensureToast();
    mountToast();
    toastEl.classList.toggle('ok', !!ok);
    toastEl.querySelector('.label').innerHTML =
      escapeHtml(label) + (sub ? ' <span class="sub">' + escapeHtml(sub) + '</span>' : '');
    toastEl.classList.add('show');
    toastHideAt = holdMs ? Date.now() + holdMs : 0;
  }

  function updateToastCountdown(remainingSec) {
    if (!settings.showToast || !toastEl || !toastEl.classList.contains('show')) return;
    if (!settings.toastCountdown || remainingSec == null) return;
    toastEl.querySelector('.label').innerHTML =
      'Ad muted <span class="sub">resumes in ' + Math.max(0, remainingSec | 0) + 's</span>';
  }

  function hideToast() {
    if (toastEl) toastEl.classList.remove('show');
    toastHideAt = 0;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------------- chime
  function chime(kind) {
    try {
      if (!audioCtx) audioCtx = new (root.AudioContext || root.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const notes = kind === 'start' ? [660, 495] : [523.25, 784];
      notes.forEach(function (freq, i) {
        const t0 = audioCtx.currentTime + i * 0.14;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.15);
      });
    } catch (e) {
      log('chime failed', e && e.message);
    }
  }

  // --------------------------------------------------------------- debug HUD
  let hud = null;
  function updateHud(probe) {
    if (!settings.showHud) {
      if (hud && hud.isConnected) hud.remove();
      hud = null;
      return;
    }
    if (!hud || !hud.isConnected) {
      hud = document.createElement('div');
      hud.setAttribute('data-pvab', 'hud');
      hud.style.cssText =
        'position:fixed;bottom:12px;left:12px;z-index:2147483647;pointer-events:none;' +
        'background:rgba(0,0,0,.82);color:#9fe;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;' +
        'padding:8px 10px;border-radius:8px;max-width:46ch;white-space:pre-wrap;border:1px solid #0a3';
      (document.fullscreenElement || document.body || document.documentElement).appendChild(hud);
    }
    hud.textContent =
      'Ad Block ' +
      state.phase +
      (state.mutedByUs ? ' [holding mute]' : '') +
      (state.handsOff ? ' [hands off]' : '') +
      '\nsignals: ' +
      (probe.signals.join(', ') || '-') +
      '\nremaining: ' +
      (probe.remainingSec == null ? '-' : probe.remainingSec + 's') +
      '\nmuted: ' +
      observedMuted(probe) +
      '  target: ' +
      settings.muteTarget +
      '\naction: ' +
      effectiveSettings().adAction +
      (ourRate !== null ? ' @' + ourRate + 'x' : '') +
      (demoted ? ' (demoted)' : '') +
      '\nevidence: ' +
      JSON.stringify(probe.evidence);
  }

  // ------------------------------------------------------------------- loop
  function applyActions(actions, probe) {
    actions.forEach(function (a) {
      switch (a.type) {
        case 'adStart': {
          clearAdEndEstimate(); // a previous pod's target must never leak in
          log('ad start', a.signals, a.remainingSec);
          const sub =
            settings.toastCountdown && a.remainingSec != null
              ? 'resumes in ' + a.remainingSec + 's'
              : '';
          const accel = effectiveSettings().adAction === 'accelerate';
          const label = settings.muteDuringAds
            ? accel
              ? 'Ad muted \u00b7 ' + settings.accelRate + '\u00d7'
              : 'Ad muted'
            : accel
              ? 'Ad ' + settings.accelRate + '\u00d7'
              : 'Ad detected';
          showToast(label, sub, false, 0);
          if (settings.chimeOnAdStart) chime('start');
          send({
            type: 'adStart',
            notify: !!settings.notifyOnAdStart,
            badge: !!settings.badge,
            remainingSec: a.remainingSec,
          });
          break;
        }
        case 'mute':
          applyMute(true);
          break;
        case 'unmute':
          applyMute(false);
          break;
        case 'setRate':
          applyRate(a.rate);
          break;
        case 'restoreRate':
          restoreRate();
          break;
        case 'userOverride':
          log('manual unmute detected — standing down for this break');
          showToast('Sound left on', 'you unmuted', true, 2200);
          break;
        case 'adEnd': {
          clearAdEndEstimate();
          log('ad end', a.reason, a.durationMs);
          if (a.reason === 'timeout') {
            showToast('Ad Block released', 'ad signal stuck', true, 4000);
          } else if (a.muted) {
            showToast('Sound back on', SM.formatDuration(a.durationMs) + ' muted', true, 2500);
          } else {
            hideToast();
          }
          if (settings.chimeOnAdEnd && a.muted) chime('end');
          send({
            type: 'adEnd',
            notify: !!settings.notifyOnAdEnd,
            badge: !!settings.badge,
            durationMs: a.durationMs,
            muted: !!a.muted,
            reason: a.reason,
          });
          break;
        }
      }
    });
    if (state.phase === 'ad') updateToastCountdown(probe.remainingSec);
  }

  function tick() {
    let probe;
    try {
      probe = DET.probe(settings, patterns);
    } catch (e) {
      log('probe failed', e && e.message);
      return;
    }
    lastProbe = probe;
    if (state.phase === 'ad') updateAdEndEstimate(probe);

    const now = Date.now();
    const out = SM.decide(state, {
      now: now,
      adSignal: probe.adSignal,
      signals: probe.signals,
      remainingSec: probe.remainingSec,
      isMuted: observedMuted(probe),
      settings: effectiveSettings(),
    });
    state = out.state;
    if (out.actions.length) applyActions(out.actions, probe);
    else if (state.phase === 'ad') updateToastCountdown(probe.remainingSec);

    if (state.phase === 'ad') clickNativeSkip(now);
    if (toastHideAt && now > toastHideAt) hideToast();
    updateHud(probe);
    // Tick faster during a break: at 8x, 400ms of lag costs 3.2s of feature.
    schedule(
      state.phase === 'ad'
        ? settings.adPollMs
        : probe.video
          ? settings.pollMs
          : IDLE_POLL_MS
    );
  }

  function schedule(ms) {
    if (timer && timerMs === ms) return;
    if (timer) clearInterval(timer);
    timerMs = ms;
    timer = setInterval(tick, ms);
  }

  // --------------------------------------------------------------- lifecycle
  /** Give back everything we took: audio and playback rate. */
  function releaseAll() {
    if (state.mutedByUs) applyMute(false);
    if (ourRate !== null) restoreRate();
    state = SM.createState();
    hideToast();
  }

  document.addEventListener('fullscreenchange', function () {
    mountToast();
    if (hud && hud.isConnected) {
      hud.remove();
      hud = null;
    }
  });

  window.addEventListener('pagehide', releaseAll);
  window.addEventListener('beforeunload', releaseAll);

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      const next = Object.assign({}, settings);
      Object.keys(changes).forEach(function (k) {
        next[k] = changes[k].newValue;
      });
      const targetChanged = next.muteTarget !== settings.muteTarget;
      if (targetChanged && state.mutedByUs) applyMute(false);
      if (next.enabled !== settings.enabled || next.adAction !== settings.adAction) {
        demoted = false; // a deliberate change re-arms the ladder
        releaseAll();
      }
      settings = D.cloneSettings(next);
      recompile();
      log('settings updated', settings);
      tick();
    });

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.type === 'tabMuteChanged') {
        tabMuted = !!msg.muted;
        return;
      }
      if (msg.type === 'getStatus') {
        sendResponse({
          ok: true,
          phase: state.phase,
          mutedByUs: state.mutedByUs,
          handsOff: state.handsOff,
          adAction: effectiveSettings().adAction,
          rate: ourRate,
          demoted: demoted,
          signals: lastProbe ? lastProbe.signals : [],
          remainingSec: lastProbe ? lastProbe.remainingSec : null,
          hasVideo: !!(lastProbe && lastProbe.video),
          hasPlayer: !!(lastProbe && lastProbe.container),
          url: location.href,
        });
        return true;
      }
      if (msg.type === 'previewToast') {
        showToast('Ad muted', 'preview', false, 2500);
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch (e) {
    /* extension context gone */
  }

  loadSettings(function () {
    log('active on', location.href, settings);
    schedule(IDLE_POLL_MS);
    setInterval(rateWatchdog, WATCHDOG_MS);
    tick();
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
