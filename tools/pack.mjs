/**
 * Zips the loadable extension for a Chrome Web Store upload.
 *
 *   node tools/pack.mjs   ->   dist/prime-video-ad-block-<version>.zip
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `prime-video-ad-block-${version}.zip`);

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-rq', out, 'manifest.json', 'src', 'icons'], { cwd: root });
console.log('wrote', out);
