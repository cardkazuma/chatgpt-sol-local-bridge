# S6 security model

The S1 model below remains the foundation. S6 adds one host-side remote-write
authority: the controller may source only private `cardkazuma/homelab` and
publish only the active manager-generated S6 branch. The offline implementation
has not provisioned a real PAT or performed a real GitHub clone/push.

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

The S5 base Compose model is parsed against the committed 27-name catalog;
the S6 controller override is parsed against the exact 28-name catalog. Every
registration site, including retained upstream desktop code, goes through the
same registry gate. Unknown names fail closed, and disabled tools are absent
from `tools/list` rather than returning a runtime permission error.

S6 adds only `git_publish_branch` to the S5 set. It does not expose upstream
`git_run`, `git_push`, `git_fetch`, arbitrary Git remotes/refspecs, force/delete
operations, GitHub API, PR, or merge. S1 exposes policy, workspace, structured
files, read-only Git, selected local Git writes, four project commands,
contained `repo_shell`, bridge-owned process supervision, and bounded health.
It does not expose `codex_run`, root registration, destructive
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

## S6 remote-write addendum

The remote-write threat model treats `repo_shell` and candidate repository
content as malicious. A valid local commit is not publish authority: the host
broker independently checks a live manager-owned `s6-...` session, exact
`homelab` source/origin, exact `bridge/s6/<same-session-id>` branch and remote
ref, attached HEAD, full non-shallow history, clean worktree/index/ignored set,
recorded canonical base ancestry, linear non-merge history, no symlink or
submodule tree entries, and the authoritative shared path policy. Every
unpublished commit requires an attestation from the structured `git_commit`
path; a shell `git commit --no-verify` is unpublishable. Workflow files,
`.githooks/**`, the policy helper, and `.gitmodules` fail closed for S6.

Only this remote ref is possible:
`refs/heads/bridge/s6/<same-session-id>`. The first write requires the ref to be
absent unless owned by the same recorded session. Later writes require the
recorded prior SHA and fast-forward ancestry. The broker has no force,
force-with-lease, wildcard, deletion, alternate remote, caller refspec, GitHub
API, PR, or merge path. It reads the remote SHA back and persists/returns only
sanitized metadata and evidence.

The preferred future credential is an expiring fine-grained PAT with access
only to `cardkazuma/homelab` and Contents read/write permission. It uses a
dedicated fixed macOS Keychain service/account separate from S5. The operator
enters it only through the local Keychain path; the host broker scopes it to a
manager-owned mode-0600 temporary file, uses an isolated HOME/XDG Git config,
`GIT_CONFIG_NOSYSTEM=1`, disabled prompts, no normal-user helper, and SSH
disabled, then deterministically removes the file. The token is never in a
URL, argv, shell history, tracked config, workspace, bridge/tool-child
environment, logs, audit, or evidence. Offline tests use synthetic tokens only.

The bridge container remains `network_mode: none`, credential-free, non-root,
read-only-rootfs, capability-dropped, and no-new-privileges. A fixed per-session
Unix socket carries only an in-memory capability and fixed register/attest/
empty-input publish messages. The host broker is not a shell, HTTP proxy,
generic Git proxy, or credential helper. Its credential-bearing Git subprocesses
set `core.hooksPath` and `GIT_TEMPLATE_DIR` to separate manager-owned, empty,
private directories; they also ignore system/global configuration and reject
repository aliases, filters, credential settings, hook paths, and related Git
configuration before opening the credential callback. The normal disposable
workspace still uses the reviewed pre-commit hook for structured local commits.
The `S6 credential-time Git invocations isolate hooks, templates, and
repository config` regression exercises malicious repository/template/global
hooks and configuration under a synthetic credential callback.

The current private personal GitHub repository has no Rulesets or branch
protection in the available plan. That is an explicit residual, not an
assumption: fixed repository/namespace/graph validation in the host broker is
mandatory. A concurrent remote movement between the broker's read and Git's
own update negotiation remains a transport-level TOCTOU residual because
force-with-lease and GitHub API operations are outside this gate; receipt and
read-back mismatches fail closed and are surfaced for recovery review.

## Residual trust

The Docker daemon, host kernel, pinned base image, dependency registry at build
time, Compose file, and operator-selected disposable mount paths remain
trusted inputs. A Docker privilege, host bind, socket, network, or credential
added outside this repository defeats the intended boundary. Container escape
or kernel vulnerabilities are outside the S1 claim. The proof demonstrates
host-path containment on the local Docker runtime; it is not a NAS validation
or a claim of protection against a compromised host or Docker daemon.
