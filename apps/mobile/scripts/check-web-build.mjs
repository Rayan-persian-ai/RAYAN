#!/usr/bin/env node
// Fails fast (with a Persian + English hint) if the web build is missing.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, '../web/dist');
if (!existsSync(resolve(dist, 'index.html'))) {
  console.error(`✖ Web build not found at ${dist}/index.html
  Build it first from the repo root:   npm ci && npm run build -w @rayan/web
  ابتدا نسخهٔ وب را بسازید:            npm run build -w @rayan/web`);
  process.exit(1);
}
console.log(`✔ web build found: ${dist}`);
