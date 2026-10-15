// Proves the auto-update loop: change files on disk (like `git pull` does), and the extension reloads itself.
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright, copyExtension, devModeProfile, checker } from './helpers.mjs';

const { chromium } = await loadPlaywright();
const EXT = copyExtension();
const ctx = await chromium.launchPersistentContext(devModeProfile(), {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 1500));
const { check, finish } = checker();

const v1 = await sw.evaluate(() => chrome.runtime.getManifest().version);
check('no update reported when disk matches', (await sw.evaluate(() => globalThis.checkForUpdate())) === false, v1);
const alarm = await sw.evaluate(() => chrome.alarms.get('check-update'));
check('1-minute update alarm is scheduled', alarm && alarm.periodInMinutes === 1);

// Simulate `git pull` bringing a new version plus a changed file.
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
man.version = '9.9.9';
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2));
fs.appendFileSync(path.join(EXT, 'background.js'), '\nglobalThis.__newCode = "pulled";\n');

const swPromise = ctx.waitForEvent('serviceworker', { timeout: 15000 });
await sw.evaluate(() => globalThis.checkForUpdate()).catch(() => {}); // the worker dies as it reloads
const sw2 = await swPromise;
await new Promise((r) => setTimeout(r, 1500));
const v2 = await sw2.evaluate(() => chrome.runtime.getManifest().version);
const marker = await sw2.evaluate(() => globalThis.__newCode);
check('extension reloaded itself with the new version', v2 === '9.9.9', `${v1} -> ${v2}`);
check('new code from disk is running', marker === 'pulled');

// Panel shows a Restart prompt when an update lands while it's open.
const page = await ctx.newPage();
await page.goto(`chrome-extension://${new URL(sw2.url()).host}/sidepanel.html`);
await page.waitForSelector('.welcome');
man.version = '9.9.10';
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2));
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
const sawBanner = await page.waitForSelector('text=Update ready', { timeout: 20000 }).then(() => true).catch(() => false);
check('open panel offers Restart instead of closing', sawBanner);

await ctx.close();
finish();
