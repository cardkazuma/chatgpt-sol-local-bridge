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
