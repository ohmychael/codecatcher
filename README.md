# Code Catcher

Shows verification codes from your Gmail in Chrome's side panel. Click **Fill** to put a code into the page, or **Copy** to copy it. It updates itself from GitHub.

## Install on a Mac

**1. Download it and turn on auto-updates.** Paste this into Terminal (Applications › Utilities › Terminal) and press Return:

```bash
git clone https://github.com/ohmychael/codecatcher.git ~/code-catcher && bash ~/code-catcher/scripts/install.sh
```

**2. Add it to Chrome.**
1. Go to `chrome://extensions` and turn on **Developer mode** (top-right).
2. Remove any older Code Catcher on that page.
3. Click **Load unpacked**. In the file picker, press **⌘⇧H** to jump to your home folder, select **code-catcher**, and click **Select**.
4. Pin it from the puzzle-piece menu.

**3. Connect Gmail.** Open the panel and click **Connect Gmail**, then:
- If you've connected this inbox before, click **Reconnect it instead**. You'll paste the access key line and the web app URL from your existing script.
- Otherwise, follow the four steps in the panel.

## Updates

They're automatic. Your Mac checks GitHub every 15 minutes, and Code Catcher reloads itself when something new arrives. If the panel is open at that moment, it shows **Update ready** with a Restart button.

Once in a while, an update also changes the Gmail script. When that happens, the panel shows **Gmail script update** with a button that copies the new file and the steps to redeploy it. The URL stays the same.

- Update log: `~/Library/Logs/code-catcher-updater.log`
- To check for updates right away: `bash ~/code-catcher/scripts/update.sh`
- To stop auto-updates: `bash ~/code-catcher/scripts/uninstall.sh`

## Using it

- **Fill** puts the code into the code box on the page you're on.
- **Copy**, or clicking the big code, copies it.
- **⌥⇧K** fills the newest code without opening the panel. **⌥⇧C** opens the panel.
- **Settings**, under the gear icon:
  - Light, Dark or System theme
  - Extra inboxes
  - Automatic filling
  - How far back to look for codes

## Privacy and security

- The Gmail script runs in your own Google account with read-only access. It sends back only codes, senders, subjects and times, never whole emails.
- Each inbox's script has a private access key. Treat the web app URL and key like a password.
- No third-party code and no outside servers.
- Auto-fill hands your code to whatever page you're on. If you use it, be sure you're on the real site.

## Troubleshooting

| You see | Do this |
|---|---|
| Terminal asks to install developer tools | Click **Install**, wait for it to finish, then run the command again. |
| Terminal asks for a GitHub username and password | Username: your GitHub username. Password: a token. Make one at github.com › Settings › Developer settings › Fine-grained tokens, with access to only **codecatcher** and **Contents: Read-only**. Your Mac remembers it. |
| Google sent a web page instead of codes | In Apps Script, go to **Deploy › Manage deployments**. Edit the deployment so **Who has access** is **Anyone**. |
| Access key mismatch | Use **Reconnect it instead** with the key line from your script's Code.gs. |
| Gmail service not enabled | Replace `appsscript.json` in Apps Script with the one from setup. Save, then deploy a **New version**. |
