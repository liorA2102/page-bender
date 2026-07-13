#!/bin/bash
# One-time setup: installs the Page Bender companion server as a launchd
# agent so it's always running in the background (RunAtLoad + KeepAlive) —
# no manual `npm start` needed, and it restarts automatically if it ever
# crashes. Then opens the two things you need for the last manual step
# (loading the extension into Chrome).
#
# (An earlier version tried launchd Socket Activation instead — dormant
# until first connection, idle-exit after 10 minutes — but fd:3 socket
# passing failed in practice (ENOTTY) and caused a real crash-loop. Simpler
# and proven beats clever and broken.)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR/.." && pwd)"
EXTENSION_DIR="$DIR/../extension"
EXTENSION_DIR="$(cd "$EXTENSION_DIR" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.aura.pagemock.plist"

# Downloaded/cloned files carry a Gatekeeper quarantine flag, which is why
# macOS warns "unidentified developer" the first time this file is opened
# (fixed by right-click > Open once, per the README/landing page). Clearing
# it here for the whole repo means uninstall.command and any re-run of this
# script never need that workaround again after the first successful run.
xattr -dr com.apple.quarantine "$REPO_DIR" 2>/dev/null || true

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed — install it first (e.g. \`brew install node\`), then run this again."
  exit 1
fi
NODE_BIN="$(command -v node)"

if ! command -v claude >/dev/null 2>&1; then
  echo "The Claude Code CLI isn't installed — Page Bender's editing agent runs through it."
  echo "Install it, log in, then run this again: https://docs.claude.com/en/docs/claude-code"
  exit 1
fi

if [ ! -d "$DIR/node_modules" ]; then
  echo "Installing server dependencies..."
  (cd "$DIR" && npm install)
fi

mkdir -p "$HOME/Library/Logs/PageMock"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.aura.pagemock</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/PageMock/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/PageMock/server.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1

if curl -s -o /dev/null -w "" "http://127.0.0.1:8790/mock-toolbar.js"; then
  echo "Page Bender server installed and running at http://127.0.0.1:8790"
else
  echo "Installed, but the server didn't respond yet — check $HOME/Library/Logs/PageMock/server.err.log"
fi

echo ""
echo "Last step: load the extension into Chrome."
echo "  1. In the Chrome tab that's about to open, turn on Developer Mode (top-right)."
echo "  2. Click \"Load unpacked.\""
echo "  3. Pick the folder that's about to open in Finder."

open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
open -R "$EXTENSION_DIR" 2>/dev/null || true
