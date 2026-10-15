# Code Catcher: notes for whoever changes this code

Code Catcher (repo: github.com/ohmychael/codecatcher) is a Chrome extension (Manifest V3) that shows verification codes from Gmail in Chrome's side panel, with Fill and Copy buttons. It is a personal tool for one person (GitHub: ohmychael), loaded as an unpacked extension on their Mac.

## How changes reach the user (read this before pushing)

- The user's Mac keeps `~/code-catcher` in sync with `main` on GitHub. A launchd job runs `scripts/update.sh` every 15 minutes, which does `git fetch` plus `git reset --hard origin/main`.
- The extension checks once a minute whether `manifest.json` on disk has a different `version` than the running one. If so, it calls `chrome.runtime.reload()`. If the side panel is open, it shows an "Update ready" button instead.
- **So every push to `main` ships to the user within about 15 minutes.**
  - **Bump `version` in `manifest.json` on every change.** Without a bump the extension won't reload, and the user keeps running old code mixed with new files.
  - **Run the tests before pushing** (`npm test`). Never push a broken `main`.
- The Gmail side (`apps-script/Code.gs`) lives in the user's Google account and does not update itself. If you change it:
  1. Bump `VERSION` in `apps-script/Code.gs`.
  2. Bump `SCRIPT_VERSION` in `lib/core.js` to match.
  3. The panel then shows each inbox a "Gmail script update" notice, with a button that copies the new Code.gs with that inbox's key filled in.
  4. Avoid script changes unless they're needed, because each one costs the user a manual redeploy.
  - Keep `const ACCESS_KEY = '__ACCESS_KEY__';` exactly as written, on line 11. The setup flow substitutes the placeholder, and the Reconnect screen tells the user to copy line 11.

## Files

| Path | What it does |
|---|---|
| `manifest.json` | MV3 manifest. Bump `version` on every change. |
| `background.js` | Service worker: opens the panel from the toolbar icon, handles the ⌥⇧K fill shortcut, runs the self-update check. |
| `sidepanel.html` / `.css` / `.js` | The panel UI: codes list, Settings, Add Inbox, Reconnect Inbox. |
| `theme-boot.js` | Applies the saved light/dark theme before first paint. It's a classic script because MV3 forbids inline scripts. |
| `lib/core.js` | Shared logic: storage, fetching from the Gmail script, filling into pages (`fillCodeInPage` runs inside the web page), and the self-update check. |
| `apps-script/Code.gs`, `apps-script/appsscript.json` | The Gmail script the user pastes into Apps Script. It finds codes in recent mail and returns only code, sender, subject and time. Read-only `gmail.readonly` scope. |
| `scripts/install.sh`, `update.sh`, `uninstall.sh` | macOS installer and launchd auto-updater. |
| `tests/` | Extractor tests, a mocked-Gmail test of the script, a Chromium end-to-end test, and a self-update test. |

## Rules

- **Security:** no remote code, no third-party libraries, no CDNs. Everything ships in this repo.
- **Untrusted text:** anything that came from an email (sender, subject, code, context) is untrusted. Pass it through `esc()` before putting it into HTML.
- **Script output:** the Gmail script must keep returning only codes and minimal metadata, never full email bodies.
- **Filenames:** no file or folder names starting with `_`, because Chrome refuses to load the extension.
- **Design:** Apple-like, with SF Pro, grouped lists, capsule buttons, and a soft, matte palette defined as tokens at the top of `sidepanel.css`.
  - Light is the default. Dark follows the system unless Settings pins Light or Dark (`:root[data-theme]`).
  - Use the tokens, not literal colors.
  - Secondary text is 12.5–13.5px. The user asked for it to stay readable.
- **Code extractor:** the extractor in `Code.gs` is heuristic. When it misses a real email, add that email to `tests/extractor.test.js` first, then fix it.
- **Never commit** web app URLs, access keys, or anything from the user's inbox.

## Testing

```bash
npm test          # everything (needs Playwright + Chromium)
npm run test:fast # extractor + Gmail-script tests only, plain Node
```

The browser tests load a copy of the extension into Chromium with Developer mode on, and point it at a local mock of the Gmail script. Set `PLAYWRIGHT_DIR` if Playwright isn't resolvable from this folder, and `SHOTS=/some/dir` to keep screenshots.
