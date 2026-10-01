# S7-C candidate checkpoint

S7-C is **not complete**. The canonical gate is Homelab
`docs/designs/hl-chatgpt-local-bridge.md` §25.12–25.13.
S7-A and S7-B remain accepted; this candidate does not reopen them.

The separate native Mac controller implements authenticated MCP lifecycle
requests, component-specific health/catalog guidance, durable task/worktree
records, stale-base detection, conservative retirement, persisted recovery
budget, and owned subprocess cleanup on controller disconnect. The foreground
S6/S7-B runtime and its store remain unchanged.

Verified 2026-09-05 from the isolated fork candidate: the original 125-test
baseline passed. The candidate complete suite passed 137/137, with no skipped
or cancelled tests; lint and the existing high-severity dependency audit gate
passed. The lockfile changes only transitive fast-uri 3.1.5 → 3.1.7 to clear
that audit gate. Earlier S7-B behavior is retained; these are local results,
not GitHub CI or always-on acceptance.

New tests exercised real Git worktrees/remotes, durable registry restart,
unpublished/dirty retention, external-base movement, corrupt-record refusal,
persisted retry exhaustion, authenticated MCP, listener collision, child
ownership, and controller-disconnect cleanup. Required local socket permission
was supplied. A listener callback error was reproduced and fixed; sandbox
socket and default-root refusals were environment/invocation conditions.

Remaining before the C gate can pass:

- finish/review task-process lifecycle and automatic idle/14-day retention;
- exercise selected coordinator binding, task registration/resume and failure
  behavior through the new controller;
- prove native tunnel startup, bounded startup/recovery, and accurate health
  across controller restart; the existing credential delegation was checked
  without revealing or changing its value;
- install the reviewed normal-user LaunchAgent and exact release, then verify
  an equivalent clean always-on start and owned-process recovery;
- update workstation inventory through its canonical policy;
- pass current-head integration checks, review and merge, then record the
  meaningful S7-C checkpoint in Homelab and proceed directly to S7-D.

The native v0.0.13 darwin-amd64 asset matches official SHA256SUMS:
`c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c`.
Its tunnel-client binary reports source
`4b5267f823be0b046bb883aacb51603cfde3a0ea` and SHA-256
`c5d1ab3ccf3aa402f631e2fac66c763fa0b1b82e6134e995c9a44bc6a06fb93c`.
The artifact is currently temporary; no durable S7-C install is claimed.

No NAS service requires redeployment. No production deployment, restart,
data deletion, credential/key change, or persistent-store recreation occurred.

## Resume after the requested session change

Card requested a pause on 2026-09-05 and directed that Astra be the controller
only in the next session. Resume the same S7 mission; C/D/E/F/G are internal
gates, not new user missions. Delegate bounded implementation/review work from
that controller under the next session's applicable agent instructions.

The tested implementation checkpoint is
`9a9c79dffa8503a0c38772356f2545b0bd5a3cdd`, published on
`implement/s7c-durable-runtime` in `cardkazuma/chatgpt-sol-local-bridge#2`
(Draft, not merged). No S7-C acceptance or durable runtime installation has
occurred. The current foreground S6/S7-B runtime was inspected and remains
running; inspect it again before any future live claim or replacement.

Refresh canonical main and governance first. At this pause the observed heads
were Homelab `3218af5c64ece267bc1bed896e53475c89b507e9`, portfolio-db
`b8229c96575a93dda141c032d8d3892d82005fe1`, and Bridge
`5c18845fb6fda01f9e1a123e5ff76620e87df86c`. Preserve the existing accepted
coordinator artifact/store and unrelated workstation inventory changes.

The next bounded implementation step is automatic retention. A new real-Git
fixture established the missing `TaskRegistry.maintain` method: before 14 days
retain completed work; at 14 days retire only clean remote-recoverable
completed work; retain active work. That unimplemented test was removed before
this clean checkpoint, not counted as a passing proof. Restore the test first,
then wire maintenance and task-process ownership through the controller.

Before claiming controller readiness, review/test the runtime's dependency
failure path, sticky degraded state, startup grace period, crash/reboot retry
accounting and selected-store freshness. Unit module tests do not establish
those combined live behaviors. Prove actual task registration and resumed
coordinator state, and do not claim expanded exclusive coverage from the
accepted bounded S7-B attestation. New mutation routes need their real adapter
coverage and affected-boundary proof; no coordinator denial may be bypassed.

GitHub readback found Actions enabled and the inherited `ci` workflow active,
but neither the published head nor PR #2 had a check run or workflow run.
Diagnose this at the GitHub/workflow layer before integration. Do not equate
zero checks with current-head CI success, and do not weaken inherited gates.
The inherited full-suite workflow also needs its explicit accepted coordinator
fixture prerequisites reviewed before expecting a hosted run to pass.

The 137/137 result used the accepted installed coordinator interpreter,
explicit artifact digest, disposable HOME/store, short TMPDIR, serial Node
test-file execution and local socket permission. The prerequisite contract is
`tests/unit/s7b-review-fixes.setup.md`. The normal lint and staged shared hook
also passed. Repeat only affected tests after narrow changes; run the required
integration checks before merge. No S7-D/E/F/G proof has started.
