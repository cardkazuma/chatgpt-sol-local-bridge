# Operations runbook

## Process topology

Run two independently supervised user processes:

1. Node MCP server on `127.0.0.1:8765`.
2. `tunnel-client run --profile sol-local-bridge`.

Provision the profile once. Runtime services should run it, not repeatedly reinitialize it.

## Lifecycle

macOS:

```bash
./scripts/service-macos.sh install|status|logs|restart|stop|start|uninstall
```

Linux:

```bash
./scripts/service-linux.sh install|status|logs|restart|stop|start|uninstall
```

Windows:

```powershell
.\scripts\windows\service.ps1 install|status|logs|restart|stop|start|uninstall
```

Uninstall keeps runtime configuration, state, approvals, audit records, and logs. Remove those manually only after deciding they are no longer needed.

## Health

```bash
curl -fsS http://127.0.0.1:8765/healthz
curl -fsS http://127.0.0.1:8765/readyz
npm run doctor
npm run smoke
```

`readyz` publishes the frozen 44-tool contract. `smoke` performs writes only inside a unique run directory under `BRIDGE_SCRATCH_DIR` (or `SMOKE_WORKSPACE`) and cleans it in `finally`.

## Logs/state

Default Unix state:

```text
~/.chatgpt-sol-local-bridge/
  audit/bridge.jsonl
  captures/
  logs/
  processes/
  pending-destructive.json
  state.json
```

Windows uses the same state folder under `%USERPROFILE%`. Agent-visible scratch data lives separately at `~/.chatgpt-sol-local-bridge-scratch` by default; internal state is not a file-tool root.

## Key/profile rotation

1. Create a replacement runtime API key.
2. Update `runtime.env` without changing its owner/permissions.
3. Run `tunnel-client doctor --profile <profile> --explain` through `scripts/run-with-env.mjs`.
4. Restart only the tunnel service.
5. Revoke the old key.

## Upgrade

```bash
git pull --ff-only
npm ci
npm run check
npm run doctor
# then restart services for your platform
```

Use a release checkout rather than an actively edited working tree for unattended operation. Keep filesystem snapshots/backups of connected projects.
