#!/bin/bash
# Code Catcher installer for macOS.
#
# Puts Code Catcher in ~/code-catcher and installs a small background job that keeps
# that folder in sync with GitHub. Chrome notices new files within a minute and the
# extension reloads itself, so you never update by hand.
#
# Run it once:
#   git clone https://github.com/ohmychael/codecatcher.git ~/code-catcher && bash ~/code-catcher/scripts/install.sh
set -euo pipefail

REPO="https://github.com/ohmychael/codecatcher.git"
DIR="$HOME/code-catcher"
LABEL="com.codecatcher.updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/code-catcher-updater.log"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ ! -d "$DIR/.git" ]; then
  bold "Downloading Code Catcher to $DIR"
  git clone --quiet "$REPO" "$DIR"
fi

bold "Installing the auto-updater"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/scripts/update.sh</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

bold "All set. Code Catcher now checks GitHub for updates every 15 minutes."
cat <<MSG

Next, in Chrome:
  1. Go to chrome://extensions and remove the old Code Catcher, if you have one.
  2. Click "Load unpacked". In the file picker, press Command-Shift-H to jump to
     your home folder, select "code-catcher", and click Select.
  3. Pin it, open the panel, and choose Connect Gmail, then "Reconnect it instead".

Update log: $LOG
MSG
