// End-to-end test: loads the extension in Chromium, points it at a mock Apps Script endpoint,
// and fills codes into mock sign-in pages. Screenshots go to $SHOTS (or a temp folder).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmp, loadPlaywright, copyExtension, devModeProfile, checker } from './helpers.mjs';

const { chromium } = await loadPlaywright();
const SHOTS = process.env.SHOTS || tmp('cc-shots-');
fs.mkdirSync(SHOTS, { recursive: true });
const KEY = 'cc_testkey_' + 'x'.repeat(30);

/* ---------- test copy of the extension (adds localhost access + a tab shim) ---------- */
const EXT = copyExtension();
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
man.host_permissions.push('http://localhost/*', 'http://127.0.0.1/*');
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2));
// In a real side panel, "the active tab" is the page you're on. Here the panel is itself a tab,
// so point active-tab lookups at the mock sign-in page instead.
fs.writeFileSync(path.join(EXT, 'test-shim.js'), `
  const _q = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (info) => {
    if (info && info.active && info.currentWindow) {
      const tabs = await _q({});
      const t = tabs.find((t) => /\\/otp/.test(t.url || ''));
      return t ? [t] : [];
    }
    return _q(info);
  };
  chrome.permissions.request = async () => true;
  chrome.permissions.contains = async () => true;
`);
fs.writeFileSync(path.join(EXT, 'sidepanel.html'),
  fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8').replace('<script type="module"', '<script src="test-shim.js"></script>\n  <script type="module"'));

/* ---------- mock Apps Script + sign-in pages ---------- */
const inbox = { a: [], b: [] };
let hits = 0;
const otpPage = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'otp.html'), 'utf8');
const splitPage = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'otp-split.html'), 'utf8');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (u.pathname === '/macros/a/exec' || u.pathname === '/macros/b/exec' || u.pathname === '/macros/old/exec') {
    hits++;
    const which = u.pathname.includes('/b/') ? 'b' : 'a';
    if (u.searchParams.get('key') !== KEY) return res.writeHead(200, cors), res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    const version = u.pathname.includes('/old/') ? 0 : 1; // /old/ pretends to run an outdated Gmail script
    return res.writeHead(200, cors), res.end(JSON.stringify({ ok: true, version, account: which === 'a' ? 'inbox.one@example.com' : 'inbox.two@example.com', now: Date.now(), codes: [...inbox[which]].sort((x, y) => y.receivedAt - x.receivedAt) }));
  }
  if (u.pathname === '/macros/html/exec') return res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/html' }), res.end('<html><body>Sign in - Google Accounts</body></html>');
  if (u.pathname === '/otp') return res.writeHead(200, { 'Content-Type': 'text/html' }), res.end(otpPage);
  if (u.pathname === '/otp-split') return res.writeHead(200, { 'Content-Type': 'text/html' }), res.end(splitPage);
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

const add = (which, code, fromName, subject, agoMs = 0, extra = {}) =>
  inbox[which].push({ id: 'm' + Math.random().toString(36).slice(2), code, confidence: 'high', context: '', subject, fromName, fromEmail: 'noreply@example.com', sms: false, receivedAt: Date.now() - agoMs, ...extra });

/* ---------- run ---------- */
const { check, finish } = checker();

const ctx = await chromium.launchPersistentContext(devModeProfile(), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 400, height: 760 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await new Promise((r) => setTimeout(r, 1000));

const otp = await ctx.newPage();
await otp.goto(`${BASE}/otp`);

const panel = await ctx.newPage();
panel.on('console', (m) => { if (m.type() === 'error') console.log('  [panel error]', m.text()); });
panel.on('pageerror', (e) => console.log('  [panel pageerror]', e.message));
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForSelector('.welcome');
check('welcome screen when not connected', await panel.isVisible('text=Connect Gmail'));
await panel.screenshot({ path: `${SHOTS}/1-welcome.png` });

// Setup wizard → copy buttons produce a keyed script → connect with a bad URL, then a good one.
await panel.click('text=Connect Gmail');
await panel.waitForSelector('text=Paste in two files');
await panel.click('text=Copy Code.gs');
const copied = await panel.evaluate(() => navigator.clipboard.readText());
const pendingKey = await panel.evaluate(async () => (await chrome.storage.local.get('pendingSetup')).pendingSetup.key);
check('copied script has the access key filled in', copied.includes(`const ACCESS_KEY = '${pendingKey}'`) && !copied.includes('__ACCESS_KEY__'), pendingKey.slice(0, 10) + '…');
await panel.click('text=Copy appsscript.json');
const copiedManifest = await panel.evaluate(() => navigator.clipboard.readText());
check('copied manifest asks only for read-only Gmail', JSON.parse(copiedManifest).oauthScopes.join() === 'https://www.googleapis.com/auth/gmail.readonly');
await panel.screenshot({ path: `${SHOTS}/2-setup.png`, fullPage: true });

await panel.fill('#deployUrl', 'https://script.google.com/macros/s/abc/dev');
await panel.click('button[data-action="connect"]');
check('rejects /dev URL with a helpful message', await panel.isVisible('text=That\'s the test URL'));

// Use the mock endpoint, but with the pending key swapped to match the mock server.
await panel.evaluate(async (k) => { await chrome.storage.local.set({ pendingSetup: { key: k } }); }, KEY);
await panel.click('#backBtn');
await panel.click('text=Connect Gmail');
await panel.fill('#deployUrl', `${BASE}/macros/html/exec`);
await panel.click('button[data-action="connect"]');
await panel.waitForSelector('.result.err');
check('explains when Google returns a web page', await panel.isVisible('text=Google sent a web page instead of codes'));
await panel.fill('#deployUrl', `${BASE}/macros/a/exec`);
await panel.click('button[data-action="connect"]');
await panel.waitForSelector('text=Connected to inbox.one@example.com');
check('connects and shows the inbox email', true);
await panel.waitForSelector('text=Waiting for a code', { timeout: 5000 });
check('empty state after connecting', true);
await panel.screenshot({ path: `${SHOTS}/3-waiting.png` });

// A code arrives → shows up within one poll, marked New.
add('a', '739205', 'High Desert Corporate Filings', 'Your verification code');
await panel.waitForSelector('.hero[data-key]', { timeout: 6000 });
await panel.waitForTimeout(600);
const shown = (await panel.textContent('.hero .code')).replace(/\s/g, '');
check('new code appears within a poll', shown === '739205', shown);
await panel.screenshot({ path: `${SHOTS}/4-new-code.png` });

// Fill into the sign-in page (single field, like the High Desert page).
await panel.click('.hero button[data-action="fill"]');
await panel.waitForSelector('.hero >> text=Filled');
await panel.screenshot({ path: `${SHOTS}/4b-filled.png` });
const val = await otp.inputValue('#code');
check('fills the code box on the page', val === '739205', JSON.stringify(val));
check('page saw an input event (Continue enabled)', await otp.isEnabled('#continue'));

// Copy
add('a', 'QW4-8ZT', 'Acme', 'Sign in to Acme', 3 * 60e3);
await panel.waitForSelector('text=QW4-8ZT', { timeout: 6000 }).catch(() => {});
await panel.waitForSelector('.row-code', { timeout: 6000 });
const codesNow = await panel.$$eval('.hero .code, .row-code', (els) => els.map((e) => e.textContent.replace(/\s/g, '')));
check('older code listed below newest', JSON.stringify(codesNow) === JSON.stringify(['739205', 'QW4-8ZT']), JSON.stringify(codesNow));
await panel.click('.code-row .row-code');
check('copy puts code on clipboard', (await panel.evaluate(() => navigator.clipboard.readText())) === 'QW4-8ZT');

// Split boxes page.
await otp.goto(`${BASE}/otp-split`);
add('a', '551028', 'Text from (775) 555-0142', 'New text message from (775) 555-0142', 0, { sms: true });
await panel.waitForSelector('.hero >> text=Text from', { timeout: 6000 });
await panel.click('.hero button[data-action="fill"]');
await panel.waitForSelector('.hero >> text=Filled');
const boxes = await otp.$$eval('.box', (els) => els.map((e) => e.value).join(''));
check('fills split digit boxes', boxes === '551028', boxes);

// Second inbox → chips show which inbox each code came from.
await panel.evaluate(async ({ BASE, KEY }) => {
  const { accounts } = await chrome.storage.local.get('accounts');
  accounts.push({ id: 'b', url: `${BASE}/macros/b/exec`, key: KEY, email: 'inbox.two@example.com', addedAt: Date.now() });
  await chrome.storage.local.set({ accounts });
}, { BASE, KEY });
add('b', '2918', 'Microsoft account team', 'Microsoft account security code', 20e3);
add('a', '640017', 'Old Bank', 'Your one-time passcode', 12 * 60e3);
await panel.waitForSelector('.code-row >> text=inbox.two', { timeout: 6000 });
await panel.waitForTimeout(700);
check('labels which inbox each code came from', (await panel.$$('.code-row')).length === 4 && await panel.isVisible('.hero >> text=To inbox.one@example.com'));
check('codes older than 10 min marked as possibly expired', await panel.isVisible('.code-row .state.warn[title="This code may have expired"]'));
await panel.screenshot({ path: `${SHOTS}/5-multi.png`, fullPage: true });

// Keyboard-shortcut path (background worker), on a fresh single-field page.
await otp.goto(`${BASE}/otp`);
add('a', '880214', 'High Desert Corporate Filings', 'Your verification code');
const otpTab = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => /\/otp$/.test(t.url)));
await sw.evaluate((t) => globalThis.fillLatest(t), otpTab);
await otp.waitForFunction(() => document.querySelector('#code').value !== '', null, { timeout: 8000 }).catch(() => {});
check('shortcut fills newest unused code', (await otp.inputValue('#code')) === '880214', await otp.inputValue('#code'));

// Settings view + dark mode.
await panel.click('#settingsBtn');
await panel.waitForSelector('text=Fill new codes automatically');
await panel.screenshot({ path: `${SHOTS}/6-settings.png`, fullPage: true });
await panel.click('.segmented button[data-value="dark"]');
await panel.waitForTimeout(250);
check('theme toggle switches to dark', (await panel.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
await panel.screenshot({ path: `${SHOTS}/6b-settings-dark.png`, fullPage: true });
await panel.click('#backBtn');
await panel.waitForTimeout(200);
await panel.screenshot({ path: `${SHOTS}/6c-codes-dark-forced.png`, fullPage: true });
await panel.reload();
await panel.waitForSelector('.hero');
check('dark theme is remembered after reopening', (await panel.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
await panel.click('#settingsBtn');
await panel.click('.segmented button[data-value="system"]');
await panel.waitForTimeout(200);
check('System clears the forced theme', (await panel.evaluate(() => document.documentElement.dataset.theme)) === undefined);
await panel.click('#backBtn');
await panel.emulateMedia({ colorScheme: 'dark' });
await panel.waitForTimeout(300);
await panel.screenshot({ path: `${SHOTS}/7-dark.png` });

// Auto-fill: enable, then a new code lands in the page by itself.
await panel.evaluate(async () => { const { settings = {} } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, autoFill: true } }); });
await panel.reload();
await panel.waitForSelector('.hero');
await otp.goto(`${BASE}/otp`);
await panel.waitForTimeout(3500); // let the panel see current codes first
add('a', '330198', 'High Desert Corporate Filings', 'Your verification code');
await otp.waitForFunction(() => document.querySelector('#code').value === '330198', null, { timeout: 9000 }).catch(() => {});
check('auto-fill puts a newly arrived code in the page', (await otp.inputValue('#code')) === '330198', await otp.inputValue('#code'));
await otp.screenshot({ path: `${SHOTS}/8-otp-page-filled.png` });

// Wrong key surfaces a clear error.
await panel.evaluate(async () => { const { accounts } = await chrome.storage.local.get('accounts'); accounts[1].key = 'cc_wrong_' + 'y'.repeat(30); await chrome.storage.local.set({ accounts }); });
const sawErr = await panel.waitForSelector('text=Access key mismatch', { timeout: 8000 }).then(() => true).catch(() => false);
check('wrong key shows "Access key mismatch"', sawErr);
await panel.emulateMedia({ colorScheme: 'light' });
await panel.screenshot({ path: `${SHOTS}/9-error.png` });

// Reinstall scenario: no inboxes stored, but the Gmail script already exists. Reconnect with its key + URL.
await panel.evaluate(async () => { await chrome.storage.local.set({ accounts: [] }); });
await panel.waitForSelector('.welcome');
await panel.click('text=Connect Gmail');
await panel.click('button[data-action="start-reconnect"]');
await panel.waitForSelector('#reconnectKey');
await panel.fill('#reconnectKey', 'nonsense');
await panel.fill('#reconnectUrl', `${BASE}/macros/old/exec`);
await panel.click('button[data-action="connect-existing"]');
check('reconnect rejects text without a key', await panel.isVisible('text=doesn\'t look like the access key'));
await panel.fill('#reconnectKey', `const ACCESS_KEY = '${KEY}';`);
await panel.click('button[data-action="connect-existing"]');
await panel.waitForSelector('text=Connected to inbox.one@example.com', { timeout: 8000 });
check('reconnects an existing script from its key line', true);
await panel.screenshot({ path: `${SHOTS}/10-reconnect.png`, fullPage: true });

// That deployment reports an older script version, so the panel offers the updated Code.gs.
await panel.waitForSelector('text=Gmail script update', { timeout: 8000 });
await panel.click('button[data-action="copy-script-update"]');
await panel.waitForSelector('text=Copied Code.gs');
const updated = await panel.evaluate(() => navigator.clipboard.readText());
check('script update copies Code.gs with this inbox\'s key', updated.includes(`const ACCESS_KEY = '${KEY}'`));
await panel.screenshot({ path: `${SHOTS}/11-script-update.png` });

console.log(`mock endpoint hits: ${hits}, screenshots: ${SHOTS}`);
await ctx.close();
server.close();
finish();
