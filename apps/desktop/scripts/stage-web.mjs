#!/usr/bin/env node
/**
 * Stages the web build for the desktop shell WITHOUT modifying apps/web/dist:
 *   ../web/dist  ->  ./dist   (+ offline.html, rayan-config.json)
 * Tauri embeds ./dist into the .exe (frontendDist = "../dist").
 * Env: RAYAN_API_BASE_URL (optional, https only).
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, '../web/dist');
const out = resolve(root, 'dist');

if (!existsSync(resolve(src, 'index.html'))) {
  console.error(`✖ Web build not found at ${src}/index.html
  Build it first from the repo root:  npm ci && npm run build -w @rayan/web
  ابتدا نسخهٔ وب را بسازید:           npm run build -w @rayan/web`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
// Cloudflare Pages-only files are meaningless inside the app bundle.
for (const f of ['_headers', '_redirects', '_routes.json']) rmSync(resolve(out, f), { force: true });

const offline = resolve(out, 'offline.html');
if (!existsSync(offline)) copyFileSync(resolve(root, '../mobile/web-extras/offline.html'), offline);

const apiBaseUrl = (process.env.RAYAN_API_BASE_URL || '').trim().replace(/\/+$/, '');
if (apiBaseUrl) {
  let ok = false;
  try { ok = new URL(apiBaseUrl).protocol === 'https:'; } catch {}
  if (!ok) { console.error(`✖ RAYAN_API_BASE_URL must be https:// (got "${apiBaseUrl}")`); process.exit(1); }
}
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
writeFileSync(resolve(out, 'rayan-config.json'), JSON.stringify({
  apiBaseUrl: apiBaseUrl || null,
  platform: 'windows',
  shellVersion: pkg.version,
}, null, 2) + '\n');
console.log(`✔ staged ${src} -> ${out} (apiBaseUrl=${apiBaseUrl || 'build default'})`);
