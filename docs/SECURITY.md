# S1 security model

S1 is a local, review-only foundation. The bridge is expected to run from
`compose.yaml` as a one-shot container with `network_mode: none`; no tunnel,
ChatGPT connection, persistent service, NAS mount, or production checkout is
part of this stage.

## Primary boundary

The container, not shell-command inspection, is the primary safety boundary.
The runtime is non-root (`10001:10001`), read-only at its image root, drops all
Linux capabilities, enables `no-new-privileges`, and bounds CPU, memory, PIDs,
and `/tmp`/`/state` tmpfs space. It has no Docker socket, host namespace,
device, home-directory, credential, `/Volumes`, NAS, or network mount.

Only these host paths are bind-mounted by the reviewed Compose model:

1. one disposable repository at `/workspace/repo`, read/write;
2. that repository's `.git/config`, read-only;
3. its reviewed `.githooks` directory, read-only; and
4. its reviewed pre-commit policy helper, read-only.

The operator must provide those interpolation values from a disposable
fixture. The Compose file cannot protect an operator who replaces it with
different mounts or grants Docker privileges.

## MCP exposure

`ENABLED_TOOLS` is parsed against a committed 27-name catalog. Every
registration site, including retained upstream desktop code, goes through the
same registry gate. Unknown names fail closed, and disabled tools are absent
from `tools/list` rather than returning a runtime permission error.

S1 exposes policy, workspace, structured files, read-only Git, selected local
Git writes, four project commands, contained `repo_shell`, bridge-owned process
supervision, and bounded health. It does not expose upstream `git_run`, Git
push/remote operations, `codex_run`, root registration, destructive
confirmation, browser/CDP, desktop/input/screen/audio/clipboard tools, web
fetch, Office, scheduler, Penpot, NAS, Docker, SSH, or broad host-system
tools.

## Structured path policy

Structured file and workspace operations canonicalize paths before authority
checks, reject symlink escapes, and require the path to remain inside the
registered workspace. They also reject repository-ignored paths and sensitive
names/classes including `.env`, `db.env`, private-key material,
`secrets.yaml`, `.storage`, databases, runtime/log/credential directories,
credential-bearing logs, and backup artifacts. Directory listing, tree,
snapshot, and search use the same visibility check.

This policy is intentionally limited to structured tools. An arbitrary shell
command can inspect or mutate files in the container image and the writable
disposable workspace; it cannot thereby gain host paths that were not mounted.

## Git policy

The structured Git API has no generic command or remote operation. It uses
fixed local commands for status/diff/log, branch create/switch, selected-file
staging, and commit. Path arguments are literal, workspace-relative, and
validated; force, amend, rebase, reset, restore, clean, worktree, clone,
push/fetch, remote mutation, and config mutation are not represented.

`git_commit` requires the exact reviewed executable `.githooks/pre-commit`, the
exact reviewed policy-helper hash, and `core.hooksPath=.githooks`. The Compose
mounts for Git config, hooks, and policy are read-only. The policy helper also
rejects staged ignored/sensitive paths and staged symlinks.

This does not claim that arbitrary `repo_shell` can make a disposable Git
checkout governance-proof: a shell can attempt `--no-verify` or other Git
flags inside that disposable checkout. S1 contains that trust boundary by
making the checkout disposable, isolating its mounts, removing network access,
and exposing no such operation as a structured MCP tool.

## Credentials and network

The Compose environment contains no OpenAI tunnel key, GitHub credential,
Codex configuration, SSH key, NAS credential, or normal-user secret. Child
processes receive a small environment allowlist; the server also removes any
inherited control-plane key before tool registration. Runtime networking is
disabled rather than filtered by URL or command patterns.

The default Compose model publishes no port. The optional `MCP_TOKEN` is not
set by that model; do not publish the unauthenticated endpoint or use a
different transport without a separate review.

## Residual trust

The Docker daemon, host kernel, pinned base image, dependency registry at build
time, Compose file, and operator-selected disposable mount paths remain
trusted inputs. A Docker privilege, host bind, socket, network, or credential
added outside this repository defeats the intended boundary. Container escape
or kernel vulnerabilities are outside the S1 claim. The proof demonstrates
host-path containment on the local Docker runtime; it is not a NAS validation
or a claim of protection against a compromised host or Docker daemon.
