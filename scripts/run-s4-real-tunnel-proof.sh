#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bridge-s4-credentials.XXXXXX")"
CREDENTIAL_FILE="$TMP_DIR/control-plane.env"
TTY_STATE=""

cleanup() {
  if [ -n "$TTY_STATE" ]; then
    stty "$TTY_STATE" < /dev/tty 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

umask 077
printf "Tunnel ID (input visible): " >&2
IFS= read -r TUNNEL_ID < /dev/tty
case "$TUNNEL_ID" in
  tunnel_*) ;;
  *) printf '%s\n' "invalid tunnel id" >&2; exit 2 ;;
esac

printf 'Runtime API key (input hidden): ' >&2
TTY_STATE="$(stty -g < /dev/tty)"
stty -echo < /dev/tty
IFS= read -r API_KEY < /dev/tty
stty "$TTY_STATE" < /dev/tty
TTY_STATE=""
printf '\n' >&2
[ -n "$API_KEY" ] || { printf '%s\n' "runtime API key is required" >&2; exit 2; }
printf 'CONTROL_PLANE_API_KEY=%s\n' "$API_KEY" > "$CREDENTIAL_FILE"
unset API_KEY

set +e
S4_TUNNEL_ID="$TUNNEL_ID" \
S4_CREDENTIAL_FILE="$CREDENTIAL_FILE" \
npm --prefix "$REPO_DIR" run s4:real-tunnel-proof
status=$?
set -e
exit "$status"
