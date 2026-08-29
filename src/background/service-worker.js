/**
 * Prime Video Ad Block — background service worker.
 *
 * Owns the things a content script cannot do: the toolbar badge, desktop
 * notifications, tab-level muting, and the persisted stats.
 */
'use strict';

const STATS_DEFAULTS = {
  adsMuted: 0,
  msMuted: 0,
  lastAdAt: null,
  today: { date: null, adsMuted: 0, msMuted: 0 },
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function bumpStats(durationMs, muted) {
  const { stats } = await chrome.storage.local.get({ stats: STATS_DEFAULTS });
  const s = Object.assign({}, STATS_DEFAULTS, stats);
  const day = todayKey();
  if (!s.today || s.today.date !== day) s.today = { date: day, adsMuted: 0, msMuted: 0 };
  if (muted) {
    s.adsMuted += 1;
    s.msMuted += Math.max(0, durationMs || 0);
    s.today.adsMuted += 1;
    s.today.msMuted += Math.max(0, durationMs || 0);
  }
  s.lastAdAt = Date.now();
  await chrome.storage.local.set({ stats: s });
  return s;
}

function setBadge(tabId, on) {
  if (tabId == null) return;
  try {
    chrome.action.setBadgeText({ tabId, text: on ? 'AD' : '' });
    if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#f5a623' });
  } catch (e) {
    /* tab closed */
  }
}

async function canNotify() {
  try {
    return await chrome.permissions.contains({ permissions: ['notifications'] });
  } catch (e) {
    return false;
  }
}

async function notify(id, title, message) {
  if (!(await canNotify()) || !chrome.notifications) return;
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      silent: true,
    });
  } catch (e) {
    /* notifications not granted after all */
  }
}

async function setTabMuted(tabId, muted) {
  if (tabId == null) return { ok: false, error: 'no tab' };
  const granted = await chrome.permissions.contains({ permissions: ['tabs'] }).catch(() => false);
  if (!granted) return { ok: false, error: 'missing "tabs" permission' };
  try {
    await chrome.tabs.update(tabId, { muted });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  switch (msg && msg.type) {
    case 'setTabMuted':
      setTabMuted(tabId, !!msg.muted).then(sendResponse);
      return true;

    case 'adStart': {
      if (msg.badge) setBadge(tabId, true);
      if (msg.notify) {
        const secs = msg.remainingSec != null ? ` — about ${msg.remainingSec}s` : '';
        notify('pvab-ad-start-' + tabId, 'Ad break', `Prime Video is muted${secs}.`);
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'adEnd': {
      if (msg.badge) setBadge(tabId, false);
      bumpStats(msg.durationMs, msg.muted).then(() => {
        if (msg.notify) {
          notify('pvab-ad-end-' + tabId, 'Show is back', 'Sound restored on Prime Video.');
        }
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'getStats':
      chrome.storage.local.get({ stats: STATS_DEFAULTS }).then(({ stats }) => sendResponse(stats));
      return true;

    case 'resetStats':
      chrome.storage.local.set({ stats: STATS_DEFAULTS }).then(() => sendResponse({ ok: true }));
      return true;
  }
  return false;
});

// Mirror tab-level mute changes back to the content script so it can tell
// "we muted this" from "the user muted this". Requires the optional "tabs"
// permission; without it the listener simply never sees mutedInfo.
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.mutedInfo) return;
    chrome.tabs
      .sendMessage(tabId, { type: 'tabMuteChanged', muted: !!changeInfo.mutedInfo.muted })
      .catch(() => {});
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ stats: null }).then(({ stats }) => {
    if (!stats) chrome.storage.local.set({ stats: STATS_DEFAULTS });
  });
});
