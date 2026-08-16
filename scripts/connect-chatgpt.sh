#!/usr/bin/env bash
# Interactive one-time configuration for macOS/Linux.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-sol-local-bridge"
ENV_FILE="$CONFIG_DIR/runtime.env"
PROFILE_DEFAULT="sol-local-bridge"
TMP=""
cleanup() { [ -z "$TMP" ] || rm -f "$TMP"; unset API_KEY 2>/dev/null || true; }
trap cleanup EXIT

command -v node >/dev/null || { echo "Node 20+ is required" >&2; exit 1; }
command -v tunnel-client >/dev/null || { echo "Install: brew install openai/tools/tunnel-client" >&2; exit 1; }
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

printf "Tunnel ID (tunnel_...): "
read -r TUNNEL_ID
[[ "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9_-]+$ ]] || { echo "invalid tunnel id" >&2; exit 1; }
printf "Runtime API key (input hidden): "
IFS= read -rs API_KEY
echo
[ -n "$API_KEY" ] || { echo "API key is required" >&2; exit 1; }
printf "Workspace roots (colon-separated) [%s]: " "$REPO_DIR"
read -r WORKSPACE_ROOTS
WORKSPACE_ROOTS="${WORKSPACE_ROOTS:-$REPO_DIR}"
FIRST_ROOT="${WORKSPACE_ROOTS%%:*}"
printf "Default workspace (one directory) [%s]: " "$FIRST_ROOT"
read -r DEFAULT_WORKSPACE
DEFAULT_WORKSPACE="${DEFAULT_WORKSPACE:-$FIRST_ROOT}"
printf "Tunnel profile [%s]: " "$PROFILE_DEFAULT"
read -r PROFILE
PROFILE="${PROFILE:-$PROFILE_DEFAULT}"

TMP="$ENV_FILE.$$.tmp"
umask 077
if [ -f "$REPO_DIR/.env" ]; then
  grep -Ev '^(WORKSPACE_ROOTS|DEFAULT_WORKSPACE|MCP_TOKEN|CONTROL_PLANE_TUNNEL_ID|CONTROL_PLANE_API_KEY|TUNNEL_PROFILE|TUNNEL_HEALTH_PORT)=' "$REPO_DIR/.env" > "$TMP" || true
else
  cat > "$TMP" <<EOF
HOST=127.0.0.1
PORT=8765
ALLOW_TOOL_ROOT_REGISTRATION=false
INCLUDE_COMMON_WORKSPACE_ROOTS=false
DESTRUCTIVE_APPROVAL_MODE=chat
ALLOW_PRIVATE_NETWORK=false
EOF
fi
cat >> "$TMP" <<EOF
WORKSPACE_ROOTS=$WORKSPACE_ROOTS
DEFAULT_WORKSPACE=$DEFAULT_WORKSPACE
CONTROL_PLANE_TUNNEL_ID=$TUNNEL_ID
CONTROL_PLANE_API_KEY=$API_KEY
TUNNEL_PROFILE=$PROFILE
TUNNEL_HEALTH_PORT=8766
EOF
mv "$TMP" "$ENV_FILE"
TMP=""
chmod 600 "$ENV_FILE"
unset API_KEY

HOST_VALUE="$(node "$REPO_DIR/scripts/runtime-value.mjs" "$ENV_FILE" HOST)"
PORT_VALUE="$(node "$REPO_DIR/scripts/runtime-value.mjs" "$ENV_FILE" PORT)"
URL_HOST="$HOST_VALUE"; [[ "$URL_HOST" == *:* ]] && URL_HOST="[$URL_HOST]"
HEALTH_PORT="$(node "$REPO_DIR/scripts/runtime-value.mjs" "$ENV_FILE" TUNNEL_HEALTH_PORT)"
node "$REPO_DIR/scripts/run-with-env.mjs" "$ENV_FILE" -- \
  tunnel-client init \
    --force \
    --sample sample_mcp_remote_no_auth \
    --profile "$PROFILE" \
    --tunnel-id "$TUNNEL_ID" \
    --health-listen-addr "127.0.0.1:$HEALTH_PORT" \
    --mcp-server-url "http://$URL_HOST:$PORT_VALUE/mcp"

node "$REPO_DIR/scripts/run-with-env.mjs" "$ENV_FILE" -- \
  tunnel-client doctor --profile "$PROFILE" --explain

cat <<EOF

Configured successfully.
Runtime config: $ENV_FILE (mode 0600; authoritative for persistent services)
Profile: $PROFILE
MCP endpoint: http://$URL_HOST:$PORT_VALUE/mcp
Tunnel readiness: http://127.0.0.1:$HEALTH_PORT/readyz

Local test:
  cd "$REPO_DIR"
  BRIDGE_ENV_FILE="$ENV_FILE" npm run start:all

Then create the ChatGPT developer-mode app:
  https://chatgpt.com/#settings/Connectors
  Connection = Tunnel → select $TUNNEL_ID
EOF
