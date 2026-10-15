// Shared test helpers. Tests run in Node; the browser tests need Playwright with Chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall through */ }
  const dir = process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules/';
  return createRequire(dir)('playwright');
}

/** A Chromium profile with Developer mode on, like a real unpacked install. */
export function devModeProfile() {
  const dir = tmp('cc-prof-');
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
  return dir;
}

/** Copies the extension so tests can modify it freely. */
export function copyExtension() {
  const dir = tmp('cc-ext-');
  fs.cpSync(ROOT, dir, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
  return dir;
}

export function checker() {
  let fails = 0;
  const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`); if (!cond) fails++; };
  const finish = () => { console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0); };
  return { check, finish };
}
