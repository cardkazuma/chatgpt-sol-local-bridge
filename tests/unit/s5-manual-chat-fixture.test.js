import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  prepareManualChatFixture,
  verifyManualChatFixture,
  WORKFLOW_PROOF_APPEND,
  WORKFLOW_PROOF_BASELINE,
  WORKFLOW_PROOF_FILE,
  WORKFLOW_PROOF_POST_MUTATION,
} from "../../scripts/s5-manual-chat-fixture.mjs";

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
  assert.equal(runGit(["ls-files", "--error-unmatch", WORKFLOW_PROOF_FILE], workspacePath, gitEnv), `${WORKFLOW_PROOF_FILE}\n`);
  assert.equal(fs.readFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), "utf8"), WORKFLOW_PROOF_BASELINE);
  assert.equal(runGit(["config", "--local", "--get", "core.hooksPath"], workspacePath, gitEnv), ".githooks\n");
  assert.equal(runProjectTest(workspacePath, gitEnv), 0, "baseline project_test should pass");

  fs.appendFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), WORKFLOW_PROOF_APPEND);
  assert.equal(fs.readFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), "utf8"), WORKFLOW_PROOF_POST_MUTATION);
  assert.equal(runProjectTest(workspacePath, gitEnv), 0, "exact intended appended proof line should pass project_test");

  fs.appendFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), WORKFLOW_PROOF_APPEND);
  assert.notEqual(runProjectTest(workspacePath, gitEnv), 0, "duplicate proof line should fail project_test");
  fs.writeFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), `${WORKFLOW_PROOF_BASELINE}wrong proof text\n`);
  assert.notEqual(runProjectTest(workspacePath, gitEnv), 0, "wrong proof text should fail project_test");
  fs.writeFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), `${WORKFLOW_PROOF_BASELINE}extra line\n${WORKFLOW_PROOF_APPEND}`);
  assert.notEqual(runProjectTest(workspacePath, gitEnv), 0, "unexpected extra lines should fail project_test");
  fs.writeFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), "S5 manual Chat proof altered\n");
  assert.notEqual(runProjectTest(workspacePath, gitEnv), 0, "altered baseline should fail project_test");
  fs.writeFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), WORKFLOW_PROOF_APPEND);
  assert.notEqual(runProjectTest(workspacePath, gitEnv), 0, "missing baseline should fail project_test");

  fs.rmSync(path.join(workspacePath, WORKFLOW_PROOF_FILE));
  assert.throws(
    () => verifyManualChatFixture({ workspacePath, sourceRoot: prepared.sourceRoot, governance, expectedBranch: prepared.session.branch, gitEnv }),
    /worktree is not clean/,
  );
  runGit(["checkout", "--", WORKFLOW_PROOF_FILE], workspacePath, gitEnv);
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

function runProjectTest(cwd, env) {
  return spawnSync("npm", ["test"], { cwd, env, encoding: "utf8", timeout: 60_000 }).status;
}
