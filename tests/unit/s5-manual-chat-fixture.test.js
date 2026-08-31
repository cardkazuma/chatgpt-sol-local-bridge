import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareManualChatFixture, verifyManualChatFixture } from "../../scripts/s5-manual-chat-fixture.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s5-manual-chat-fixture-test-"));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const governance = {
  hookFile: path.join(repoRoot, ".githooks", "pre-commit"),
  policyFile: path.join(repoRoot, "scripts", "pre-commit-policy.mjs"),
};

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("manual Chat fixture preparation requires a clean tracked proof baseline and passing test", () => {
  const managerRoot = path.join(base, "chatgpt-local-bridge-s5-manual-fixture-manager");
  const prepared = prepareManualChatFixture({ managerRoot, repoRoot, governance });
  const { workspacePath } = prepared.session;
  const gitEnv = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: path.join(managerRoot, "git-home"),
    XDG_CONFIG_HOME: path.join(managerRoot, "git-home", "config"),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_OPTIONAL_LOCKS: "0",
  };
  assert.equal(prepared.baseline.workflowProofTracked, true);
  assert.equal(prepared.baseline.trackedWorktreeClean, true);
  assert.equal(prepared.baseline.baselineProjectTest, "PASS");
  assert.equal(runGit(["status", "--porcelain", "--untracked-files=all"], workspacePath, gitEnv), "");
  assert.equal(runGit(["ls-files", "--error-unmatch", "workflow-proof.txt"], workspacePath, gitEnv), "workflow-proof.txt\n");
  assert.equal(fs.readFileSync(path.join(workspacePath, "workflow-proof.txt"), "utf8"), "S5 manual Chat proof baseline\n");

  fs.rmSync(path.join(workspacePath, "workflow-proof.txt"));
  assert.throws(
    () => verifyManualChatFixture({ workspacePath, sourceRoot: prepared.sourceRoot, governance, expectedBranch: prepared.session.branch, gitEnv }),
    /worktree is not clean/,
  );
  runGit(["checkout", "--", "workflow-proof.txt"], workspacePath, gitEnv);
  fs.chmodSync(path.join(workspacePath, "scripts", "pre-commit-policy.mjs"), 0o600);
  fs.appendFileSync(path.join(workspacePath, "scripts", "pre-commit-policy.mjs"), "\n// dirty fixture regression\n");
  assert.throws(
    () => verifyManualChatFixture({ workspacePath, sourceRoot: prepared.sourceRoot, governance, expectedBranch: prepared.session.branch, gitEnv }),
    /worktree is not clean/,
  );
});

function runGit(args, cwd, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return result.stdout || "";
}
