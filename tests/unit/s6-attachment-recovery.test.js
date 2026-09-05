import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  S6GitHubBroker,
  S6_GOVERNANCE_HOOKS_PATH,
  S6_REPOSITORY_URL,
  S6_STANDARD_FETCH_REFSPEC,
  dispatchS6BrokerRequest,
} from "../../scripts/s6-github-broker.mjs";
import { S6_REVIEWED_HOOK_SOURCE } from "../../src/lib/git-governance.js";

const SUBJECT = "[hl-chatgpt-local-bridge] S7-B coordinator runtime candidate";
const WRONG_SHA = "f".repeat(40);

test("controller recovery attaches an exact direct-child reviewed commit without changing it or remote refs", () => {
  const fixture = makeRecoveryFixture();
  try {
    const remoteRefsBefore = git(fixture.workspace, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/"]);
    const result = fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations);
    assert.deepEqual(result, {
      recovered: true,
      repository: "homelab",
      sessionId: fixture.sessionId,
      branch: fixture.generatedBranch,
      oldSha: fixture.parent,
      commit: fixture.commit,
      status: "attached",
    });
    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), fixture.generatedBranch);
    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]), fixture.commit);
    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD^"]), fixture.parent);
    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD^{tree}"]), fixture.tree);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--ignored", "--untracked-files=all"]), "");
    assert.equal(git(fixture.workspace, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/"]), remoteRefsBefore);
  } finally { fixture.cleanup(); }
});

test("controller recovery persists its reviewed-commit attestation for a fresh foreground broker", () => {
  const fixture = makeRecoveryFixture();
  try {
    fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations);
    const restarted = new S6GitHubBroker({ managerRoot: fixture.managerRoot, bridgeRoot: path.resolve("."), sessionId: fixture.sessionId, platform: "linux" });
    const validation = restarted.validateLocalPublishState({ requireAttestations: true });
    assert.equal(validation.head, fixture.commit);
    assert.deepEqual(validation.commits, [fixture.commit]);
  } finally { fixture.cleanup(); }
});

for (const [name, override, pattern] of [
  ["wrong HEAD SHA", { expectedCommit: WRONG_SHA }, /HEAD did not match/],
  ["wrong parent", { expectedParent: WRONG_SHA }, /base did not match.*parent|parent did not match/],
  ["wrong tree", { expectedTree: WRONG_SHA }, /tree did not match/],
  ["wrong subject", { expectedSubject: "unreviewed subject" }, /subject did not match/],
]) {
  test(`controller recovery denies ${name}`, () => {
    const fixture = makeRecoveryFixture();
    try {
      assert.throws(() => fixture.broker.recoverGeneratedBranchAttachment({ ...fixture.expectations, ...override }), pattern);
      assertUnrecovered(fixture);
    } finally { fixture.cleanup(); }
  });
}

test("controller recovery creates a missing registered generated branch with create-only CAS", () => {
  const fixture = makeRecoveryFixture({ missingGeneratedBranch: true });
  try {
    const result = fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations);
    assert.equal(result.oldSha, null);
    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), fixture.generatedBranch);
    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]), fixture.commit);
  } finally { fixture.cleanup(); }
});

test("controller recovery denies a dirty worktree", () => {
  const fixture = makeRecoveryFixture();
  try {
    fs.appendFileSync(path.join(fixture.workspace, "README.md"), "dirty\n");
    assert.throws(() => fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations), /clean worktree, index, and ignored set/);
    assertUnrecovered(fixture);
  } finally { fixture.cleanup(); }
});

test("controller recovery denies a staged index", () => {
  const fixture = makeRecoveryFixture();
  try {
    fs.appendFileSync(path.join(fixture.workspace, "README.md"), "staged\n");
    git(fixture.workspace, ["add", "--", "README.md"]);
    assert.throws(() => fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations), /clean worktree, index, and ignored set/);
    assertUnrecovered(fixture);
  } finally { fixture.cleanup(); }
});

test("controller recovery denies a generated branch advanced elsewhere", () => {
  const fixture = makeRecoveryFixture();
  try {
    const advanced = commitTree(fixture.workspace, fixture.tree, fixture.parent, "advanced elsewhere");
    git(fixture.workspace, ["update-ref", `refs/heads/${fixture.generatedBranch}`, advanced, fixture.parent]);
    assert.throws(() => fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations), /generated branch old ref did not match/);
    assert.equal(git(fixture.workspace, ["rev-parse", fixture.generatedBranch]), advanced);
    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), fixture.taskBranch);
  } finally { fixture.cleanup(); }
});

test("controller recovery denies a generated branch registry mismatch", () => {
  const fixture = makeRecoveryFixture();
  try {
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    state.branch = "bridge/s6/s6-other-aaaaaaaaaaaaaaaa";
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
    assert.throws(() => fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations), /branch identity mismatch|generated branch/);
    assertUnrecovered(fixture);
  } finally { fixture.cleanup(); }
});

test("controller recovery denies a session registry identity mismatch", () => {
  const fixture = makeRecoveryFixture();
  try {
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    state.sessionId = "s6-other-aaaaaaaaaaaaaaaa";
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
    assert.throws(() => fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations), /workspace state is invalid|session identity mismatch/);
    assertUnrecovered(fixture);
  } finally { fixture.cleanup(); }
});

test("controller recovery accepts no caller-selected branch", () => {
  const fixture = makeRecoveryFixture();
  try {
    assert.throws(
      () => fixture.broker.recoverGeneratedBranchAttachment({ ...fixture.expectations, branch: fixture.taskBranch }),
      /accepts only exact reviewed commit expectations/,
    );
    assertUnrecovered(fixture);
  } finally { fixture.cleanup(); }
});

test("controller recovery uses CAS and denies a concurrent local ref update", () => {
  const fixture = makeRecoveryFixture({ concurrentUpdate: true });
  try {
    assert.throws(() => fixture.broker.recoverGeneratedBranchAttachment(fixture.expectations), /compare-and-swap|Git operation failed/);
    assert.equal(git(fixture.workspace, ["rev-parse", fixture.generatedBranch]), fixture.concurrentSha);
    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), fixture.taskBranch);
  } finally { fixture.cleanup(); }
});

test("controller recovery is not exposed through the bridge broker protocol", async () => {
  const fixture = makeRecoveryFixture();
  try {
    await assert.rejects(
      () => dispatchS6BrokerRequest(fixture.broker, { capability: "a".repeat(64) }, { operation: "recover-attachment", capability: "a".repeat(64) }),
      /unsupported S6 broker operation/,
    );
  } finally { fixture.cleanup(); }
});

test("arbitrary non-generated branches remain unpublishable", () => {
  const fixture = makeRecoveryFixture();
  try {
    assert.throws(() => fixture.broker.validateLocalPublishState({ requireAttestations: false }), /not attached to the generated branch/);
  } finally { fixture.cleanup(); }
});

test("commit preflight permits a staged index only on the registered generated branch", () => {
  const fixture = makeRecoveryFixture();
  try {
    assert.throws(() => fixture.broker.preflightCommit(), /not attached to the generated branch/);
    git(fixture.workspace, ["switch", fixture.generatedBranch]);
    fs.appendFileSync(path.join(fixture.workspace, "README.md"), "staged preflight\n");
    git(fixture.workspace, ["add", "--", "README.md"]);
    const staged = git(fixture.workspace, ["diff", "--cached", "--name-status"]);
    assert.deepEqual(fixture.broker.preflightCommit(), { preflight: true, branch: fixture.generatedBranch });
    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]), fixture.parent);
    assert.equal(git(fixture.workspace, ["diff", "--cached", "--name-status"]), staged);
  } finally { fixture.cleanup(); }
});

function makeRecoveryFixture({ concurrentUpdate = false, missingGeneratedBranch = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-local-bridge-s6-recovery-"));
  const managerRoot = path.join(root, "chatgpt-local-bridge-s6-manager");
  const sessionId = "s6-recovery-0123456789abcdef";
  const generatedBranch = `bridge/s6/${sessionId}`;
  const taskBranch = "bridge/s7b/coordinator-runtime-activation";
  const workspace = path.join(managerRoot, "sessions", sessionId);
  const governanceRoot = path.join(managerRoot, "governance", `${sessionId}-0123456789abcdef`);
  const statePath = path.join(managerRoot, "manager-state", `${sessionId}.json`);
  fs.mkdirSync(workspace, { recursive: true });
  git(workspace, ["init", "-q", "-b", "main"]);
  git(workspace, ["config", "user.name", "Recovery Fixture"]);
  git(workspace, ["config", "user.email", "recovery-fixture@example.invalid"]);
  git(workspace, ["config", "core.hooksPath", S6_GOVERNANCE_HOOKS_PATH]);
  git(workspace, ["remote", "add", "origin", S6_REPOSITORY_URL]);
  git(workspace, ["config", "remote.origin.fetch", S6_STANDARD_FETCH_REFSPEC]);
  fs.writeFileSync(path.join(workspace, "README.md"), "base\n");
  git(workspace, ["add", "--", "README.md"]);
  git(workspace, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "base"]);
  const parent = git(workspace, ["rev-parse", "HEAD"]);
  git(workspace, ["branch", generatedBranch, parent]);
  git(workspace, ["switch", "-qc", taskBranch]);
  fs.writeFileSync(path.join(workspace, "README.md"), "base\nreviewed candidate\n");
  git(workspace, ["add", "--", "README.md"]);
  git(workspace, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", SUBJECT]);
  const commit = git(workspace, ["rev-parse", "HEAD"]);
  const tree = git(workspace, ["rev-parse", "HEAD^{tree}"]);
  if (missingGeneratedBranch) git(workspace, ["branch", "-d", generatedBranch]);
  git(workspace, ["update-ref", "refs/remotes/origin/sentinel", parent]);

  fs.mkdirSync(path.join(governanceRoot, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(governanceRoot, "hooks", "pre-commit"), S6_REVIEWED_HOOK_SOURCE, { mode: 0o700 });
  fs.copyFileSync(path.resolve("scripts/pre-commit-policy.mjs"), path.join(governanceRoot, "pre-commit-policy.mjs"));
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    kind: "workspace",
    state: "active",
    sessionId,
    branch: generatedBranch,
    source: S6_REPOSITORY_URL,
    workspacePath: workspace,
    statePath,
    ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
    expectedBaseCommit: parent,
    sourceCommit: parent,
    governanceHostRoot: governanceRoot,
    historyCommits: 1,
    coreHooksPath: S6_GOVERNANCE_HOOKS_PATH,
  }, null, 2)}\n`);

  let concurrentSha = null;
  let injected = false;
  if (concurrentUpdate) concurrentSha = commitTree(workspace, tree, parent, "concurrent ref update");
  const gitRunner = concurrentUpdate ? (args, cwd, env) => {
    if (!injected && args[0] === "update-ref" && args[1] === `refs/heads/${generatedBranch}`) {
      injected = true;
      runGitRaw(workspace, ["update-ref", `refs/heads/${generatedBranch}`, concurrentSha, parent], env);
    }
    return runGitRaw(cwd, args, env);
  } : null;
  const broker = new S6GitHubBroker({ managerRoot, bridgeRoot: path.resolve("."), sessionId, platform: "linux", gitRunner });
  const expectations = { expectedCommit: commit, expectedParent: parent, expectedTree: tree, expectedSubject: SUBJECT };
  return { root, managerRoot, sessionId, generatedBranch, taskBranch, workspace, governanceRoot, statePath, parent, commit, tree, broker, expectations, concurrentSha, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function assertUnrecovered(fixture) {
  assert.equal(git(fixture.workspace, ["branch", "--show-current"]), fixture.taskBranch);
  assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]), fixture.commit);
  assert.equal(git(fixture.workspace, ["rev-parse", fixture.generatedBranch]), fixture.parent);
}

function commitTree(workspace, tree, parent, subject) {
  const result = spawnSync("git", ["commit-tree", tree, "-p", parent, "-m", subject], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Recovery Fixture", GIT_AUTHOR_EMAIL: "recovery-fixture@example.invalid", GIT_COMMITTER_NAME: "Recovery Fixture", GIT_COMMITTER_EMAIL: "recovery-fixture@example.invalid" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runGitRaw(cwd, args, env = process.env) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function git(cwd, args) {
  const result = runGitRaw(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}
