# S6 operations

The bridge remains foreground/one-shot and disposable. S6 adds no persistent
service, scheduler, NAS/live checkout access, deployment, SSH, Docker control,
`codex_run`, PR automation, or merge operation.

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

## S6 offline review stop

Run `npm run check`, `npm run s6:offline-proof`, `npm run s5:runtime-proof`, and
the S3 disposable workspace proof before any real credential work. The offline
proof uses only local fixtures and synthetic Keychain sentinels. Stop with the
S6 runtime and any disposable workspace destroyed; do not install or request
the real GitHub PAT and do not push the Homelab candidate from this phase.

The future real-proof gate is operator-controlled: provision an expiring
fine-grained PAT in the fixed S6 Keychain item with access only to
`cardkazuma/homelab` and Contents read/write, run one fixed-source clone and
ordinary Chat edit/test/diff/stage/hook-commit/publish flow, inspect the exact
generated branch and remote read-back, then recover/clean up and expire or
revoke that credential after review. That gate is not part of S6 offline
implementation.

## Stop/rollback

The proof removes its stopped container automatically. If a manual disposable
run was made, identify the exact S1 container by name and remove only that
container; remove the S1 image only after verifying its exact tag. Delete or
archive only the disposable fixture and this sibling fork if rollback is
needed. No canonical repository, NAS path, service, backup, credential, or
persistent host configuration is part of S1.
