#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 2; }

ACTION="${1:-status}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${BRIDGE_ENV_FILE:-$HOME/.config/chatgpt-sol-local-bridge/runtime.env}"
NODE="$(command -v node)"
TUNNEL="$(command -v tunnel-client || true)"
DOMAIN="gui/$(id -u)"
SERVER_LABEL="com.chatgpt-sol-local-bridge.server"
TUNNEL_LABEL="com.chatgpt-sol-local-bridge.tunnel"
PLIST_DIR="$HOME/Library/LaunchAgents"
STATE="$HOME/.chatgpt-sol-local-bridge"
LOG_DIR="$STATE/logs"

xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

write_plist() {
  local label="$1"; shift
  local out="$PLIST_DIR/$label.plist"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$(xml "$label")</string>
<key>ProgramArguments</key><array>
EOF
    for arg in "$@"; do printf '<string>%s</string>\n' "$(xml "$arg")"; done
    cat <<EOF
</array>
<key>WorkingDirectory</key><string>$(xml "$REPO")</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Interactive</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>$(xml "$LOG_DIR/${label##*.}.out.log")</string>
<key>StandardErrorPath</key><string>$(xml "$LOG_DIR/${label##*.}.err.log")</string>
</dict></plist>
EOF
  } > "$out"
  chmod 600 "$out"
}

case "$ACTION" in
  install)
    [ -x "$NODE" ] || { echo "Node 20+ not found" >&2; exit 1; }
    [ -x "$TUNNEL" ] || { echo "tunnel-client not found" >&2; exit 1; }
    [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE; run scripts/connect-chatgpt.sh" >&2; exit 1; }
    MODE="$(stat -f '%Lp' "$ENV_FILE")"
    [ "$MODE" = "600" ] || { echo "$ENV_FILE must be mode 0600 (currently $MODE)" >&2; exit 1; }
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    chmod 700 "$STATE" "$LOG_DIR"
    write_plist "$SERVER_LABEL" "$NODE" "$REPO/scripts/run-with-env.mjs" "$ENV_FILE" --exclude=CONTROL_PLANE_API_KEY -- "$NODE" "$REPO/src/server.js"
    write_plist "$TUNNEL_LABEL" "$NODE" "$REPO/scripts/run-with-env.mjs" "$ENV_FILE" -- "$NODE" "$REPO/scripts/run-tunnel.mjs" "$TUNNEL"
    for label in "$SERVER_LABEL" "$TUNNEL_LABEL"; do
      plist="$PLIST_DIR/$label.plist"
      plutil -lint "$plist" >/dev/null
      launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
      launchctl bootstrap "$DOMAIN" "$plist"
      launchctl kickstart -k "$DOMAIN/$label"
    done
    sleep 2
    "$0" status
    ;;
  uninstall)
    for label in "$TUNNEL_LABEL" "$SERVER_LABEL"; do
      launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
      rm -f "$PLIST_DIR/$label.plist"
    done
    echo "services uninstalled; runtime config and logs were kept"
    ;;
  start)
    for label in "$SERVER_LABEL" "$TUNNEL_LABEL"; do
      plist="$PLIST_DIR/$label.plist"
      launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || launchctl bootstrap "$DOMAIN" "$plist"
      launchctl kickstart -k "$DOMAIN/$label"
    done
    ;;
  restart)
    for label in "$TUNNEL_LABEL" "$SERVER_LABEL"; do launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true; done
    for label in "$SERVER_LABEL" "$TUNNEL_LABEL"; do launchctl bootstrap "$DOMAIN" "$PLIST_DIR/$label.plist"; launchctl kickstart -k "$DOMAIN/$label"; done
    ;;
  stop)
    for label in "$TUNNEL_LABEL" "$SERVER_LABEL"; do launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true; done
    ;;
  status)
    failed=0
    for label in "$SERVER_LABEL" "$TUNNEL_LABEL"; do
      if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then echo "✓ $label loaded"; else echo "✗ $label not loaded"; failed=1; fi
    done
    if [ -f "$ENV_FILE" ]; then
      host="$($NODE "$REPO/scripts/runtime-value.mjs" "$ENV_FILE" HOST)"
      port="$($NODE "$REPO/scripts/runtime-value.mjs" "$ENV_FILE" PORT)"
      url_host="$host"; [[ "$url_host" == *:* ]] && url_host="[$url_host]"
      curl -fsS "http://$url_host:$port/healthz" 2>/dev/null || failed=1
      tunnel_port="$($NODE "$REPO/scripts/runtime-value.mjs" "$ENV_FILE" TUNNEL_HEALTH_PORT)"
      curl -fsS "http://127.0.0.1:$tunnel_port/readyz" 2>/dev/null || { echo "✗ tunnel not ready"; failed=1; }
    else
      echo "✗ runtime env missing: $ENV_FILE"; failed=1
    fi
    echo
    exit "$failed"
    ;;
  logs)
    tail -n 100 "$LOG_DIR"/*.log 2>/dev/null || echo "no logs yet"
    ;;
  logs-follow)
    echo "following logs; press Ctrl-C to stop"
    touch "$LOG_DIR/server.err.log" "$LOG_DIR/server.out.log" "$LOG_DIR/tunnel.err.log" "$LOG_DIR/tunnel.out.log"
    tail -n 100 -f "$LOG_DIR"/*.log
    ;;
  *) echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs|logs-follow}" >&2; exit 2 ;;
esac
