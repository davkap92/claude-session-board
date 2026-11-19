#!/usr/bin/env bash
# Install a launchd agent that starts the board at login and restarts it if it exits.
# Usage: scripts/install-launchd.sh            install (or reinstall) and start
#        scripts/install-launchd.sh uninstall  stop and remove
set -euo pipefail

LABEL="com.local.claude-session-board"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-session-board.log"
DOMAIN="gui/$(id -u)"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "node not found on PATH" >&2; exit 1; }
# Resolve version-manager shims (fnm, nvm) to the real binary so launchd can run it.
NODE="$(node -p 'process.execPath')"

# launchd starts with a bare PATH; give it the dirs that hold claude and gh.
AGENT_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
for bin in claude gh; do
  p="$(command -v "$bin" || true)"
  [[ -n "$p" ]] && AGENT_PATH="$(dirname "$p"):$AGENT_PATH"
done

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone; bootstrap fails until it is.
for _ in {1..20}; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL using $NODE"
echo "Board: http://127.0.0.1:4777  Logs: $LOG"
