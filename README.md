# chatgpt-sol-local-bridge — S6 offline bridge implementation

This local fork is the reviewed S1–S6 bridge for ordinary repository work in a
disposable, non-root Docker container. S6 adds a host-only broker that can,
after a separate real-credential gate, source only `cardkazuma/homelab` and
publish only the active session's generated `bridge/s6/<session-id>` branch.
The offline implementation has not provisioned a GitHub credential or pushed.

The security boundary remains the container runtime. The bridge receives one
explicit disposable workspace bind mount, has a read-only image root, no Linux
capabilities, no-new-privileges, bounded CPU/memory/PIDs/tmpfs, and
`network_mode: none`. `repo_shell` remains contained by that boundary rather
than by command-pattern filtering.

## S6 catalog

The S6 controller's fail-closed catalog exposes exactly these 28 names. The
base Compose file remains the reviewed S5 27-tool model; S6 supplies a
controller-owned override that adds the one remote-write capability:

- Policy: `bridge_instructions`
- Workspace: `workspace_list`, `workspace_open`, `workspace_tree`, `workspace_snapshot`
- Files: `read_file`, `search_text`, `write_file`, `apply_patch`, `edit_file`
- Git read: `git_status`, `git_diff`, `git_log`
- Local Git write: `git_branch_create`, `git_branch_switch`, `git_stage`, `git_commit`
- S6 remote write: `git_publish_branch`
- Project: `project_test`, `project_lint`, `project_typecheck`, `project_build`
- Execution: `repo_shell`
- Bridge-owned processes: `process_start`, `process_list`, `process_logs`, `process_stop`
- Runtime: `health`

`git_publish_branch` accepts no target, refspec, remote, force, delete, or
repository input. It asks the host broker to publish the manager-derived
`homelab` branch only after independent graph, path, governance, ancestry,
attestation, and remote-state checks. There is no `git_push`, `git_fetch`,
`git_run`, GitHub API, PR, merge, or arbitrary remote capability.

Removing a catalog name is supported. Unknown names and later/upstream
capabilities fail startup and are never registered for MCP discovery.

## Run the offline proofs

The offline suite uses disposable local fixtures and synthetic credential
sentinels. It does not request or use a real GitHub PAT:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run s6:offline-proof
npm run s5:runtime-proof
npm run s3:workspace-proof
```

The supplied Compose file is intentionally one-shot and has no `ports`,
`restart`, host namespace, device, Docker socket, credential, home-directory,
NAS, or `/Volumes` mount. Set its required `BRIDGE_*` interpolation values only
to a disposable repository and its reviewed hook/config files.

S6's host broker is a fixed-purpose Git transfer component, not a shell, HTTP
proxy, generic Git proxy, credential helper, or remote endpoint. It uses a
separate fixed macOS Keychain identity for a future expiring fine-grained PAT
scoped to `cardkazuma/homelab` with Contents read/write only. No real PAT is
requested by the offline commands.

## Review documents

- [S1 review](docs/S1_REVIEW.md) — historical catalog, boundaries, proof
  matrix, limits, rollback, and proposed S2 scope.
- [Provenance](PROVENANCE.md) — audited upstream commit, dependency lock, and
  image pin.
- [Security](docs/SECURITY.md) — current S6 threat model and trust assumptions.
- [Operations](docs/OPERATIONS.md) — read-only validation and proof operations.
- [ChatGPT setup](docs/CHATGPT_SETUP.md) — historical setup guidance.

## Scope boundary

S6 does not automate pull requests or merges, install a persistent service,
access the homelab NAS or a live checkout, use SSH, control Docker, invoke
`codex_run`, reuse host GitHub configuration, or give the bridge container
network or GitHub credentials. Remote refresh is controller-owned. GitHub
Rulesets/branch protection are not assumed; fixed broker validation remains
the boundary.

The fork remains local and reviewable at the audited upstream commit plus the
S1–S6 changes. No production checkout, runtime data, real GitHub credential, or
real GitHub push is used by the offline proof.

MIT. See [LICENSE](LICENSE).
