'use strict';
const D = globalThis.PVAB.defaults;

const CHECKBOXES = [
  'enabled',
  'muteDuringAds',
  'respectManualUnmute',
  'showToast',
  'toastCountdown',
  'chimeOnAdStart',
  'chimeOnAdEnd',
  'notifyOnAdStart',
  'notifyOnAdEnd',
  'badge',
  'useHeuristicClassSignal',
  'clickNativeSkip',
  'debug',
  'showHud',
];
const NUMBERS = ['muteDelayMs', 'unmuteDelayMs', 'pollMs', 'accelRate', 'adPollMs'];
const LISTS = ['customSelectors', 'customTextPatterns'];

let savedTimer = null;
function flashSaved() {
  const el = document.getElementById('saved');
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

async function save(patch) {
  await chrome.storage.sync.set(patch);
  flashSaved();
}

function note(msg) {
  document.getElementById('ioNote').textContent = msg || '';
}

function linesToList(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function requestTabsPermission() {
  try {
    return await chrome.permissions.request({ permissions: ['tabs'] });
  } catch (e) {
    return false;
  }
}

async function requestNotificationPermission() {
  try {
    return await chrome.permissions.request({ permissions: ['notifications'] });
  } catch (e) {
    return false;
  }
}

function fill(settings) {
  CHECKBOXES.forEach((k) => {
    document.getElementById(k).checked = !!settings[k];
  });
  NUMBERS.forEach((k) => {
    document.getElementById(k).value = settings[k];
  });
  LISTS.forEach((k) => {
    document.getElementById(k).value = (settings[k] || []).join('\n');
  });
  document.getElementById('muteTarget').value = settings.muteTarget;
  document.getElementById('adAction').value = settings.adAction;
  document.getElementById('maxAdMuteMin').value = Math.round(settings.maxAdMuteMs / 60000);
}

async function init() {
  const settings = D.cloneSettings(await chrome.storage.sync.get(D.DEFAULT_SETTINGS));
  fill(settings);

  CHECKBOXES.forEach((k) => {
    const el = document.getElementById(k);
    el.addEventListener('change', async () => {
      if ((k === 'notifyOnAdStart' || k === 'notifyOnAdEnd') && el.checked) {
        const granted = await requestNotificationPermission();
        if (!granted) {
          el.checked = false;
          note('Desktop notifications need permission — nothing changed.');
          return;
        }
      }
      save({ [k]: el.checked });
    });
  });

  NUMBERS.forEach((k) => {
    const el = document.getElementById(k);
    el.addEventListener('change', () => {
      const n = Number(el.value);
      if (!Number.isFinite(n) || n < 0) {
        el.value = D.DEFAULT_SETTINGS[k];
        return;
      }
      save({ [k]: n });
    });
  });

  LISTS.forEach((k) => {
    const el = document.getElementById(k);
    el.addEventListener('change', () => save({ [k]: linesToList(el.value) }));
  });

  document.getElementById('maxAdMuteMin').addEventListener('change', (e) => {
    const mins = Math.max(1, Number(e.target.value) || 10);
    e.target.value = mins;
    save({ maxAdMuteMs: mins * 60000 });
  });

  const adAction = document.getElementById('adAction');
  adAction.addEventListener('change', () => save({ adAction: adAction.value }));

  const target = document.getElementById('muteTarget');
  target.addEventListener('change', async () => {
    const value = target.value;
    if (value === 'tab' || value === 'both') {
      const granted = await requestTabsPermission();
      if (!granted) {
        target.value = 'video';
        document.getElementById('tabPermNote').textContent =
          'Permission declined — staying on video-element muting.';
        save({ muteTarget: 'video' });
        return;
      }
    }
    save({ muteTarget: value });
  });

  document.getElementById('preview').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return note('No active tab.');
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'previewToast' });
      note('Badge previewed in the active tab.');
    } catch (e) {
      note('Open a Prime Video tab first, then preview from there.');
    }
  });

  document.getElementById('export').addEventListener('click', async () => {
    const current = await chrome.storage.sync.get(D.DEFAULT_SETTINGS);
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'prime-video-ad-block-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const file = document.getElementById('importFile');
  document.getElementById('import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      const clean = {};
      Object.keys(D.DEFAULT_SETTINGS).forEach((k) => {
        if (k in parsed) clean[k] = parsed[k];
      });
      await chrome.storage.sync.set(clean);
      fill(D.cloneSettings(await chrome.storage.sync.get(D.DEFAULT_SETTINGS)));
      note('Settings imported.');
      flashSaved();
    } catch (e) {
      note('That file was not valid settings JSON.');
    }
    file.value = '';
  });

  document.getElementById('reset').addEventListener('click', async () => {
    await chrome.storage.sync.set(D.DEFAULT_SETTINGS);
    fill(D.cloneSettings(D.DEFAULT_SETTINGS));
    note('Back to defaults.');
    flashSaved();
  });
}

init();
