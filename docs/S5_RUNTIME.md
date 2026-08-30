# S5 runtime controller

The S5 controller is an explicit, foreground-operator lifecycle around the
accepted S4 topology. It does not install a LaunchAgent, persist a login item,
enable Git push, or grant the bridge NAS, SSH, browser, desktop, Docker, or
`codex_run` authority.

The controller commands are:

```text
node scripts/s5-runtime.mjs keychain install
node scripts/s5-runtime.mjs workspace create --source /absolute/path/to/disposable-fixture
node scripts/s5-runtime.mjs workspace list
node scripts/s5-runtime.mjs start --source /absolute/path/to/disposable-fixture --tunnel-id tunnel_...
node scripts/s5-runtime.mjs status
node scripts/s5-runtime.mjs doctor
node scripts/s5-runtime.mjs stop
node scripts/s5-runtime.mjs recover
node scripts/s5-runtime.mjs workspace destroy --session s5-...
node scripts/s5-runtime.mjs rollback
```

`start` additionally requires the reviewed tunnel-client Linux binary, release
asset, checksum file, provenance bundle, and an available pinned sidecar image.
These are supplied through the existing S4 release inputs or the corresponding
`S5_TUNNEL_*` environment variables. The runtime key is read from the single
fixed macOS Keychain item identified by the controller and is handed to the
tunnel-client container through one mode-0600 temporary env file. The bridge,
relay, repository commands, audit records, and status output never receive the
key.

Each session is a full-history clone made without local-object hardlinks. The
manager rejects canonical checkouts, normal-user home sources, NAS paths,
secret/runtime filenames, symlinks, and inherited Git credentials. Session
state uses the `s5-` namespace and is reaped only when its heartbeat is stale
and its recorded PID is no longer alive.

The host controller records bounded, redacted lifecycle events under its private
runtime root. The runtime state omits the relay bearer; temporary credential and
relay env files are removed in `finally` blocks. `stop` removes only runtime
containers, networks, volumes, image, profile, trust bundle, and controller
state. It does not destroy a disposable workspace. `rollback` explicitly
destroys S5 disposable workspaces and controller runtime state but does not
revoke the Keychain item.

The regular-use readiness gate is fail-closed: the exact 27-tool catalog,
bridge health/readiness, relay/MCP startup probe, tunnel `/readyz`, successful
control-plane poll, pinned tunnel provenance, container boundaries, and
credential plane must all pass before `start` returns running.
