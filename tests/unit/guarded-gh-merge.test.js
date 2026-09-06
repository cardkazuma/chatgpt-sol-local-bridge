import test from "node:test";
import assert from "node:assert/strict";

test("guarded merge refuses a moved PR head before invoking merge", async () => {
  const mod = await import("../../scripts/guarded-gh-merge.mjs");
  assert.equal(typeof mod.guardGitHubMerge, "function");
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return { ok: true, stdout: JSON.stringify({ headRefOid: "b".repeat(40), state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }), stderr: "" };
  };
  await assert.rejects(() => mod.guardGitHubMerge({ repo: "owner/repo", pr: 7, expectedHead: "a".repeat(40), execute: true, runner }), /head moved.*REFRESH/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "pr");
});

test("guarded merge requires current successful checks and uses gh expected-head protection", async () => {
  const { guardGitHubMerge } = await import("../../scripts/guarded-gh-merge.mjs");
  const head = "a".repeat(40);
  const pending = async () => ({ ok: true, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] }), stderr: "" });
  await assert.rejects(() => guardGitHubMerge({ repo: "owner/repo", pr: 7, expectedHead: head, execute: true, runner: pending }), /checks.*current/i);

  const calls = [];
  const green = async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return { ok: true, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }), stderr: "" };
    return { ok: true, stdout: "merged", stderr: "" };
  };
  const result = await guardGitHubMerge({ repo: "owner/repo", pr: 7, expectedHead: head, execute: true, runner: green });
  assert.equal(result.merged, true);
  assert.deepEqual(calls[1], ["pr", "merge", "7", "--repo", "owner/repo", "--merge", "--match-head-commit", head]);
});
