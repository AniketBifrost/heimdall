#!/usr/bin/env bash
# Heimdall — tiny POSIX activation probe.
#
# The real gate is heimdall-gate.js, which self-checks the state file and fail-opens on
# every path (cross-platform, no bash dependency). This script is a convenience for POSIX
# users / manual checks and CI: exit 0 = dormant (no state file), exit 10 = active.
dir="${CLAUDE_PROJECT_DIR:-.}/.claude"
if [ ! -f "$dir/.heimdall-active" ]; then
  exit 0
fi
echo "heimdall-active: $(cat "$dir/.heimdall-active" 2>/dev/null || echo strict)"
exit 10
