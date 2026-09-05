import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as gitTools from "../../src/tools/git.js";

test("S6 git_commit rejects a non-generated branch before creating a commit", async () => {
  const fixture = makeFixture();
  const original = captureGovernanceEnvironment();
  try {
    Object.assign(process.env, fixture.environment);
    const beforeHead = git(fixture.workspace, ["rev-parse", "HEAD"]);
    const beforeIndex = git(fixture.workspace, ["write-tree"]);
    const beforeStaged = git(fixture.workspace, ["diff", "--cached", "--name-status"]);

    assert.equal(typeof gitTools.commitReviewedIndex, "function", "git_commit needs a testable reviewed commit boundary");
    await assert.rejects(
      () => gitTools.commitReviewedIndex({
        root: fixture.workspace,
        message: "reviewed task branch commit",
        governanceMode: "s6",
        brokerConfigured: () => true,
        preflight: async () => { throw new Error("S6 HEAD is not attached to the generated branch"); },
        attest: async () => { throw new Error("attestation must not run after a denied preflight"); },
      }),
      /not attached to the generated branch/,
    );

    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]), beforeHead);
    assert.equal(git(fixture.workspace, ["write-tree"]), beforeIndex);
    assert.equal(git(fixture.workspace, ["diff", "--cached", "--name-status"]), beforeStaged);
    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), fixture.taskBranch);
  } finally {
    restoreGovernanceEnvironment(original);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("S6 git_commit keeps the reviewed hook on the normal generated-branch path", async () => {
  const fixture = makeFixture();
  const original = captureGovernanceEnvironment();
  try {
    Object.assign(process.env, fixture.environment);
    git(fixture.workspace, ["switch", fixture.generatedBranch]);
    const beforeHead = git(fixture.workspace, ["rev-parse", "HEAD"]);
    let attested = null;
    const result = await gitTools.commitReviewedIndex({
      root: fixture.workspace,
      message: "reviewed generated branch commit",
      governanceMode: "s6",
      brokerConfigured: () => true,
      preflight: async () => ({ preflight: true, branch: fixture.generatedBranch }),
      attest: async (sha) => { attested = sha; },
    });
    const afterHead = git(fixture.workspace, ["rev-parse", "HEAD"]);
    assert.equal(result.ok, true);
    assert.match(`${result.stdout}\n${result.stderr}`, /S6 pre-commit policy passed/);
    assert.notEqual(afterHead, beforeHead);
    assert.equal(attested, afterHead);
    assert.equal(git(fixture.workspace, ["diff", "--cached", "--name-status"]), "");
  } finally {
    restoreGovernanceEnvironment(original);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-git-commit-ordering-"));
  const workspace = path.join(root, "workspace");
  const governance = path.join(root, "governance");
  const hooks = path.join(governance, "hooks");
  fs.mkdirSync(workspace);
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "pre-commit"), '#!/bin/sh\nset -eu\nexec node "${BRIDGE_REVIEWED_POLICY_PATH:?bridge policy path missing}"\n', { mode: 0o700 });
  fs.copyFileSync(path.resolve("scripts/pre-commit-policy.mjs"), path.join(governance, "pre-commit-policy.mjs"));
  git(workspace, ["init", "-q", "-b", "main"]);
  git(workspace, ["config", "user.name", "Ordering Fixture"]);
  git(workspace, ["config", "user.email", "ordering-fixture@example.invalid"]);
  git(workspace, ["config", "core.hooksPath", hooks]);
  fs.writeFileSync(path.join(workspace, "README.md"), "base\n");
  git(workspace, ["add", "--", "README.md"]);
  git(workspace, ["commit", "--no-verify", "-qm", "base"]);
  const base = git(workspace, ["rev-parse", "HEAD"]);
  const generatedBranch = "bridge/s6/s6-ordering-0123456789abcdef";
  const taskBranch = "bridge/s7b/task";
  git(workspace, ["branch", generatedBranch, base]);
  git(workspace, ["switch", "-qc", taskBranch]);
  fs.writeFileSync(path.join(workspace, "README.md"), "base\nstaged valid change\n");
  git(workspace, ["add", "--", "README.md"]);
  return {
    root,
    workspace,
    generatedBranch,
    taskBranch,
    environment: {
      BRIDGE_GOVERNANCE_MODE: "s6",
      BRIDGE_REVIEWED_HOOK_PATH: path.join(hooks, "pre-commit"),
      BRIDGE_REVIEWED_HOOKS_PATH: hooks,
      BRIDGE_REVIEWED_POLICY_PATH: path.join(governance, "pre-commit-policy.mjs"),
    },
  };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}

function captureGovernanceEnvironment() {
  return Object.fromEntries(["BRIDGE_GOVERNANCE_MODE", "BRIDGE_REVIEWED_HOOK_PATH", "BRIDGE_REVIEWED_HOOKS_PATH", "BRIDGE_REVIEWED_POLICY_PATH"].map((key) => [key, process.env[key]]));
}

function restoreGovernanceEnvironment(original) {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
