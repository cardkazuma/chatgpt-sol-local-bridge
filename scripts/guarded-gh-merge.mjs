#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runCommand } from "../src/lib/exec.js";

export async function guardGitHubMerge({ repo, pr, expectedHead, execute = false, allowNoChecks = false, runner = gh } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ""))) throw new Error("repository must be owner/name");
  if (!Number.isInteger(Number(pr)) || Number(pr) <= 0) throw new Error("PR must be a positive integer");
  if (!/^[a-f0-9]{40,64}$/.test(String(expectedHead || ""))) throw new Error("expected head must be a full commit SHA");
  const view = await runner(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,state,isDraft,reviewDecision,statusCheckRollup"]);
  if (!view.ok) throw new Error(`could not refresh PR state: ${bounded(view.stderr || view.stdout)}`);
  let state;
  try { state = JSON.parse(view.stdout); } catch { throw new Error("gh returned malformed PR state"); }
  if (state.headRefOid !== expectedHead) throw new Error(`PR head moved; REFRESH required (expected ${expectedHead}, observed ${state.headRefOid || "unknown"})`);
  if (state.state !== "OPEN" || state.isDraft) throw new Error("PR is not open and ready for integration");
  if (state.reviewDecision !== "APPROVED") throw new Error(`PR review is not approved (${state.reviewDecision || "none"})`);
  const checks = Array.isArray(state.statusCheckRollup) ? state.statusCheckRollup : [];
  if (!checks.length && !allowNoChecks) throw new Error("PR has no current checks; record repository policy disposition before merge");
  if (checks.some((check) => check.status !== "COMPLETED" || !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion))) {
    throw new Error("PR checks are not current and successful");
  }
  if (!execute) return { ready: true, merged: false, head: expectedHead, checks: checks.length };
  const merged = await runner(["pr", "merge", String(pr), "--repo", repo, "--merge", "--match-head-commit", expectedHead]);
  if (!merged.ok) throw new Error(`guarded merge failed: ${bounded(merged.stderr || merged.stdout)}`);
  return { ready: true, merged: true, head: expectedHead, output: bounded(merged.stdout) };
}

async function gh(args) {
  return runCommand(["gh", ...args], { shell: false, timeoutMs: 120_000 });
}

function bounded(value) {
  return String(value || "").trim().slice(0, 2_000);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = Object.fromEntries(process.argv.slice(2).map((item) => {
    const [key, ...rest] = item.replace(/^--/, "").split("=");
    return [key, rest.join("=") || true];
  }));
  guardGitHubMerge({
    repo: args.repo,
    pr: Number(args.pr),
    expectedHead: args["expected-head"],
    execute: args.execute === true,
    allowNoChecks: args["allow-no-checks"] === true,
  }).then((value) => console.log(JSON.stringify(value, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
