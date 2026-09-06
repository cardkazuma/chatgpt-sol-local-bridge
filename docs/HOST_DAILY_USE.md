# Daily-use host profile — W1–W4 candidate

This is the implementation/runbook for approved Homelab Blueprint revision
`daily-use-1`. It describes a candidate only: no LaunchAgent is installed or
enabled, no live Bridge or tunnel is stopped or rebound, and W5/W6 acceptance
has not occurred.

## Operating contract

Set `BRIDGE_PROFILE=host` only for the native candidate. The profile advertises
catalog `daily-use-v1` and omits the legacy fixed-source
`git_publish_branch`. It runs as the normal logged-in Mac user and is not a
Codex-style filesystem/network sandbox. Every file, Git, project, shell and
process call carries a stable workspace ID. The index is a locator; resume
refreshes actual Git state and points to repository instructions.

Create one task-owned worktree with `workspace_create`, then retain its ID for
`workspace_status`, file reads/edits, project checks, `repo_shell`, Git and
managed-process calls. Use `workspace_checkpoint` before leaving a chat.
`workspace_resume` preserves dirty/unpublished files and refreshes HEAD/status.
If index validation fails, stop mutation and use read-only `workspace_recover`;
it never resets metadata or deletes worktrees.

The short development loop is:

1. Resume/select the workspace and read `AGENTS.md`, `HANDOFF.md`, the relevant
   lifecycle/design and nearest implementation.
2. Fetch/read current refs; inspect status and diff before broad shell work.
3. Read before structured edits. A competing content or HEAD change returns
   `STALE_OBSERVATION`/`REFRESH` and preserves the competing bytes.
4. Run focused and complete repository checks. Inspect unstaged state, stage
   exact paths, inspect the cached diff, and commit through the repository's
   actual configured hooks without bypass.
5. Use normal `git`/`gh` through `repo_shell` for sync, non-force push, draft PR,
   review and CI readback. Before an authorized merge, use:

       node scripts/guarded-gh-merge.mjs \
         --repo=OWNER/REPO --pr=NUMBER --expected-head=FULL_SHA

   This is a dry readiness check by default. `--execute` uses `gh pr merge
   --match-head-commit`; moved heads, draft/closed PRs, absent approval and
   non-successful checks refuse before merge. A repository with no CI needs an
   explicit recorded disposition and `--allow-no-checks`.

Broad shell is inherently mutating and cannot be atomically classified. Inspect
status/diff afterward and reread affected files before another derived edit.
High-impact live actions still require exact current-task approval.

## Render-only native package

The selected native transport is `tunnel-client` 0.0.13 at commit
`4b5267f823be0b046bb883aacb51603cfde3a0ea`, Darwin/x86_64 binary SHA-256
`c5d1ab3ccf3aa402f631e2fac66c763fa0b1b82e6134e995c9a44bc6a06fb93c`
from release ZIP SHA-256
`c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c`.
Do not substitute `latest`.

Render into an isolated staging directory; this command verifies the exact
binary and required native flags before writing anything:

    node scripts/native-runtime.mjs render \
      --output=/absolute/private/staging-root \
      --repo=/absolute/reviewed/bridge-checkout \
      --node=/absolute/path/to/node \
      --tunnel=/absolute/path/to/pinned/tunnel-client

It writes two candidate normal-user plists, a secret-free tunnel profile and a
non-secret runtime locator. It does not copy them to `~/Library/LaunchAgents`,
call `launchctl`, touch Keychain, or alter the live connection. Validate the
staged plists with `plutil -lint`.

The server launcher creates one mode-0600 local bearer inside the candidate
state root. The server receives only that bearer. The tunnel launcher retrieves
the existing fixed Keychain item through the established credential callback;
the control-plane key reaches only the tunnel child and temporary material is
removed. No credential or ACL is created or changed. The tunnel profile sends
the local bearer to loopback MCP discovery and calls. Recovery supervises only
the owned server/tunnel process and stops retrying after five failed starts in
ten minutes; it never replays a workspace command, changes Git, deletes a
worktree or repairs credentials.

Once W5 has installed the reviewed staged plists, the operator path is:

    node scripts/native-runtime.mjs status --config=/stable/path/runtime.json
    node scripts/native-runtime.mjs start --config=/stable/path/runtime.json
    node scripts/native-runtime.mjs stop --config=/stable/path/runtime.json
    node scripts/native-runtime.mjs recover --config=/stable/path/runtime.json --component=server
    node scripts/native-runtime.mjs recover --config=/stable/path/runtime.json --component=tunnel

Status reports installed/loaded components, Keychain usability and bounded
recovery state separately. The Bridge `/readyz` owns profile/catalog truth;
tunnel health must additionally require a successful control-plane poll during
W5 acceptance.

## W5 activation and rollback plan — approval required

Before activation, refresh both repositories and verify the implementation PR
head/CI/review. Privately inventory the exact old Bridge/tunnel/relay/broker
resources, current app catalog, existing workspace/coordinator state and owned
processes. Preserve all old state. Re-verify the pinned binary and Keychain item
without displaying values or changing access controls. Copy the reviewed source
and binary to a stable owner-only Application Support directory, render there,
lint both plists, and update `workstation-blueprint` inventory in the same
approved installation change.

At the approved cutover, stop only the old owned tunnel/runtime necessary to
avoid two clients serving the same tunnel. Copy the exact two reviewed plists to
the user's LaunchAgents directory, bootstrap server first and tunnel second,
then require loopback bearer refusal, `daily-use-v1` catalog readback, tunnel
health with control-plane poll, ordinary-Chat catalog refresh and permitted tool
calls. Exercise a controlled candidate restart and resume before proceeding to
phone testing. Test native iPhone Chat first, then Safari; neither is inferred
from web history or transcript sync.

Rollback is: boot out only the two new labels, leave every new worktree and
diagnostic record intact, restore/start the retained old runtime through its
existing runbook and credentials, refresh the old app catalog if required, and
verify its historical readiness. Do not reset coordinator data, rotate/recreate
Keychain material, delete candidate work or use S5/S6 reaping as host recovery.

Card must separately approve exactly: durable copy/install of the candidate and
workstation inventory writeback; stopping the old owned runtime/tunnel and
bootstrapping the two new LaunchAgents; the controlled restart and ordinary-Chat
W5 acceptance; and the mobile test. Any Keychain ACL change, paid dependency,
web-first limitation or alternate mobile/Remote route is a separate decision.

## Current feasibility and limits

Verified 2026-09-06 from read-only/local probes: the Mac is Darwin x86_64; the
cached binary and ZIP match the hashes above; `run`, `doctor` and `health`
expose the required flags; the fixed Keychain item is present and readable
without an ACL change; Git, gh, Node, Python, SSH and Docker CLI are installed.
No running ChatGPT desktop application was found in the local app inventory.
This does not establish iPhone or Safari support, which remains W5/W6 device
acceptance. No live tunnel handshake was attempted by W1–W4.

The repository CI uses the explicit portable `test:ci` gate. It excludes only
the real S7-B coordinator fixture because the accepted private wheel is not
available to this repository's Actions token; the workflow prints that
disposition instead of treating the prerequisite as passing. The unchanged
fixture remains mandatory in the local full-suite gate with the documented
accepted interpreter and artifact SHA.
