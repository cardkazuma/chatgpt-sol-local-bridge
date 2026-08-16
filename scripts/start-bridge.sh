#!/bin/bash
# Start the sol-local-bridge tunnel (stdio profile, outbound-only).
#
# Prereq: create ~/.config/sol-bridge/env (chmod 600) containing:
#   CONTROL_PLANE_API_KEY=sk-...     # Platform key with Tunnels Read+Use
#   TUNNEL_ID=tunnel_...             # from platform.openai.com .../tunnels
#   BRIDGE_WORKSPACE_ROOT=$HOME/bridge-workspace
set -euo pipefail

ENV_FILE="$HOME/.config/sol-bridge/env"
PROFILE="local-bridge"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$REPO_DIR/examples/server.py"
PY="$REPO_DIR/.venv/bin/python"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE — see scripts/README quickstart"; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${CONTROL_PLANE_API_KEY:?set CONTROL_PLANE_API_KEY in $ENV_FILE}"
: "${TUNNEL_ID:?set TUNNEL_ID in $ENV_FILE}"
: "${BRIDGE_WORKSPACE_ROOT:=$HOME/bridge-workspace}"
export BRIDGE_WORKSPACE_ROOT

if ! tunnel-client profiles list 2>/dev/null | grep -q "^$PROFILE\b"; then
  tunnel-client init \
    --profile "$PROFILE" \
    --tunnel-id "$TUNNEL_ID" \
    --mcp-command "$PY $SERVER"
fi

tunnel-client doctor --profile "$PROFILE" --explain
exec tunnel-client run --profile "$PROFILE"
