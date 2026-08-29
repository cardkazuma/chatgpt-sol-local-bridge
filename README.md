# chatgpt-sol-local-bridge — S1 isolated foundation

This local fork is the reviewed S1 foundation for repository work in a
disposable, non-root Docker container. It is not connected to ChatGPT, OpenAI
Secure MCP Tunnel, GitHub, a NAS, Docker, or any persistent host service.

The security boundary is the container runtime. The bridge receives one
explicit disposable workspace bind mount, has a read-only image root, no Linux
capabilities, no-new-privileges, bounded CPU/memory/PIDs/tmpfs, and
`network_mode: none`. `repo_shell` is intentionally not protected by command
regexes; unexpected commands remain confined by that boundary.

## S1 catalog

The fail-closed `ENABLED_TOOLS` catalog exposes exactly these 27 names by
default:

- Policy: `bridge_instructions`
- Workspace: `workspace_list`, `workspace_open`, `workspace_tree`, `workspace_snapshot`
- Files: `read_file`, `search_text`, `write_file`, `apply_patch`, `edit_file`
- Git read: `git_status`, `git_diff`, `git_log`
- Local Git write: `git_branch_create`, `git_branch_switch`, `git_stage`, `git_commit`
- Project: `project_test`, `project_lint`, `project_typecheck`, `project_build`
- Execution: `repo_shell`
- Bridge-owned processes: `process_start`, `process_list`, `process_logs`, `process_stop`
- Runtime: `health`

Removing a catalog name is supported. Unknown names and later/upstream
capabilities fail startup and are never registered for MCP discovery.

## Run the disposable proof

The proof creates a temporary repository and fake credential sentinels, builds
the pinned image, validates the Compose model, runs the bridge with only the
temporary mounts, checks the container configuration, and removes the stopped
proof container and fixture:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
node scripts/s1-host-proof.mjs
```

The supplied Compose file is intentionally one-shot and has no `ports`,
`restart`, host namespace, device, Docker socket, credential, home-directory,
NAS, or `/Volumes` mount. Set its required `BRIDGE_*` interpolation values only
to a disposable repository and its reviewed hook/config files.

## Review documents

- [S1 review](docs/S1_REVIEW.md) — catalog, boundaries, proof matrix, limits,
  rollback, and proposed S2 scope only.
- [Provenance](PROVENANCE.md) — audited upstream commit, dependency lock, and
  image pin.
- [Security](docs/SECURITY.md) — threat model and trust assumptions.
- [Operations](docs/OPERATIONS.md) — read-only validation and one-shot proof
  operations.
- [ChatGPT setup](docs/CHATGPT_SETUP.md) — explicitly deferred in S1.

## Scope boundary

S1 does not create staging repositories, modify canonical repositories, access
the homelab NAS, deploy or restart services, install LaunchAgents/systemd
services, start a Secure MCP Tunnel, create a ChatGPT MCP connection, enable
`codex_run`, or enable Git push.

The fork remains local and reviewable at the audited upstream commit plus the
S1 changes. No production checkout or runtime data is used by the proof.

MIT. See [LICENSE](LICENSE).
