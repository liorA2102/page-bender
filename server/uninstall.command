#!/bin/bash
# Stops and removes the Page Mock launchd agent installed by install.command.
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.aura.pagemock.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Page Mock server stopped and uninstalled."
