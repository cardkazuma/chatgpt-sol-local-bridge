# S7-B bounded acceptance

The reviewed mutation implementation at
`fb3866aa3751fcaebe7b005617b53b8d75ac7481` preserves persisted read observations,
stable selected-store identity and v2 session markers. Its bounded broker
projection is internal enforcement data, not part of public MCP tool results.
The selected coordinator 0.2.0 wheel remains
`3e528011ce130797af25aeca2f1bb1faea294cd46838cfbadffc488cd9463f96`.

## Failed patch proof diagnosis

Verified 2026-09-05 from the actual MCP boundary and `src/tools/files.js`:
the last temporary harness sent `{patch: "*** Begin Patch..."}`. The public
schema requires `{diff: "<unified/git diff>"}`. The live server returned
`-32602`, reporting a missing `diff`. This is a harness defect; no production
patch parser or coordinator policy change is needed.

An earlier zero-context deletion proof was also unsuitable for the normal
`git apply` contract. The replacement harness generates a contextual reverse
Git diff with `git diff -R`. A diagnostic fixture confirmed that `--reverse`
does not reverse this diff and causes `git apply --check` to fail. Exact
restoration compares content bytes, HEAD, branch, staged entries, status and
staged/unstaged diffs; raw index-file bytes include Git's mutable stat cache.

## Foreground lifecycle repair

The controlled restart reached readiness, then its supervisor failed the
workspace heartbeat and removed the disposable runtime. The parent had an
explicit manager root; the detached child received only the state filename
and constructed a different default manager root. The existing owner/path
checks correctly refused that mismatch. The repair passes the selected
runtime and manager roots explicitly to the supervisor. It changes neither
session records nor database schema, observations, artifact selection or policy.

`tests/unit/s6-supervisor-roots.test.js` launches the real detached supervisor
with child defaults deliberately different from the selected roots. Only
Docker inspection is substituted. Before the fix it reproduced `workspace
heartbeat failed; run recover`; afterward the child updated the selected
session heartbeat and preserved the running state. The test does not create
real containers or use the production coordinator store.

## Reproducible live mutation proof

After separately authorized foreground activation, supply the active runtime
state file explicitly:

```sh
node scripts/s7b-live-mutation-proof.mjs /absolute/runtime/state.json --run-disposable-proof
```

This uses the runtime's disposable session and authenticated relay, requires a
clean baseline, and proves real MCP read/edit/apply_patch restoration plus
stale observation, competing-byte preservation, explicit reread and successful
write. It restores its temporary HANDOFF mutation even if a later assertion
fails, and emits a checkpoint as soon as reversible mutation succeeds.
Successful public responses are sufficient; internal projection visibility is
not required. This proof does not perform restart or broaden the catalog.

## Evidence boundaries

The final dated live evidence and Homelab lifecycle disposition are owned by
`cardkazuma/homelab/docs/evidence/hl-chatgpt-local-bridge-s7b.md`.
Previously accepted coordinator/package evidence and prior R1/R2 proof remain
valid where the implementation and selected binding are unchanged.

Only `write_file`, `edit_file`, and `apply_patch` are covered mutation seams.
Other mutation-capable routes remain explicit coverage gaps; exclusive
eligibility remains unavailable. An exclusive-path coverage block may
legitimately precede freshness checks. This is not atomic protection from
uncovered writers, complete shell/Git interception, or S7-C acceptance.

For full isolated tests use the explicit coordinator prerequisites documented
in `tests/unit/s7b-review-fixes.setup.md` and a short `TMPDIR=/tmp`. Local socket
permissions are required. Serial test execution can avoid process-start
contention in the existing bounded timing test; assertions must not be relaxed.
