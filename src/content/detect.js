/**
 * Prime Video Ad Block — DOM probing.
 *
 * Thin on purpose: it turns the page into a plain snapshot
 * ({ adSignal, signals, remainingSec, isMuted }) and hands it to the pure state
 * machine. Everything expensive is short-circuited — the selector sweep runs
 * first and the text sweep only runs when no selector matched.
 */
(function (root) {
  'use strict';
  const PVAB = (root.PVAB = root.PVAB || {});
  const D = PVAB.defaults;
  const SM = PVAB.stateMachine;

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // checkVisibility() catches ancestors the rect check misses (the ad-resume
    // message reports a box while CSS-hidden). Not in every engine, hence the
    // computed-style fallback.
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const cs = root.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  /** Elements that must never count as an ad signal, whatever matched them. */
  function isDenied(el) {
    const deny = D.SELECTOR_DENYLIST || [];
    for (let i = 0; i < deny.length; i++) {
      try {
        if (el.matches(deny[i]) || el.closest(deny[i])) return true;
      } catch (e) {
        /* malformed entry */
      }
    }
    return false;
  }

  /** Prime's own Skip Ad button, when the pod carries a skip offset. */
  function findSkipButton() {
    const el = document.querySelector(D.SKIP_AD_SELECTOR);
    return el && isVisible(el) ? el : null;
  }

  function hasText(el) {
    return !!(el && el.textContent && el.textContent.trim().length);
  }

  /** The player chrome, or document as a fallback. */
  function findPlayerContainer() {
    for (let i = 0; i < D.PLAYER_CONTAINERS.length; i++) {
      const el = document.querySelector(D.PLAYER_CONTAINERS[i]);
      if (el) return el;
    }
    return null;
  }

  /** The biggest visible <video> — Prime mounts extras for hover previews. */
  function findVideo() {
    const vids = document.querySelectorAll('video');
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    if (best) return best;
    return vids.length ? vids[0] : null;
  }

  function selectorSignals(scope, settings) {
    const hits = [];
    const builtins = D.BUILTIN_SELECTOR_SIGNALS;
    for (let i = 0; i < builtins.length; i++) {
      const sig = builtins[i];
      let nodes;
      try {
        nodes = scope.querySelectorAll(sig.selector);
      } catch (e) {
        continue;
      }
      for (let j = 0; j < nodes.length; j++) {
        const el = nodes[j];
        if (!isVisible(el) || isDenied(el)) continue;
        if (sig.requireText && !hasText(el)) continue;
        hits.push({ id: sig.id, selector: sig.selector, el: el });
        break;
      }
    }

    const custom = settings.customSelectors || [];
    for (let i = 0; i < custom.length; i++) {
      const sel = String(custom[i]).trim();
      if (!sel) continue;
      let nodes;
      try {
        nodes = scope.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (let j = 0; j < nodes.length; j++) {
        if (!isVisible(nodes[j]) || isDenied(nodes[j])) continue;
        hits.push({ id: 'custom:' + sel, selector: sel, el: nodes[j] });
        break;
      }
    }
    return hits;
  }

  // Matches ad-ish class tokens ("adBadge", "ad-timer", "ads_slot") but not
  // "download", "header", "loading".
  const AD_TOKEN = /(?:^|[\s_-])ads?(?:[\s_-]|[A-Z]|$)/;

  function heuristicSignal(scope) {
    let nodes;
    try {
      nodes = scope.querySelectorAll('[class*="ad" i]');
    } catch (e) {
      return null;
    }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const cls = typeof el.className === 'string' ? el.className : '';
      // AD_TOKEN matches "atvwebplayersdk-go-ad-free-button", so the denylist
      // is load-bearing here, not belt-and-braces.
      if (!cls || !AD_TOKEN.test(cls)) continue;
      if (!isVisible(el) || isDenied(el)) continue;
      return { id: 'heuristicClass', selector: cls.trim().split(/\s+/)[0], el: el };
    }
    return null;
  }

  function overlayText(scope) {
    try {
      const t = scope.innerText || scope.textContent || '';
      return t.length > 4000 ? t.slice(0, 4000) : t;
    } catch (e) {
      return '';
    }
  }

  /**
   * @returns {{adSignal:boolean, signals:string[], remainingSec:number|null,
   *            isMuted:boolean, video:HTMLVideoElement|null,
   *            container:Element|null, evidence:object}}
   */
  function probe(settings, compiledPatterns) {
    const container = findPlayerContainer();
    const scope = container || document;
    const video = findVideo();

    const result = {
      adSignal: false,
      signals: [],
      remainingSec: null,
      isMuted: !!(video && (video.muted || video.volume === 0)),
      video: video,
      container: container,
      evidence: {},
    };

    if (!video) return result;

    const hits = selectorSignals(scope, settings);
    for (let i = 0; i < hits.length; i++) {
      result.signals.push(hits[i].id);
      if (result.remainingSec == null) {
        const secs = SM.parseAdRemaining(hits[i].el.textContent);
        if (secs != null) {
          result.remainingSec = secs;
          result.evidence.countdownFrom = hits[i].id;
        }
      }
    }

    if (!result.signals.length) {
      const text = overlayText(scope);
      const matched = SM.matchTextPatterns(text, compiledPatterns);
      if (matched) {
        result.signals.push('text');
        result.evidence.textPattern = matched;
        if (result.remainingSec == null) result.remainingSec = SM.parseAdRemaining(text);
      }
    }

    if (!result.signals.length && settings.useHeuristicClassSignal) {
      const h = heuristicSignal(scope);
      if (h) {
        result.signals.push(h.id);
        result.evidence.heuristicClass = h.selector;
      }
    }

    result.adSignal = result.signals.length > 0;
    return result;
  }

  PVAB.detect = {
    probe: probe,
    findVideo: findVideo,
    findSkipButton: findSkipButton,
    isDenied: isDenied,
    findPlayerContainer: findPlayerContainer,
    isVisible: isVisible,
    AD_TOKEN: AD_TOKEN,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
