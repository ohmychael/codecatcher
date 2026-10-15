// Shared logic for the side panel and the background worker.

export const FRESH_MINUTES = 10; // codes older than this are shown as "probably expired"

// Bump together with VERSION in apps-script/Code.gs whenever the Gmail script changes.
// Inboxes running an older script then get an in-panel notice with the updated file.
export const SCRIPT_VERSION = 1;

const DEFAULT_SETTINGS = { autoFill: false, lookbackMinutes: 15, theme: 'system' };

/* ---------------- storage ---------------- */

export async function getAccounts() {
  const { accounts = [] } = await chrome.storage.local.get('accounts');
  return accounts;
}

export async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

export async function getUsed() {
  const { used = {} } = await chrome.storage.local.get('used');
  return used;
}

export async function markUsed(key, how) {
  const used = await getUsed();
  const cutoff = Date.now() - 2 * 24 * 3600e3;
  for (const k of Object.keys(used)) if (used[k].at < cutoff) delete used[k];
  used[key] = { at: Date.now(), how };
  await chrome.storage.local.set({ used });
}

export function newAccessKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'cc_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------------- Apps Script setup ---------------- */

export async function buildScriptFiles(accessKey) {
  const [code, manifest] = await Promise.all([
    fetch(chrome.runtime.getURL('apps-script/Code.gs')).then((r) => r.text()),
    fetch(chrome.runtime.getURL('apps-script/appsscript.json')).then((r) => r.text()),
  ]);
  return { code: code.replace('__ACCESS_KEY__', accessKey), manifest };
}

const URL_RE = /^https:\/\/script\.google\.com\/macros\/(?:a\/[^/]+\/)?s\/[\w-]+\/exec$/;
const LOCAL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/[\w\-/]*$/; // for local testing only

export function cleanDeploymentUrl(input) {
  let url = String(input || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (/\/dev$/.test(url)) return { error: 'That\'s the test URL (ends in /dev). Use the Web app URL from Deploy → Manage deployments — it ends in /exec.' };
  if (URL_RE.test(url) || LOCAL_RE.test(url)) return { url };
  return { error: 'That doesn\'t look like a Web app URL. It should start with https://script.google.com/macros/s/ and end in /exec.' };
}

/** Pulls the access key out of whatever was pasted: the bare key or the whole `const ACCESS_KEY = '…';` line. */
export function parseAccessKey(input) {
  const m = String(input || '').match(/cc_[A-Za-z0-9_-]{20,}/);
  return m ? m[0] : null;
}

/* ---------------- self-update ---------------- */
// The extension folder is a git clone that a small Mac job keeps in sync with GitHub.
// When the files on disk carry a newer manifest version than the one running, reload.

export async function updateReady() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
    const onDisk = (await res.json()).version;
    return onDisk && onDisk !== chrome.runtime.getManifest().version ? onDisk : null;
  } catch {
    return null; // mid-update or unreadable: try again next time
  }
}

/* ---------------- fetching ---------------- */

export async function fetchAccount(account, minutes) {
  const url = `${account.url}?key=${encodeURIComponent(account.key)}&minutes=${minutes}&t=${Date.now()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    throw friendlyError(e.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw friendlyError('notfound');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw friendlyError('html'); }
  if (!data.ok) throw friendlyError(data.error || 'unknown');
  return data;
}

export async function fetchAllCodes(minutes) {
  const accounts = await getAccounts();
  const results = await Promise.allSettled(accounts.map((a) => fetchAccount(a, minutes)));
  const codes = [];
  const status = {};
  results.forEach((r, i) => {
    const acct = accounts[i];
    if (r.status === 'fulfilled') {
      status[acct.id] = { ok: true, email: r.value.account, version: Number(r.value.version) || 0 };
      for (const c of r.value.codes) codes.push({ ...c, key: `${acct.id}:${c.id}`, accountId: acct.id, account: r.value.account || acct.email });
    } else {
      status[acct.id] = { ok: false, error: r.reason.message, hint: r.reason.hint };
    }
  });
  codes.sort((a, b) => b.receivedAt - a.receivedAt);
  return { codes, status, accounts, fetchedAt: Date.now() };
}

function friendlyError(kind) {
  const map = {
    unauthorized: ['Access key mismatch', 'The script in this inbox has a different key. Reconnect this inbox from Settings and paste the freshly copied script.'],
    html: ['Google sent a web page instead of codes', 'In the deployment, "Who has access" must be "Anyone". Also check that you copied the Web app URL ending in /exec.'],
    notfound: ['Deployment not found', 'The web app may have been archived or deleted. Redeploy it and reconnect.'],
    network: ['Can\'t reach Google', 'Check your connection. Retrying automatically.'],
    timeout: ['Google is slow to respond', 'Retrying automatically.'],
  };
  let [msg, hint] = map[kind] || [kind, ''];
  if (map[kind]) {
    // known error
  } else if (/Gmail is not defined/i.test(kind)) {
    [msg, hint] = ['Gmail service not enabled', 'Replace appsscript.json with the copied manifest (setup step 2), save, then Deploy → Manage deployments → edit → New version.'];
  } else if (/permission|authoriz|scope/i.test(kind)) {
    [msg, hint] = ['Script needs authorization', 'Open the script, click Run once on testCodeCatcher and approve access, then try again.'];
  }
  const err = new Error(msg);
  err.hint = hint;
  return err;
}

/* ---------------- filling ---------------- */

/** Fills `code` into the best code box on the tab. Returns { ok, how | reason }. */
export async function fillIntoTab(tabId, code) {
  const run = async (target) => {
    const results = await chrome.scripting.executeScript({ target, func: fillCodeInPage, args: [code] });
    return results.map((r) => r.result).find((r) => r && r.ok) || null;
  };
  try {
    const top = await run({ tabId, frameIds: [0] });
    if (top) return top;
  } catch (e) {
    return { ok: false, reason: 'blocked', detail: String(e.message || e) };
  }
  try {
    const any = await run({ tabId, allFrames: true });
    if (any) return any;
  } catch { /* some frames may be off-limits */ }
  return { ok: false, reason: 'no-field' };
}

/**
 * Runs inside the web page. Must be self-contained (it's serialized by chrome.scripting).
 * Priority: one-time-code field → split digit boxes → focused field → field that looks like "code" → the only empty text box.
 */
export async function fillCodeInPage(code) {
  try {
    const TEXTUAL = /^(?:text|tel|number|password|search|)$/i;
    const HINT = /(one.?time|otp|totp|passcode|verif|security.?code|auth.?code|2fa|mfa|\bcode\b|code$|^code|_code|-code|token|\bpin\b)/i;

    const deepActive = () => {
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      return el;
    };
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    const typeOf = (el) => (el.getAttribute('type') || '').toLowerCase();
    const usable = (el) => el instanceof HTMLInputElement && TEXTUAL.test(typeOf(el)) && !el.disabled && !el.readOnly && isVisible(el);
    const isTiny = (el) => el.maxLength === 1 || el.getBoundingClientRect().width < 64;
    const labelText = (el) => {
      let t = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete'), el.getAttribute('data-testid')].join(' ');
      if (el.labels) for (const l of el.labels) t += ' ' + l.textContent;
      const by = el.getAttribute('aria-labelledby');
      if (by) for (const id of by.split(/\s+/)) { const n = document.getElementById(id); if (n) t += ' ' + n.textContent; }
      return t;
    };
    const setValue = (el, value) => {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const fitCode = (el) => {
      const compact = code.replace(/[\s-]/g, '');
      if (el.maxLength > 0 && code.length > el.maxLength) return compact;
      if (typeOf(el) === 'number' || el.inputMode === 'numeric') return compact;
      return code;
    };
    const tick = () => new Promise((r) => setTimeout(r, 60));

    const inputs = Array.from(document.querySelectorAll('input')).filter(usable);
    if (!inputs.length) return { ok: false, reason: 'no-field' };

    // 1) A proper one-time-code field.
    const otc = inputs.filter((el) => /one-time-code/i.test(el.getAttribute('autocomplete') || '') && !isTiny(el));
    if (otc.length === 1) { setValue(otc[0], fitCode(otc[0])); return { ok: true, how: 'field' }; }

    // 2) Split boxes: 4+ tiny inputs that sit together.
    const chars = code.replace(/[\s-]/g, '').split('');
    const tiny = inputs.filter(isTiny);
    let group = null;
    for (let level = 1; level <= 4 && !group && tiny.length >= 4; level++) {
      const byAncestor = new Map();
      for (const el of tiny) {
        let a = el;
        for (let i = 0; i < level && a; i++) a = a.parentElement;
        if (!a) continue;
        if (!byAncestor.has(a)) byAncestor.set(a, []);
        byAncestor.get(a).push(el);
      }
      for (const list of byAncestor.values()) if (list.length >= 4) { group = list; break; }
    }
    if (group) {
      const boxes = group.slice(0, chars.length);
      const filled = () => boxes.every((b, i) => b.value === chars[i]);
      try {
        // Many OTP widgets handle paste on the first box.
        const dt = new DataTransfer();
        dt.setData('text/plain', chars.join(''));
        boxes[0].focus();
        boxes[0].dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await tick();
      } catch (e) { /* ignore */ }
      if (!filled()) {
        boxes.forEach((b, i) => setValue(b, chars[i]));
        await tick();
      }
      return { ok: true, how: 'split' };
    }

    // 3) Focused field, a field that looks like a code box, or the only empty box.
    const active = deepActive();
    const empties = inputs.filter((el) => !el.value && typeOf(el) !== 'password');
    const pick =
      (usable(active) ? active : null) ||
      inputs.find((el) => HINT.test(labelText(el)) && typeOf(el) !== 'password') ||
      (empties.length === 1 ? empties[0] : null);
    if (!pick) return { ok: false, reason: 'no-field' };
    setValue(pick, fitCode(pick));
    return { ok: true, how: 'field' };
  } catch (e) {
    return { ok: false, reason: 'error', detail: String(e && e.message || e) };
  }
}

/* ---------------- formatting ---------------- */

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hr ago`;
}
