/**
 * Regenerates manifest.json.
 *
 * Chrome match patterns cannot wildcard a TLD, so the Amazon storefronts have
 * to be spelled out. Keeping the list here (rather than hand-editing 60-odd
 * JSON lines) is what makes it maintainable.
 *
 *   node tools/gen-manifest.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AMAZON_TLDS = [
  'com', 'co.uk', 'de', 'fr', 'it', 'es', 'nl', 'se', 'pl', 'com.be',
  'ca', 'com.mx', 'com.br', 'co.jp', 'in', 'com.au', 'sg', 'ae', 'sa', 'eg',
  'com.tr',
];

// Prime Video playback lives under these paths on the Amazon storefronts.
const AMAZON_PATHS = ['/gp/video/*', '/dp/*', '/*/dp/*', '/gp/product/*'];

const matches = ['*://*.primevideo.com/*'];
for (const tld of AMAZON_TLDS) {
  for (const path of AMAZON_PATHS) matches.push(`*://*.amazon.${tld}${path}`);
}

const hostPermissions = ['*://*.primevideo.com/*'].concat(
  AMAZON_TLDS.map((tld) => `*://*.amazon.${tld}/*`)
);

const manifest = {
  manifest_version: 3,
  name: 'Prime Video Ad Block',
  version: '1.0.0',
  description:
    'Automatically mutes Prime Video ad breaks, unmutes the moment your show is back, and can alert you when it happens.',
  homepage_url: 'https://github.com/jodagreyhame/prime-video-ad-block',
  minimum_chrome_version: '102',
  permissions: ['storage'],
  optional_permissions: ['tabs', 'notifications'],
  host_permissions: hostPermissions,
  background: { service_worker: 'src/background/service-worker.js' },
  content_scripts: [
    {
      matches,
      js: [
        'src/common/defaults.js',
        'src/common/state-machine.js',
        'src/content/detect.js',
        'src/content/main.js',
      ],
      run_at: 'document_idle',
      all_frames: true,
    },
  ],
  action: {
    default_title: 'Prime Video Ad Block',
    default_popup: 'src/popup/popup.html',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  options_ui: { page: 'src/options/options.html', open_in_tab: true },
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${out} (${matches.length} content-script match patterns)`);
