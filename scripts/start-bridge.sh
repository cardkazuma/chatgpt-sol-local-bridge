#!/usr/bin/env bash
# Foreground development runner: MCP server + tunnel-client.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-sol-local-bridge/runtime.env}"
[ -f "$BRIDGE_ENV_FILE" ] || { echo "missing $BRIDGE_ENV_FILE; run $REPO/scripts/connect-chatgpt.sh" >&2; exit 1; }
exec node "$REPO/scripts/start-all.mjs"
