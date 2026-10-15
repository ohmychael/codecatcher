import { fetchAllCodes, fillIntoTab, getSettings, getUsed, markUsed, updateReady, FRESH_MINUTES } from './lib/core.js';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Auto-update: the folder is kept in sync with GitHub by a job on the Mac. Check once a minute
// and reload when new files land. If the side panel is open, it shows a Restart button instead,
// so it never closes under you.
chrome.alarms.get('check-update').then((a) => { if (!a) chrome.alarms.create('check-update', { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'check-update') checkForUpdate(); });
chrome.runtime.onStartup.addListener(() => { checkForUpdate(); });

async function checkForUpdate() {
  if (!(await updateReady())) return false;
  const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
  if (panels.length) return false;
  chrome.runtime.reload();
  return true;
}

// ⌥⇧K: fill the newest unused code into the current page.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'fill-latest') fillLatest(tab);
});

async function fillLatest(tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const flash = async (text, color) => {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color });
    await chrome.action.setBadgeText({ tabId: tab.id, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2500);
  };

  try {
    const settings = await getSettings();
    const [{ codes }, used] = await Promise.all([fetchAllCodes(settings.lookbackMinutes), getUsed()]);
    const fresh = codes.filter((c) => Date.now() - c.receivedAt < FRESH_MINUTES * 60e3);
    const pick = fresh.find((c) => !used[c.key]) || fresh[0];
    if (!pick) return flash('0', '#6b7280');
    const res = await fillIntoTab(tab.id, pick.code);
    if (res.ok) {
      await markUsed(pick.key, 'filled');
      flash('✓', '#059669');
    } else {
      flash('?', '#d97706');
    }
  } catch {
    flash('!', '#dc2626');
  }
}

// Handy for debugging from the service worker console.
globalThis.fillLatest = fillLatest;
globalThis.checkForUpdate = checkForUpdate;
