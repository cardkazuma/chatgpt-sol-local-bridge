# S1 review report

Status: implementation complete and stopped for review. S2 has not started.
The fork remains a local working tree based on the exact audited upstream
commit. No tunnel, ChatGPT connection, persistent service, staging repository,
NAS access, or canonical repository mutation was performed.

## 1. Upstream commit

Exact audited upstream commit used:

```text
3c7b0c0fffa0e04f4533f871ece3da0064cf6620
```

The upstream repository `HEAD` and `main` ref resolved to that commit before
the sibling local fork was created. Local `HEAD` is still that commit; S1 work
is an uncommitted reviewable diff.

## 2. Exact fork changes

Runtime and policy code:

- `.env.example` — S1-only container configuration and exact catalog.
- `.dockerignore`, `Dockerfile`, `compose.yaml` — pinned image and disposable
  runtime containment.
- `src/tool-contract.js`, `src/lib/tool-registry.js` — fail-closed catalog and
  registration gate.
- `src/server.js`, `src/doctor.js` — S1 registration/readiness/diagnostics.
- `src/lib/config.js`, `src/lib/exec.js` — hardened configuration, environment
  filtering, bounded commands, and Linux process identity.
- `src/lib/paths.js` — canonical workspace and repository-sensitive path
  enforcement.
- `src/lib/git-governance.js`, `.githooks/pre-commit`,
  `scripts/pre-commit-policy.mjs` — reviewed hook enforcement and hash pin.
- `src/tools/policy.js`, `workspace.js`, `files.js`, `git.js`, `project.js`,
  `process.js` — S1-only active tools and structured operations.
- `src/tools/desktop.js` — retained upstream implementation is also routed
  through the catalog gate if imported; it is not registered by S1.
- `package.json`, `package-lock.json` — exact direct dependency versions,
  lockfile, private local package, and no persistent start-all/dev scripts.

Tests and proof:

- `tests/integration/server.test.js` and unit tests for catalog/path fixtures —
  S1 discovery, path, Git, and disposable-file coverage.
- `scripts/s1-host-proof.mjs` — disposable host-side fixture, Compose config
  validation, image build, container inspection, and sentinel verification.
- `scripts/s1-container-proof.mjs` — in-container adversarial and normal-use
  matrix.
- `scripts/smoke.mjs` — S1 catalog and disposable-workspace smoke path.

Review documentation:

- `README.md`, `PROVENANCE.md`, `docs/S1_REVIEW.md`,
  `docs/SECURITY.md`, `docs/OPERATIONS.md`, `docs/CHATGPT_SETUP.md`,
  `docs/PLATFORMS.md`, and `launchd/README.md` — S1 scope and no-connection
  guidance.

Complete changed-file manifest:

```text
.dockerignore
.env.example
.gitignore
.githooks/pre-commit
Dockerfile
PROVENANCE.md
README.md
compose.yaml
docs/CHATGPT_SETUP.md
docs/OPERATIONS.md
docs/PLATFORMS.md
docs/SECURITY.md
docs/S1_REVIEW.md
launchd/README.md
package-lock.json
package.json
scripts/pre-commit-policy.mjs
scripts/s1-container-proof.mjs
scripts/s1-host-proof.mjs
scripts/smoke.mjs
src/doctor.js
src/lib/config.js
src/lib/exec.js
src/lib/git-governance.js
src/lib/paths.js
src/lib/tool-registry.js
src/server.js
src/tool-contract.js
src/tools/desktop.js
src/tools/files.js
src/tools/git.js
src/tools/policy.js
src/tools/process.js
src/tools/project.js
src/tools/workspace.js
tests/integration/server.test.js
tests/unit/external-approval.test.js
tests/unit/office.test.js
tests/unit/paths.test.js
tests/unit/tool-contract.test.js
```

## 3. Exact enabled MCP catalog

The default `ENABLED_TOOLS` value and discovery order are:

```text
bridge_instructions
workspace_list
workspace_open
workspace_tree
workspace_snapshot
read_file
search_text
write_file
apply_patch
edit_file
git_status
git_diff
git_log
git_branch_create
git_branch_switch
git_stage
git_commit
project_test
project_lint
project_typecheck
project_build
repo_shell
process_start
process_list
process_logs
process_stop
health
```

`ENABLED_TOOLS` may reduce this set. Empty, duplicate, unknown, or later
capability names fail configuration parsing. Discovery is driven only by the
registered subset, so a disabled tool is absent from MCP `tools/list`.

## 4. Disabled capability families

The S1 server does not register or expose:

- upstream `git_run`, Git push/fetch, remote mutation, worktree/clone, or
  arbitrary Git operations;
- upstream `shell` and `codex_run` (S1 exposes only contained `repo_shell`);
- `workspace_add_root`, destructive confirmation/pending tools, and Penpot;
- browser/CDP, accessibility, keyboard/mouse, vision, window, clipboard,
  notification, file-dialog, screen, and audio tools;
- `web_fetch`, Office, scheduler, and native desktop integrations;
- NAS, Docker-control, SSH, arbitrary host-system, and broad `system_info`
  tools; and
- OpenAI Secure MCP Tunnel, ChatGPT connection, GitHub credentials, and
  persistent service/LaunchAgent lifecycle.

Retained upstream implementation files are not an exposure: S1 does not
import their registration function, every registration site uses the catalog
gate, and unnecessary desktop/Office/web/test/service files are excluded from
the runtime image.

## 5. Container/isolation configuration

The reviewed `compose.yaml` and proof inspection establish:

| Control | S1 value |
| --- | --- |
| User | `10001:10001`, non-root |
| Image root | read-only |
| Linux capabilities | `cap_drop: ALL` |
| Privilege escalation | `no-new-privileges:true` |
| Network | `network_mode: none` |
| CPU | 1.0 CPU |
| Memory/swap | 512 MiB / 512 MiB |
| PIDs | 128 |
| `/tmp` | 64 MiB, `noexec,nosuid,nodev` |
| `/state` | 64 MiB, `noexec,nosuid,nodev`, container-owned |
| published ports | none |
| host namespaces/devices | none |
| Docker socket | none |

Exactly four bind mounts are configured:

- disposable repository → `/workspace/repo`, read/write;
- disposable repository `.git/config` → `/workspace/repo/.git/config`,
  read-only;
- disposable reviewed hooks → `/workspace/repo/.githooks`, read-only; and
- disposable reviewed policy helper →
  `/workspace/repo/scripts/pre-commit-policy.mjs`, read-only.

The proof used no user home, existing working copy, `/volume1/docker`, NAS,
`/Volumes`, device, host namespace, or host filesystem root mount.

## 6. Credential boundaries

The container environment has no OpenAI tunnel credentials, GitHub credentials,
Codex configuration, SSH material, NAS credentials, Docker credentials, or
normal-user secrets. The Compose service supplies an explicit environment list;
it does not pass the host environment through. `toolEnvironment()` further
uses a small allowlist in hardened mode, and the server removes an inherited
control-plane key before tool registration.

The image build context excludes `.env*`, `.npmrc`, private-key formats,
databases, runtime/log/backup directories, desktop/web source, tests, docs,
LaunchAgent files, and unused service scripts. Build-time dependency download
is separate from the runtime's `network_mode: none`.

## 7. Git governance enforcement

Structured Git writes are limited to:

- local branch creation after `check-ref-format` validation;
- local branch switching with `--no-guess` and no discard flag;
- selected existing regular-file staging with literal path arguments; and
- commit of selected staged paths after exact hook/policy checks.

The structured implementation has no input for `--no-verify`, force, amend,
rebase, reset, restore, clean, remote, push, fetch, worktree, clone, or Git
config mutation. The command environment disables terminal prompts and global
Git config. `.git/config`, `.githooks`, and the policy helper are read-only
binds in the runtime. `git_commit` requires `core.hooksPath=.githooks`, an
executable exact hook, and the reviewed policy hash:

```text
e051fa3873aff3299b30590a3d6c54a901cbff31dbeafcd625e9c69cf6a42b2f
```

The policy rejects staged sensitive/ignored paths, staged symlinks, and
unexpected hook configuration. The proof confirmed that shell attempts to
change `core.hooksPath`, add a remote, or overwrite the mounted hook/policy
failed.

`repo_shell` remains arbitrary by design. A command can attempt
`--no-verify` or other Git mutation inside the disposable checkout; S1
contains that trust boundary by making the checkout disposable, isolating its
mounts, removing network access, and exposing no such operation as a
structured MCP tool.

## 8. Secret-path enforcement

All structured file/workspace operations use canonical path checks plus a
repository-aware visibility check. The deny policy covers:

- `.env` and `.env.*`, `db.env`, `secrets.yaml`/`secrets.yml`/JSON;
- private-key names and formats (`id_*`, `authorized_keys`, `known_hosts`,
  `.pem`, `.key`, `.p12`, `.pfx`, `.jks`);
- `.git`, `.storage`, virtualenv/cache directories, credential/secrets/runtime/
  log directories;
- databases, WAL/SHM/dump/backup artifacts, and `*.log`; and
- every path Git reports ignored through a config-isolated `check-ignore`.

Read, search, write, edit, patch, directory listing, tree, snapshot, and
structured Git path handling all use this boundary. The check runs before
reads and writes, including nonexistent sensitive targets. Symlink targets are
canonicalized before authority is granted.

## 9. Complete adversarial S1 matrix

Command used:

```sh
node scripts/s1-host-proof.mjs
```

The final run also executed `docker compose config -q`. The wrapper reported
`containerExit: 0`, `passed: 13`, `failed: 0`, and
`hostSentinelsUnchanged: true`.

| Proof category | Evidence | Result |
| --- | --- | --- |
| MCP allowlist | Discovery exactly matched 27 names; disabled names absent | PASS |
| Structured allowed files | Read, create, non-empty overwrite, edit | PASS |
| Patch/search | Apply patch and repository text search | PASS |
| Structured secret/ignored denial | `.env`, `db.env`, secrets, `.storage`, logs, backups, ignored paths; views omit them | PASS |
| Structured outside denial | Outside read/write and nonexistent outside targets | PASS |
| Structured symlink denial | Symlink to container system path and unmounted host path | PASS |
| Project commands | Safe test, lint, typecheck, build | PASS |
| Git read/write | Status, diff, log, branch create/switch, selected stage, hook commit | PASS |
| Git governance | Config/remote mutation and hook/policy overwrite attempts failed | PASS |
| Process boundary | Bridge-owned start/list/log/stop with stable Linux identity | PASS |
| Container boundary | UID, zero effective caps, no-new-privileges, read-only root, no socket, no host/NAS paths, no credential env | PASS |
| Credential sentinels | Fake SSH/GitHub/Codex files were not mounted/readable; host bytes unchanged | PASS |
| Network/damage | Egress failed; shell damage/recreation stayed in workspace; outside bytes unchanged | PASS |

The in-container proof JSON contained 13 checks and zero failures. The host
wrapper removed the stopped proof container and temporary fixture in `finally`.

## 10. Normal-function results

`npm run lint` passed. `npm test` passed all 39 tests. The disposable container
proof additionally exercised the complete normal S1 loop: open a workspace,
read/write/edit, patch, search, safe test/lint/typecheck/build, status/diff/log,
branch create/switch, selected staging, hook-enforced commit, process
supervision, non-empty overwrite, and file recreation after shell damage.

## 11. Remaining escape paths and trust assumptions

- The Docker daemon and host kernel are trusted. A Docker privilege, altered
  Compose file, added host mount, host namespace, device, socket, network, or
  credential defeats this model.
- The operator must point all `BRIDGE_*` values at disposable data. The wrapper
  does so; an operator can intentionally replace them.
- `repo_shell` can read the container image and container-owned state and can
  mutate every writable disposable-workspace path. It cannot read host files
  that are not mounted; this is not a claim that `/etc/passwd` inside the
  container is inaccessible.
- File checks still have normal filesystem time-of-check/time-of-use limits
  within the disposable mount. A container compromise can race workspace
  files, but has no host credential/NAS/Docker path to race toward.
- The pinned image and npm registry supply chain are trusted at build time;
  runtime networking is disabled.
- An empty `MCP_TOKEN` is safe only because the supplied runtime publishes no
  port and binds the server inside the isolated container. Any future
  transport/publication needs separate authentication review.

## 12. Known limitations

- The base-image digest and proof target are linux/amd64 only.
- No ChatGPT, tunnel, remote repository, NAS, Docker, or persistent-service
  integration was tested or installed.
- Structured tools intentionally reject all ignored/generated sensitive paths,
  including valid project artifacts that a future workflow may need to copy by
  an explicitly reviewed mechanism.
- The bridge process and process logs are ephemeral container state.
- Retained upstream source still contains later capability implementations for
  audit comparison; runtime-image exclusions and registration gates reduce the
  active surface but do not delete that historical code from the fork.
- Container isolation does not protect against a compromised Docker daemon,
  kernel, base image, or operator-controlled runtime configuration.

## 13. Rollback procedure

S1 installed no persistent service and changed no canonical or NAS state.

1. Ensure no manually started S1 proof container remains; verify its exact
   name/tag before removing only that disposable container.
2. Remove the `chatgpt-sol-local-bridge:s1-pinned` image only if it is the
   S1-built tag and no other work uses it.
3. Archive or remove only the disposable proof fixture and this sibling fork
   after review. Recreate the fork by cloning the upstream URL and checking out
   commit `3c7b0c0fffa0e04f4533f871ece3da0064cf6620`.

Do not roll back by touching the homelab checkout, `/volume1/docker`, NAS
runtime data, backups, credentials, or persistent encryption keys.

## 14. Proposed S2 scope only

S2 may, after explicit review, design the transport/connection boundary and a
disposable workspace-provisioning workflow. Its review should cover
authentication, lifecycle, credential delivery, failure isolation, and how
ChatGPT would receive only the already-reviewed catalog. S2 must not be
interpreted as approval for a tunnel, GitHub staging repository, NAS broker,
`codex_run`, Git push, persistent service, or canonical-repository access.
