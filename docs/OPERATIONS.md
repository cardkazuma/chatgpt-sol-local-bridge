# S1 operations

S1 is intentionally foreground/one-shot only. Do not install a LaunchAgent,
systemd service, scheduler, tunnel client, ChatGPT connection, or other
persistent runtime at this stage.

## Read-only checks

From this fork:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
node src/doctor.js --json
```

`doctor` is a local diagnostic. Its `runtime mode` check must report the
hardened container configuration when used for S1 runtime review.

## Disposable container proof

Run:

```sh
node scripts/s1-host-proof.mjs
```

The wrapper creates a fresh repository and fake credential sentinels under the
system temporary directory, runs `docker compose config -q`, builds the pinned
image, executes the in-container adversarial/normal-function proof, inspects
the stopped container, verifies host sentinels, and removes only that temporary
container and fixture.

The proof must report `containerExit: 0`, `passed: 13`, `failed: 0`, and
`hostSentinelsUnchanged: true`. A failed proof is not a redeployment approval.

## Compose inputs

`compose.yaml` requires these values and must receive them only from the
disposable proof or an equivalently isolated fixture:

```text
BRIDGE_WORKSPACE=/absolute/path/to/disposable-repository
BRIDGE_GIT_CONFIG=/absolute/path/to/disposable-repository/.git/config
BRIDGE_GITHOOKS=/absolute/path/to/disposable-repository/.githooks
BRIDGE_POLICY_FILE=/absolute/path/to/disposable-repository/scripts/pre-commit-policy.mjs
```

The service has no published port and no restart policy. Its only writable
host mount is the disposable repository; the nested Git governance mounts are
read-only. Do not substitute a normal working copy, a homelab checkout,
`/volume1/docker`, a home directory, a NAS path, or a credential-bearing path.

## Stop/rollback

The proof removes its stopped container automatically. If a manual disposable
run was made, identify the exact S1 container by name and remove only that
container; remove the S1 image only after verifying its exact tag. Delete or
archive only the disposable fixture and this sibling fork if rollback is
needed. No canonical repository, NAS path, service, backup, credential, or
persistent host configuration is part of S1.
