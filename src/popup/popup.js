'use strict';
const D = globalThis.PVAB.defaults;

const TOGGLES = ['enabled', 'showToast', 'chimeOnAdEnd', 'notifyOnAdEnd'];

function fmtMinutes(ms) {
  const m = Math.round((ms || 0) / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function setStatus(cls, text) {
  document.getElementById('statusDot').className = 'dot ' + cls;
  document.getElementById('statusText').textContent = text;
}

async function ensureNotificationPermission(on) {
  if (!on) return true;
  try {
    return await chrome.permissions.request({ permissions: ['notifications'] });
  } catch (e) {
    return false;
  }
}

async function init() {
  const stored = await chrome.storage.sync.get(D.DEFAULT_SETTINGS);
  const settings = D.cloneSettings(stored);

  TOGGLES.forEach((key) => {
    const el = document.getElementById(key);
    el.checked = !!settings[key];
    el.addEventListener('change', async () => {
      if (key === 'notifyOnAdEnd' && el.checked) {
        const granted = await ensureNotificationPermission(true);
        if (!granted) {
          el.checked = false;
          return;
        }
      }
      await chrome.storage.sync.set({ [key]: el.checked });
      if (key === 'enabled') refreshStatus();
    });
  });

  // The popup offers the action as a checkbox; the options page has the full
  // enum. Anything other than 'accelerate' reads as off here.
  const ff = document.getElementById('fastForward');
  ff.checked = settings.adAction === 'accelerate';
  ff.addEventListener('change', async () => {
    await chrome.storage.sync.set({ adAction: ff.checked ? 'accelerate' : 'mute' });
    refreshStatus();
  });

  const stats = await chrome.runtime.sendMessage({ type: 'getStats' });
  if (stats) {
    document.getElementById('statAds').textContent = stats.adsMuted || 0;
    document.getElementById('statTime').textContent = fmtMinutes(stats.msMuted);
    document.getElementById('statToday').textContent = (stats.today && stats.today.adsMuted) || 0;
  }

  document.getElementById('options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('reset').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'resetStats' });
    document.getElementById('statAds').textContent = '0';
    document.getElementById('statTime').textContent = '0m';
    document.getElementById('statToday').textContent = '0';
  });

  refreshStatus();
}

async function refreshStatus() {
  const { enabled } = await chrome.storage.sync.get({ enabled: true });
  if (!enabled) {
    setStatus('off', 'Prime Video Ad Block is switched off');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus('', 'No active tab');
    return;
  }
  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' });
  } catch (e) {
    res = null;
  }
  if (!res) {
    setStatus('', 'Not a Prime Video page — open a title and press play');
    return;
  }
  if (res.phase === 'ad') {
    const left = res.remainingSec != null ? ` — ${res.remainingSec}s left` : '';
    const bits = [];
    if (res.mutedByUs) bits.push('muted');
    if (res.rate) bits.push(`${res.rate}\u00d7`);
    setStatus('ad', `Ad break${left}${bits.length ? ' · ' + bits.join(' ') : ''}`);
  } else if (res.demoted) {
    setStatus('live', 'Watching — fast-forward unavailable, muting only');
  } else if (res.hasVideo) {
    setStatus('live', 'Watching — armed and listening for ads');
  } else {
    setStatus('', 'Prime Video page found, no player yet');
  }
}

init();
