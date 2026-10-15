import {
  getAccounts, saveAccounts, getSettings, saveSettings, getUsed, markUsed,
  newAccessKey, buildScriptFiles, cleanDeploymentUrl, fetchAccount, fetchAllCodes,
  fillIntoTab, timeAgo, parseAccessKey, updateReady, FRESH_MINUTES, SCRIPT_VERSION,
} from './lib/core.js';

const FAST_MS = 3000;            // while you're likely waiting for a code
const SLOW_MS = 30000;           // after a few quiet minutes
const ERROR_MS = 15000;
const FAST_WINDOW_MS = 5 * 60e3; // stay fast this long after any activity
const ARRIVAL_MS = 2 * 60e3;     // a code this recent counts as just arrived
const IS_MAC = /Mac/i.test(navigator.platform);
const PASTE = IS_MAC ? '⌘V' : 'Ctrl+V';

const $view = document.getElementById('view');
const $bar = document.getElementById('bar');
const $title = document.getElementById('title');
const $back = document.getElementById('backBtn');
const $backLabel = document.getElementById('backLabel');
const $status = document.getElementById('status');
const $statusText = document.getElementById('statusText');
const $refresh = document.getElementById('refreshBtn');
const $hud = document.getElementById('hud');
const $hudText = document.getElementById('hudText');

const state = {
  view: 'codes',          // codes | settings | setup
  returnTo: 'codes',
  accounts: [],
  settings: null,
  used: {},
  data: null,             // last fetchAllCodes() result
  feedback: {},           // key -> { text, until }
  seen: new Set(),
  firstLoad: true,
  hasAllUrls: false,
  setup: { key: null, files: null, result: null, busy: false, url: '' },
  confirmRemove: null,
  rendered: new Set(),    // codes already drawn, so the arrival animation plays once
  updateVersion: null,    // set when newer files have landed on disk
  reconnect: { url: '', key: '', result: null, busy: false },
  scriptCopied: {},       // account id -> true after copying an updated Code.gs
};

let timer = null;
let inflight = false;
let fastUntil = Date.now() + FAST_WINDOW_MS;

/* ---------------- icons (SF Symbols–style) ---------------- */

const svg = (w, body, extra = '') => `<svg viewBox="0 0 20 20" width="${w}" height="${w}" aria-hidden="true" ${extra}>${body}</svg>`;
const I = {
  check: svg(13, '<path d="m4.5 10.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  checkCircle: svg(13, '<circle cx="10" cy="10" r="8.5" fill="currentColor"/><path d="m6.3 10.3 2.5 2.5 5-5.3" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  bolt: svg(24, '<path d="M11.4 1.6 4 11.3h5l-1 7.1 7.6-10h-5.2z" fill="currentColor"/>'),
  field: svg(24, '<rect x="1.5" y="5" width="17" height="10" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="5.6" cy="10" r="1.2" fill="currentColor"/><circle cx="9" cy="10" r="1.2" fill="currentColor"/><path d="M13 7.4v5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  lock: svg(24, '<rect x="3.8" y="8.6" width="12.4" height="9.2" rx="2.2" fill="currentColor"/><path d="M6.6 8.6V6.4a3.4 3.4 0 0 1 6.8 0v2.2" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  envelope: svg(15, '<rect x="2.5" y="4.5" width="15" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m3.2 5.6 6.8 5.3 6.8-5.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'),
  warn: svg(18, '<path d="M8.6 2.9a1.6 1.6 0 0 1 2.8 0l6.8 12.2a1.6 1.6 0 0 1-1.4 2.4H3.2a1.6 1.6 0 0 1-1.4-2.4z" fill="currentColor"/><path d="M10 7.2v4.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.3" r="1.1" fill="#fff"/>'),
  clock: svg(12, '<circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M10 5.8V10l2.8 1.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  download: svg(18, '<circle cx="10" cy="10" r="8.6" fill="currentColor"/><path d="M10 5.6v7M6.9 9.7 10 12.8l3.1-3.1" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  arrow: svg(11, '<path d="M6 14 14 6M7.5 6H14v6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  updown: svg(11, '<path d="m6 8 4-4 4 4M6 12l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  bubble: svg(17, '<path d="M10 3.5c4.4 0 7.5 2.7 7.5 6s-3.1 6-7.5 6c-.8 0-1.6-.1-2.3-.3L4 16.5l.9-3C3.4 12.4 2.5 11 2.5 9.5c0-3.3 3.1-6 7.5-6z" fill="currentColor"/>'),
};

/* ---------------- utilities ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hud(msg, { ok = false, ms = 2400 } = {}) {
  $hudText.textContent = msg;
  $hud.classList.toggle('ok', ok);
  $hud.classList.add('show');
  clearTimeout(hud.t);
  hud.t = setTimeout(() => $hud.classList.remove('show'), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function setFeedback(key, text) {
  state.feedback[key] = { text, until: Date.now() + 2500 };
  render();
  setTimeout(refresh, 2600);
}

const feedbackFor = (key) => (state.feedback[key] && state.feedback[key].until > Date.now() ? state.feedback[key].text : null);
const shortEmail = (email) => String(email || '').replace(/@gmail\.com$/i, '');
// Prefer the display name; otherwise the sender's domain reads better than a full address.
const senderName = (c) => c.fromName || (String(c.fromEmail || '').split('@')[1] || '').replace(/^(mail|email|e|info|no-?reply|notifications?)\./i, '') || c.fromEmail || 'Unknown sender';

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try { localStorage.setItem('cc-theme', theme || 'system'); } catch { /* ignore */ }
}
const subjectLine = (c) => (c.sms ? 'Text message, forwarded by Google Voice' : c.subject || 'No subject');

function avatar(c, size = '') {
  if (c.sms) return `<span class="avatar sms ${size}">${I.bubble}</span>`;
  const letter = (senderName(c).match(/[A-Za-z0-9]/) || ['#'])[0].toUpperCase();
  return `<span class="avatar ${size}">${esc(letter)}</span>`;
}

function groupedCode(code) {
  if (!/^\d{6}$|^\d{8}$/.test(code)) return esc(code);
  return `${esc(code.slice(0, code.length / 2))}<span class="gap"></span>${esc(code.slice(code.length / 2))}`;
}

function codeMarkup(code) {
  const parts = [...code].map((ch, i) => `<span style="--i:${i}">${esc(ch)}</span>`);
  if (/^\d{6}$|^\d{8}$/.test(code)) parts.splice(code.length / 2, 0, '<span class="gap"></span>');
  return parts.join('');
}

const usedLabel = (how) => `<span class="state done">${I.checkCircle}${how === 'filled' ? 'Filled' : 'Copied'}</span>`;

/* ---------------- polling ---------------- */

function schedule(delay) {
  clearTimeout(timer);
  if (document.hidden || !state.accounts.length) return;
  if (delay === undefined) {
    const allFailing = state.data && state.accounts.length && Object.values(state.data.status).every((s) => !s.ok);
    delay = allFailing ? ERROR_MS : Date.now() < fastUntil ? FAST_MS : SLOW_MS;
  }
  timer = setTimeout(poll, delay);
}

function bump() {
  const wasSlow = Date.now() >= fastUntil;
  fastUntil = Date.now() + FAST_WINDOW_MS;
  if (wasSlow && !inflight) schedule(300);
  updateStatus();
}

async function poll({ manual = false } = {}) {
  if (inflight || !state.accounts.length) return;
  inflight = true;
  if (manual) $refresh.classList.add('spinning');
  try {
    state.data = await fetchAllCodes(state.settings.lookbackMinutes);
    await onNewData();
  } catch (e) {
    console.warn(e);
  } finally {
    inflight = false;
    $refresh.classList.remove('spinning');
    updateStatus();
    refresh();
    schedule();
  }
}

async function onNewData() {
  const arrivals = [];
  for (const c of state.data.codes) {
    if (state.seen.has(c.key)) continue;
    state.seen.add(c.key);
    if (!state.firstLoad && Date.now() - c.receivedAt < ARRIVAL_MS) arrivals.push(c);
  }
  state.firstLoad = false;
  if (!arrivals.length) return;

  const newest = arrivals[0];
  if (state.settings.autoFill && state.hasAllUrls && !state.used[newest.key]) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const res = await fillIntoTab(tab.id, newest.code);
      if (res.ok) {
        await markUsed(newest.key, 'filled');
        state.used = await getUsed();
        hud(`Filled code from ${senderName(newest)}`, { ok: true, ms: 3000 });
        return;
      }
    }
  }
  hud(`New code from ${senderName(newest)}`);
}

function updateStatus() {
  if (!state.accounts.length) {
    $status.dataset.state = 'idle';
    $statusText.textContent = '';
    return;
  }
  const failing = state.data ? Object.values(state.data.status).filter((s) => !s.ok).length : 0;
  const watching = state.accounts.length === 1 ? `Watching ${state.accounts[0].email || 'your inbox'}` : `Watching ${state.accounts.length} inboxes`;
  if (state.data && failing === state.accounts.length) {
    $status.dataset.state = 'error';
    $statusText.textContent = 'Can\'t reach Gmail';
  } else if (document.hidden) {
    $status.dataset.state = 'idle';
    $statusText.textContent = 'Paused';
  } else if (Date.now() < fastUntil) {
    $status.dataset.state = 'live';
    $statusText.textContent = watching;
  } else {
    $status.dataset.state = 'idle';
    $statusText.textContent = 'Checking every 30 seconds';
  }
  $status.title = state.data ? `Last checked at ${new Date(state.data.fetchedAt).toLocaleTimeString()}` : '';
}

/* ---------------- actions ---------------- */

function onFill(c) {
  // permissions.request must run synchronously inside the click.
  const permission = state.hasAllUrls ? Promise.resolve(true) : chrome.permissions.request({ origins: ['<all_urls>'] });
  permission.then(async (granted) => {
    if (!granted) {
      await copyText(c.code);
      await markUsed(c.key, 'copied');
      state.used = await getUsed();
      setFeedback(c.key, 'Copied');
      hud(`Copied. Paste with ${PASTE}.`, { ok: true, ms: 3200 });
      return;
    }
    state.hasAllUrls = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = tab ? await fillIntoTab(tab.id, c.code) : { ok: false, reason: 'no-tab' };
    if (res.ok) {
      await markUsed(c.key, 'filled');
      state.used = await getUsed();
      setFeedback(c.key, 'Filled');
      hud('Filled', { ok: true });
      return;
    }
    await copyText(c.code);
    await markUsed(c.key, 'copied');
    state.used = await getUsed();
    setFeedback(c.key, 'Copied');
    hud(res.reason === 'blocked'
      ? `Chrome blocks filling on this page. Copied instead, paste with ${PASTE}.`
      : `No code box on this page. Copied instead, paste with ${PASTE}.`, { ms: 4000 });
  });
}

async function onCopy(c) {
  const ok = await copyText(c.code);
  if (!ok) return hud('Couldn\'t copy. Select the code and copy it.');
  await markUsed(c.key, 'copied');
  state.used = await getUsed();
  setFeedback(c.key, 'Copied');
  hud('Copied', { ok: true });
}

/* ---------------- rendering ---------------- */

let lastSig = '';

function signature() {
  const now = Date.now();
  const codes = state.data ? state.data.codes.map((c) => [
    c.key, now - c.receivedAt > FRESH_MINUTES * 60e3,
    state.used[c.key] ? state.used[c.key].how : 0,
    feedbackFor(c.key) || 0,
  ]) : null;
  return JSON.stringify([state.view, codes, state.data && state.data.status, state.accounts.map((a) => a.id + a.email),
    state.settings, state.hasAllUrls, state.confirmRemove, state.updateVersion, state.scriptCopied]);
}

function updateChrome() {
  const welcome = state.view === 'codes' && !state.accounts.length;
  document.body.dataset.view = welcome ? 'welcome' : state.view;
  $title.textContent = { codes: 'Codes', settings: 'Settings', setup: 'Add Inbox', reconnect: 'Reconnect Inbox' }[state.view];
  $backLabel.textContent = state.view === 'setup' || state.view === 'reconnect' ? 'Cancel' : 'Codes';
}

function render() {
  updateChrome();
  if (state.view === 'setup') return renderSetup();
  if (state.view === 'reconnect') return renderReconnect();
  lastSig = signature();
  if (state.view === 'settings') return renderSettings();
  return renderCodes();
}

// Re-render only when something visible changed, so buttons don't get swapped out under the cursor.
function refresh() {
  if (state.view === 'setup' || state.view === 'reconnect') return;
  if (signature() !== lastSig) return render();
  const now = Date.now();
  document.querySelectorAll('time[data-ts]').forEach((t) => { t.textContent = timeAgo(Number(t.dataset.ts), now); });
}

function renderWelcome() {
  $view.innerHTML = updateBanner() + `
    <section class="welcome">
      <img class="app-icon" src="icons/icon128.png" alt="">
      <h1>Your verification codes, right beside the page</h1>
      <ul class="features">
        <li><span class="f-icon">${I.bolt}</span><div><b>Arrives in seconds</b><p>When a site emails you a code, it shows up here. No more switching to Gmail.</p></div></li>
        <li><span class="f-icon">${I.field}</span><div><b>Fills in with one click</b><p>Click Fill and the code goes straight into the page.</p></div></li>
        <li><span class="f-icon">${I.lock}</span><div><b>Stays in your Google account</b><p>Read-only access to Gmail. Only the codes reach this browser.</p></div></li>
      </ul>
      <button class="btn filled large" data-action="start-setup">Connect Gmail</button>
      <p class="fine">Takes about 3 minutes.</p>
    </section>`;
}

function updateBanner() {
  if (!state.updateVersion) return '';
  return `
    <div class="notice info">
      ${I.download}
      <div>
        <div class="notice-title">Update ready</div>
        <div class="notice-body">A new version of Code Catcher has downloaded. Restart to use it. The panel closes, and you can reopen it from the toolbar.</div>
        <button class="btn plain small" data-action="restart">Restart Now</button>
      </div>
    </div>`;
}

function notices() {
  let html = updateBanner();
  if (!state.data) return html;
  return html + state.accounts.map((acct) => {
    const s = state.data.status[acct.id];
    if (s && s.ok && s.version < SCRIPT_VERSION) {
      const copied = state.scriptCopied[acct.id];
      return `
      <div class="notice info">
        ${I.download}
        <div>
          <div class="notice-title">Gmail script update</div>
          <div class="notice-body">${esc(acct.email || 'Gmail inbox')}<br>Copy the new Code.gs, paste it over everything in Code.gs in Apps Script and save. Then click <b>Deploy › Manage deployments</b>, the pencil, set Version to <b>New version</b>, and click <b>Deploy</b>. The URL stays the same.</div>
          <button class="btn plain small" data-action="copy-script-update" data-id="${esc(acct.id)}">${copied ? `${I.check} Copied Code.gs` : 'Copy New Code.gs'}</button>
        </div>
      </div>`;
    }
    if (!s || s.ok) return '';
    return `
      <div class="notice">
        ${I.warn}
        <div>
          <div class="notice-title">${esc(s.error)}</div>
          <div class="notice-body">${esc(acct.email || 'Gmail inbox')}<br>${esc(s.hint || '')}</div>
          <button class="btn plain small" data-action="open-settings">Open Settings</button>
        </div>
      </div>`;
  }).join('');
}

function waitingCard(title, body) {
  const slots = Array.from({ length: 6 }, (_, i) => `<span style="--i:${i}"></span>`).join('');
  return `
    <section class="hero waiting">
      <div class="slots" aria-hidden="true">${slots}</div>
      <h2>${esc(title)}</h2>
      ${body ? `<p>${esc(body)}</p>` : ''}
    </section>`;
}

function renderCodes() {
  if (!state.accounts.length) return renderWelcome();
  const now = Date.now();
  let html = notices();

  if (!state.data) {
    $view.innerHTML = html + waitingCard('Checking your inbox…');
    return;
  }

  const multi = state.accounts.length > 1;
  const codes = state.data.codes;
  const fresh = (c) => now - c.receivedAt <= FRESH_MINUTES * 60e3;
  const hero = codes[0] && fresh(codes[0]) ? codes[0] : null;
  const earlier = hero ? codes.slice(1) : codes;

  if (hero) {
    const used = state.used[hero.key];
    const fb = feedbackFor(hero.key);
    const arrive = !state.rendered.has(hero.key) && now - hero.receivedAt < ARRIVAL_MS;
    html += `
      <section class="hero ${arrive ? 'arrive' : ''}" data-key="${esc(hero.key)}">
        <div class="hero-head">
          ${avatar(hero)}
          <div class="who">
            <div class="who-top">
              ${used ? '' : '<span class="unread" title="Not used yet"></span>'}
              <span class="name" title="${esc(hero.fromEmail)}">${esc(senderName(hero))}</span>
              <time data-ts="${hero.receivedAt}">${esc(timeAgo(hero.receivedAt, now))}</time>
            </div>
            <div class="who-sub"><span class="subject" title="${esc(hero.context || hero.subject)}">${esc(subjectLine(hero))}</span></div>
          </div>
        </div>
        <button class="code" data-action="copy" title="Click to copy" aria-label="Copy code ${esc(hero.code)}">${codeMarkup(hero.code)}</button>
        ${multi || (used && !fb) ? `<div class="hero-meta">${used && !fb ? usedLabel(used.how) : ''}${multi ? `<span>To ${esc(hero.account)}</span>` : ''}</div>` : ''}
        <div class="hero-actions">
          <button class="btn filled grow ${fb === 'Filled' ? 'done' : ''}" data-action="fill">${fb === 'Filled' ? `${I.check} Filled` : 'Fill'}</button>
          <button class="btn gray grow ${fb === 'Copied' ? 'done' : ''}" data-action="copy">${fb === 'Copied' ? `${I.check} Copied` : 'Copy'}</button>
        </div>
      </section>`;
  } else {
    html += waitingCard('Waiting for a code', 'Sign in somewhere that emails you a code. It shows up here within a few seconds.');
  }

  if (earlier.length) {
    html += '<h2 class="group-title">Earlier</h2><ul class="group">';
    for (const c of earlier) {
      const used = state.used[c.key];
      const stale = !fresh(c);
      const fb = feedbackFor(c.key);
      html += `
        <li class="cell code-row ${used || stale ? 'dim' : ''}" data-key="${esc(c.key)}" data-action="copy" title="${esc(c.subject)}. Click to copy.">
          ${avatar(c, 'small')}
          <div class="cell-main">
            <div class="row-top">
              ${used || stale ? '' : '<span class="unread"></span>'}
              <span class="name">${esc(senderName(c))}</span>
            </div>
            <div class="row-sub">
              ${stale && !used
                ? `<span class="state warn" title="This code may have expired">${I.clock}<time data-ts="${c.receivedAt}">${esc(timeAgo(c.receivedAt, now))}</time></span>`
                : `<time data-ts="${c.receivedAt}">${esc(timeAgo(c.receivedAt, now))}</time>`}
              ${used ? usedLabel(used.how) : ''}
              ${multi ? `<span class="inbox">${esc(shortEmail(c.account))}</span>` : ''}
            </div>
          </div>
          <span class="row-code">${groupedCode(c.code)}</span>
          <button class="btn tinted small ${fb === 'Filled' ? 'done' : ''}" data-action="fill">${fb === 'Filled' ? 'Filled' : 'Fill'}</button>
        </li>`;
    }
    html += '</ul>';
  }

  for (const c of codes) state.rendered.add(c.key);
  $view.innerHTML = html;
}

function renderSettings() {
  const s = state.settings;
  const status = state.data ? state.data.status : {};
  const rows = state.accounts.map((a) => {
    const st = status[a.id];
    const err = st && !st.ok;
    const confirming = state.confirmRemove === a.id;
    return `
      <li class="cell" style="--inset:46px">
        <span class="cell-icon">${I.envelope}</span>
        <div class="cell-main">
          <div class="cell-title">${esc(a.email || 'Gmail inbox')}</div>
          <div class="cell-sub ${err ? 'err' : ''}">${err ? esc(st.error) : 'Connected'}</div>
        </div>
        ${err ? '<button class="btn plain small" data-action="start-setup">Reconnect</button>' : ''}
        <button class="btn plain small ${confirming ? 'destructive' : 'muted'}" data-action="remove" data-id="${esc(a.id)}">${confirming ? 'Confirm Remove' : 'Remove'}</button>
      </li>`;
  }).join('');

  const themes = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
  $view.innerHTML = `
    <h2 class="group-title" style="margin-top:8px">Appearance</h2>
    <ul class="group">
      <li class="cell">
        <div class="cell-main"><div class="cell-title">Theme</div></div>
        <div class="segmented" role="group" aria-label="Theme">
          ${themes.map(([v, label]) => `<button type="button" data-action="theme" data-value="${v}" aria-pressed="${(s.theme || 'system') === v}">${label}</button>`).join('')}
        </div>
      </li>
    </ul>

    <h2 class="group-title">Inboxes</h2>
    <ul class="group">
      ${rows || '<li class="cell"><div class="cell-main cell-sub">No inboxes yet.</div></li>'}
    </ul>
    <div class="group-foot"><button class="btn gray small" data-action="start-setup">Add Inbox…</button></div>

    <h2 class="group-title">Filling</h2>
    <ul class="group">
      <li class="cell">
        <div class="cell-main">
          <div class="cell-title">Fill new codes automatically</div>
          <div class="cell-sub">When a code arrives, it goes into the code box on the page you're on. You still click Continue yourself.</div>
        </div>
        <label class="switch"><input type="checkbox" data-action="autofill" ${s.autoFill && state.hasAllUrls ? 'checked' : ''} aria-label="Fill new codes automatically"><span></span></label>
      </li>
      <li class="cell">
        <div class="cell-main">
          <div class="cell-title">Keyboard shortcut</div>
          <div class="cell-sub">Fills the newest code without opening this panel.</div>
        </div>
        <span class="keycap" id="shortcutValue"></span>
        <button class="btn gray small" data-action="shortcuts">Change…</button>
      </li>
    </ul>

    <h2 class="group-title">Codes</h2>
    <ul class="group">
      <li class="cell">
        <div class="cell-main"><div class="cell-title">Show codes from the last</div></div>
        <span class="popup">
          <select data-action="lookback" aria-label="Show codes from the last">
            ${[10, 15, 30, 60].map((m) => `<option value="${m}" ${s.lookbackMinutes === m ? 'selected' : ''}>${m} minutes</option>`).join('')}
          </select>
          ${I.updown}
        </span>
      </li>
    </ul>
    <p class="group-note">Code Catcher checks for new codes every 3 seconds for 5 minutes after you open this panel or switch pages, then every 30 seconds.</p>`;

  chrome.commands.getAll().then((cmds) => {
    const cmd = cmds.find((c) => c.name === 'fill-latest');
    const el = document.getElementById('shortcutValue');
    if (el) el.textContent = cmd && cmd.shortcut ? prettyShortcut(cmd.shortcut) : 'Not set';
  });
}

function prettyShortcut(s) {
  if (!IS_MAC) return s;
  return s.replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧').replace(/Command\+/g, '⌘').replace(/(MacCtrl|Ctrl)\+/g, '⌃').replace(/\+/g, '');
}

function renderSetup() {
  const r = state.setup.result;
  const copied = state.setup.copied || {};
  $view.innerHTML = `
    <p class="intro">You'll add a small script to the Google account you want to watch. It can only read mail, and it sends back nothing but codes. About 3 minutes per inbox.</p>
    <p class="intro" style="margin-top:-8px">Already set up this inbox before? <button class="btn plain small" style="margin-left:-4px" data-action="start-reconnect">Reconnect it instead</button></p>
    <ol class="group steps">
      <li class="cell">
        <span class="step-num">1</span>
        <div class="cell-main">
          <div class="cell-title">Open a new Apps Script project</div>
          <div class="cell-sub">Check that the account picture in the top-right is the Gmail account you want to watch. If it isn't, switch accounts there and click <b>New project</b>.</div>
          <div class="step-actions"><button class="btn gray small" data-action="open-script">Open Apps Script ${I.arrow}</button></div>
        </div>
      </li>
      <li class="cell">
        <span class="step-num">2</span>
        <div class="cell-main">
          <div class="cell-title">Paste in two files</div>
          <div class="cell-sub">In <b>Project Settings</b> (the gear on the left), turn on <b>Show "appsscript.json" manifest file in editor</b>. Then go back to the <b>Editor</b> and replace everything in each file with what you copy here.</div>
          <div class="step-actions">
            <button class="btn small ${copied.manifest ? 'done' : 'gray'}" data-action="copy-manifest">${copied.manifest ? `${I.check} Copied appsscript.json` : 'Copy appsscript.json'}</button>
            <button class="btn small ${copied.code ? 'done' : 'gray'}" data-action="copy-code">${copied.code ? `${I.check} Copied Code.gs` : 'Copy Code.gs'}</button>
          </div>
          <div class="cell-sub" style="margin-top:8px">Save with <b>${IS_MAC ? '⌘S' : 'Ctrl+S'}</b>.</div>
        </div>
      </li>
      <li class="cell">
        <span class="step-num">3</span>
        <div class="cell-main">
          <div class="cell-title">Deploy it as a web app</div>
          <div class="cell-sub">Click <b>Deploy › New deployment</b>, click the gear next to "Select type", and choose <b>Web app</b>. Set <b>Execute as</b> to <b>Me</b> and <b>Who has access</b> to <b>Anyone</b>, then click <b>Deploy</b>.</div>
          <div class="cell-sub" style="margin-top:6px">When Google asks for access, choose your account, then <b>Advanced › Go to project (unsafe) › Allow</b>. Google says "unsafe" only because the script is yours and unpublished.</div>
        </div>
      </li>
      <li class="cell">
        <span class="step-num">4</span>
        <div class="cell-main">
          <div class="cell-title">Paste the web app URL</div>
          <div class="cell-sub">Google shows it right after you deploy.</div>
          <input class="field" id="deployUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" spellcheck="false">
          <div class="step-actions"><button class="btn filled grow" data-action="connect" ${state.setup.busy ? 'disabled' : ''}>${state.setup.busy ? 'Connecting…' : 'Connect'}</button></div>
          ${r ? `<div class="result ${r.ok ? 'ok' : 'err'}">${esc(r.text)}${r.hint ? `<span class="hint">${esc(r.hint)}</span>` : ''}</div>` : ''}
        </div>
      </li>
    </ol>
    <p class="group-note">The script holds a private key that only this browser knows. Don't share the script or its URL.</p>`;
  const input = document.getElementById('deployUrl');
  if (state.setup.url) input.value = state.setup.url;
  input.addEventListener('input', () => { state.setup.url = input.value; });
}

function renderReconnect() {
  const r = state.reconnect.result;
  $view.innerHTML = `
    <p class="intro">Use this when the script is already in your Google account, for example after reinstalling Code Catcher. It takes about a minute.</p>
    <ol class="group steps">
      <li class="cell">
        <span class="step-num">1</span>
        <div class="cell-main">
          <div class="cell-title">Open your script</div>
          <div class="cell-sub">Signed in as that Gmail account, open your Code Catcher project in Apps Script. It may be called <b>Untitled project</b>.</div>
          <div class="step-actions"><button class="btn gray small" data-action="open-script-home">Open Apps Script ${I.arrow}</button></div>
        </div>
      </li>
      <li class="cell">
        <span class="step-num">2</span>
        <div class="cell-main">
          <div class="cell-title">Copy the access key</div>
          <div class="cell-sub">In <b>Code.gs</b>, copy the line that starts with <b>const ACCESS_KEY</b> (line 11) and paste it here.</div>
          <input class="field" id="reconnectKey" type="text" placeholder="const ACCESS_KEY = 'cc_…';" autocomplete="off" spellcheck="false">
        </div>
      </li>
      <li class="cell">
        <span class="step-num">3</span>
        <div class="cell-main">
          <div class="cell-title">Copy the web app URL</div>
          <div class="cell-sub">Click <b>Deploy › Manage deployments</b> and copy the <b>Web app URL</b>. It ends in /exec.</div>
          <input class="field" id="reconnectUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" spellcheck="false">
          <div class="step-actions"><button class="btn filled grow" data-action="connect-existing" ${state.reconnect.busy ? 'disabled' : ''}>${state.reconnect.busy ? 'Connecting…' : 'Connect'}</button></div>
          ${r ? `<div class="result ${r.ok ? 'ok' : 'err'}">${esc(r.text)}${r.hint ? `<span class="hint">${esc(r.hint)}</span>` : ''}</div>` : ''}
        </div>
      </li>
    </ol>
    <p class="group-note">The access key works like a password for your codes. Only paste it here.</p>`;
  const keyInput = document.getElementById('reconnectKey');
  const urlInput = document.getElementById('reconnectUrl');
  keyInput.value = state.reconnect.key;
  urlInput.value = state.reconnect.url;
  keyInput.addEventListener('input', () => { state.reconnect.key = keyInput.value; });
  urlInput.addEventListener('input', () => { state.reconnect.url = urlInput.value; });
}

async function saveConnection(url, key, email) {
  const accounts = await getAccounts();
  const existing = accounts.find((a) => a.email && a.email === email);
  const entry = { id: existing ? existing.id : crypto.randomUUID(), url, key, email, addedAt: Date.now() };
  await saveAccounts(existing ? accounts.map((a) => (a.id === existing.id ? entry : a)) : [...accounts, entry]);
}

async function connectExisting() {
  const key = parseAccessKey(state.reconnect.key);
  const cleaned = cleanDeploymentUrl(state.reconnect.url);
  if (!key) {
    state.reconnect.result = { ok: false, text: 'That doesn\'t look like the access key. Copy the whole line that starts with const ACCESS_KEY.' };
    return render();
  }
  if (cleaned.error) {
    state.reconnect.result = { ok: false, text: cleaned.error };
    return render();
  }
  state.reconnect.busy = true;
  state.reconnect.result = null;
  render();
  try {
    const data = await fetchAccount({ url: cleaned.url, key }, 5);
    await saveConnection(cleaned.url, key, data.account);
    state.reconnect = { url: '', key: '', result: { ok: true, text: `Connected to ${data.account}` }, busy: false };
    render();
    hud('Inbox connected', { ok: true });
    setTimeout(() => { state.view = 'codes'; state.firstLoad = true; bump(); poll(); render(); }, 900);
  } catch (e) {
    state.reconnect.busy = false;
    state.reconnect.result = { ok: false, text: e.message, hint: e.hint };
    render();
  }
}

async function checkUpdate() {
  const v = await updateReady();
  if (v !== state.updateVersion) {
    state.updateVersion = v;
    if (state.view === 'codes') render();
  }
}

/* ---------------- setup flow ---------------- */

async function startSetup() {
  const { pendingSetup } = await chrome.storage.local.get('pendingSetup');
  const key = pendingSetup && pendingSetup.key ? pendingSetup.key : newAccessKey();
  if (!pendingSetup) await chrome.storage.local.set({ pendingSetup: { key, at: Date.now() } });
  state.setup = { key, files: await buildScriptFiles(key), result: null, busy: false, url: '', copied: {} };
  state.returnTo = state.view === 'settings' ? 'settings' : 'codes';
  state.view = 'setup';
  window.scrollTo(0, 0);
  render();
}

async function connect() {
  const cleaned = cleanDeploymentUrl(state.setup.url);
  if (cleaned.error) {
    state.setup.result = { ok: false, text: cleaned.error };
    return render();
  }
  state.setup.busy = true;
  state.setup.result = null;
  render();
  try {
    const data = await fetchAccount({ url: cleaned.url, key: state.setup.key }, 5);
    await saveConnection(cleaned.url, state.setup.key, data.account);
    await chrome.storage.local.remove('pendingSetup');
    state.setup.busy = false;
    state.setup.result = { ok: true, text: `Connected to ${data.account}` };
    render();
    hud('Inbox connected', { ok: true });
    setTimeout(() => { state.view = 'codes'; state.firstLoad = true; bump(); poll(); render(); }, 900);
  } catch (e) {
    state.setup.busy = false;
    state.setup.result = { ok: false, text: e.message, hint: e.hint };
    render();
  }
}

function goBack() {
  state.view = state.view === 'setup' || state.view === 'reconnect' ? state.returnTo : 'codes';
  state.confirmRemove = null;
  window.scrollTo(0, 0);
  render();
}

/* ---------------- events ---------------- */

$view.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const holder = el.closest('[data-key]');
  const code = holder && state.data ? state.data.codes.find((c) => c.key === holder.dataset.key) : null;

  switch (action) {
    case 'fill': if (code) onFill(code); break;
    case 'copy': if (code) onCopy(code); break;
    case 'start-setup': startSetup(); break;
    case 'open-settings': state.view = 'settings'; render(); break;
    case 'open-script': chrome.tabs.create({ url: 'https://script.new' }); break;
    case 'copy-manifest':
      copyText(state.setup.files.manifest).then(() => { state.setup.copied.manifest = true; render(); });
      break;
    case 'copy-code':
      copyText(state.setup.files.code).then(() => { state.setup.copied.code = true; render(); });
      break;
    case 'connect': connect(); break;
    case 'start-reconnect': state.view = 'reconnect'; state.reconnect.result = null; window.scrollTo(0, 0); render(); break;
    case 'open-script-home': chrome.tabs.create({ url: 'https://script.google.com/home' }); break;
    case 'connect-existing': connectExisting(); break;
    case 'restart': chrome.runtime.reload(); break;
    case 'copy-script-update': {
      const acct = state.accounts.find((a) => a.id === el.dataset.id);
      if (!acct) break;
      buildScriptFiles(acct.key).then((files) => copyText(files.code)).then(() => {
        state.scriptCopied = { ...state.scriptCopied, [acct.id]: true };
        render();
      });
      break;
    }
    case 'theme':
      applyTheme(el.dataset.value);
      saveSettings({ theme: el.dataset.value }).then((s) => { state.settings = s; render(); });
      break;
    case 'shortcuts': chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); break;
    case 'remove': {
      const id = el.dataset.id;
      if (state.confirmRemove !== id) { state.confirmRemove = id; render(); break; }
      state.confirmRemove = null;
      getAccounts().then((accts) => saveAccounts(accts.filter((a) => a.id !== id)));
      break;
    }
    default: break;
  }
});

$view.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.action === 'autofill') {
    if (el.checked && !state.hasAllUrls) {
      chrome.permissions.request({ origins: ['<all_urls>'] }).then(async (granted) => {
        state.hasAllUrls = granted;
        state.settings = await saveSettings({ autoFill: granted });
        if (!granted) hud('Automatic filling needs access to the page you\'re on.');
        render();
      });
    } else {
      saveSettings({ autoFill: el.checked }).then((s) => { state.settings = s; });
    }
  }
  if (el.dataset.action === 'lookback') {
    saveSettings({ lookbackMinutes: Number(el.value) }).then((s) => { state.settings = s; poll(); });
  }
});

$view.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'deployUrl') connect();
  if (ev.key === 'Enter' && (ev.target.id === 'reconnectUrl' || ev.target.id === 'reconnectKey')) connectExisting();
});

$back.addEventListener('click', goBack);
$refresh.addEventListener('click', () => { bump(); poll({ manual: true }); });
document.getElementById('settingsBtn').addEventListener('click', () => {
  state.view = 'settings';
  state.confirmRemove = null;
  render();
});
window.addEventListener('scroll', () => $bar.classList.toggle('scrolled', window.scrollY > 4), { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); updateStatus(); return; }
  bump();
  poll();
  checkUpdate();
});
window.addEventListener('focus', () => { bump(); checkUpdate(); });
chrome.tabs.onActivated.addListener(bump);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') bump(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.used) { state.used = changes.used.newValue || {}; refresh(); }
  if (changes.accounts) {
    state.accounts = changes.accounts.newValue || [];
    if (state.data) state.data.codes = state.data.codes.filter((c) => state.accounts.some((a) => a.id === c.accountId));
    updateStatus();
    if (state.view !== 'setup') render();
    poll();
  }
});

chrome.permissions.onAdded.addListener(async () => { state.hasAllUrls = await chrome.permissions.contains({ origins: ['<all_urls>'] }); });
chrome.permissions.onRemoved.addListener(async () => { state.hasAllUrls = await chrome.permissions.contains({ origins: ['<all_urls>'] }); });

// Keep "3 min ago" labels fresh.
setInterval(() => { if (!document.hidden) refresh(); updateStatus(); }, 15000);
setInterval(() => { if (!document.hidden) checkUpdate(); }, 60000);

/* ---------------- boot ---------------- */

(async function init() {
  [state.accounts, state.settings, state.used, state.hasAllUrls] = await Promise.all([
    getAccounts(), getSettings(), getUsed(), chrome.permissions.contains({ origins: ['<all_urls>'] }),
  ]);
  applyTheme(state.settings.theme);
  updateStatus();
  render();
  poll();
  checkUpdate();
})();
