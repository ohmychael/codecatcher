#!/bin/bash
# Brings ~/code-catcher up to date with GitHub. launchd runs this every 15 minutes.
# Chrome sees the new files within a minute and Code Catcher reloads itself.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
DIR="$HOME/code-catcher"
BRANCH="main"
LOG="$HOME/Library/Logs/code-catcher-updater.log"
stamp() { date '+%Y-%m-%d %H:%M'; }

cd "$DIR" 2>/dev/null || exit 0

# Keep the log small.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if ! err=$(git fetch --quiet origin "$BRANCH" 2>&1); then
  echo "$(stamp) couldn't check for updates: $(echo "$err" | head -1)"
  exit 0
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]; then
  git reset --quiet --hard "origin/$BRANCH"
  echo "$(stamp) updated to $(git log -1 --format='%h %s')"
fi
