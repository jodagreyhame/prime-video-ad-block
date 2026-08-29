'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const exists = (p) => fs.existsSync(path.join(ROOT, p));

test('manifest is MV3 and points at files that exist', () => {
  assert.strictEqual(manifest.manifest_version, 3);
  assert.ok(exists(manifest.background.service_worker));
  assert.ok(exists(manifest.action.default_popup));
  assert.ok(exists(manifest.options_ui.page));
  for (const size of Object.keys(manifest.icons)) assert.ok(exists(manifest.icons[size]), size);
  for (const js of manifest.content_scripts[0].js) assert.ok(exists(js), js);
});

test('content scripts are declared in dependency order', () => {
  const js = manifest.content_scripts[0].js;
  const idx = (needle) => js.findIndex((f) => f.includes(needle));
  assert.ok(idx('defaults') < idx('state-machine'), 'defaults before state-machine');
  assert.ok(idx('state-machine') < idx('detect'), 'state-machine before detect');
  assert.ok(idx('detect') < idx('main'), 'detect before main');
});

test('match patterns cover primevideo.com and the amazon storefronts', () => {
  const m = manifest.content_scripts[0].matches;
  assert.ok(m.includes('*://*.primevideo.com/*'));
  assert.ok(m.some((p) => p.startsWith('*://*.amazon.com/gp/video/')));
  assert.ok(m.some((p) => p.includes('amazon.co.uk')));
  assert.ok(m.every((p) => /^\*:\/\/\*\.[a-z.]+\//.test(p)), 'no over-broad patterns');
});

test('install asks for storage only; tabs and notifications stay optional', () => {
  assert.deepStrictEqual(manifest.permissions, ['storage']);
  assert.deepStrictEqual(manifest.optional_permissions.sort(), ['notifications', 'tabs']);
});

test('every shipped script parses', () => {
  const files = [
    ...manifest.content_scripts[0].js,
    manifest.background.service_worker,
    'src/popup/popup.js',
    'src/options/options.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
  }
});

test('pages load their scripts as files, not inline (MV3 CSP)', () => {
  for (const page of ['src/popup/popup.html', 'src/options/options.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const scripts = html.match(/<script\b[^>]*>/g) || [];
    for (const tag of scripts) {
      assert.ok(/\ssrc=/.test(tag), `${page} has an inline <script>: ${tag}`);
    }
    // referenced local assets must exist
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|#)/.test(ref)) continue;
      const resolved = path.join(ROOT, path.dirname(page), ref);
      assert.ok(fs.existsSync(resolved), `${page} references missing ${ref}`);
    }
  }
});

test('defaults and the options page stay in sync', () => {
  const D = require('../src/common/defaults.js');
  const html = fs.readFileSync(path.join(ROOT, 'src/options/options.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const notInUi = new Set(['maxAdMuteMs']); // exposed as maxAdMuteMin (minutes)
  for (const key of Object.keys(D.DEFAULT_SETTINGS)) {
    if (notInUi.has(key)) continue;
    assert.ok(ids.has(key), `options page has no control for setting "${key}"`);
  }
  assert.ok(ids.has('maxAdMuteMin'));
});
