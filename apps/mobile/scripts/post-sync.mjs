#!/usr/bin/env node
/**
 * Runs after `cap sync android`. Adds shell-only files to the copied web
 * assets (android/app/src/main/assets/public) without modifying apps/web/dist:
 *   - offline.html       (Capacitor server.errorPath target) unless the web
 *                        build already ships its own offline.html
 *   - rayan-config.json  runtime config: { apiBaseUrl, platform, shellVersion }
 * Env: RAYAN_API_BASE_URL (optional; https only, trailing slash removed).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'android/app/src/main/assets/public');
if (!existsSync(pub)) {
  console.error(`✖ ${pub} not found — run "npx cap sync android" first.`);
  process.exit(1);
}

const offlineTarget = resolve(pub, 'offline.html');
if (existsSync(offlineTarget)) {
  console.log('• web build ships its own offline.html — keeping it');
} else {
  copyFileSync(resolve(root, 'web-extras/offline.html'), offlineTarget);
  console.log('✔ offline.html added');
}

let apiBaseUrl = (process.env.RAYAN_API_BASE_URL || '').trim().replace(/\/+$/, '');
if (apiBaseUrl) {
  let u;
  try { u = new URL(apiBaseUrl); } catch { u = null; }
  if (!u || u.protocol !== 'https:') {
    console.error(`✖ RAYAN_API_BASE_URL must be an absolute https:// URL (got "${apiBaseUrl}")`);
    process.exit(1);
  }
}
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const config = {
  apiBaseUrl: apiBaseUrl || null, // null => web app uses its build-time default
  platform: 'android',
  shellVersion: pkg.version,
};
writeFileSync(resolve(pub, 'rayan-config.json'), JSON.stringify(config, null, 2) + '\n');
console.log(`✔ rayan-config.json written (apiBaseUrl=${config.apiBaseUrl ?? 'build default'})`);
