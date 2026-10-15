#!/bin/bash
# Stops Code Catcher's auto-updater. Your extension keeps working; it just stops updating.
LABEL="com.codecatcher.updater"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Auto-updater removed. To remove Code Catcher completely, remove it in chrome://extensions and delete ~/code-catcher."
