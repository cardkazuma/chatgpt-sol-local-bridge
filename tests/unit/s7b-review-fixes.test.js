import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const ARTIFACT_SHA256 = "3e528011ce130797af25aeca2f1bb1faea294cd46838cfbadffc488cd9463f96";
const REPOSITORY_ID = "1297989453";
const TEST_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s7b-review-state-"));
const TEST_HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s7b-review-home-"));
process.env.HOME = TEST_HOME_ROOT;
process.env.XDG_CONFIG_HOME = path.join(TEST_HOME_ROOT, "config");
process.env.BRIDGE_STATE_DIR = TEST_STATE_ROOT;
process.env.BRIDGE_SCRATCH_DIR = path.join(TEST_STATE_ROOT, "scratch");
let DisposableWorkspaceManager;
let S6GitHubBroker;
let S6_REPOSITORY_URL;
let S6_GOVERNANCE_HOOKS_PATH;
let S6_GOVERNANCE_POLICY_PATH;
let S6_CANONICAL_PLACEHOLDER_PATHS;

test("R1 shared selected-store binding survives another session's normal broker writes and restart", async () => {
  const fixture = await createFixture();
  const prior = captureEnvironment([
    "S7B_COORDINATOR_PYTHON", "S7B_COORDINATOR_DRIVER", "S7B_COORDINATOR_STORE",
    "S7B_COORDINATOR_BOOT_IDENTITY", "S7B_COORDINATOR_SAFETY_GENERATION",
    "S7B_COORDINATOR_REPOSITORY_ID", "S7B_COORDINATOR_ARTIFACT_SHA256",
  ]);
  try {
    configureCoordinator(fixture);
    await fixture.brokerA.coordinateObservation({ path: "HANDOFF.md", contentSha256: contentSha256("v1\n") });
    const first = await fixture.brokerA.coordinateMutation({ route: "edit_file", path: "HANDOFF.md", observedContentSha256: contentSha256("v1\n") });
    assert.equal(first.decision, "ALLOW");

    await fixture.brokerB.coordinateObservation({ path: "HANDOFF.md", contentSha256: contentSha256("v1\n") });
    const second = await fixture.brokerB.coordinateMutation({ route: "edit_file", path: "HANDOFF.md", observedContentSha256: contentSha256("v1\n") });
    assert.equal(second.decision, "ALLOW");

    const continued = await fixture.brokerA.coordinateMutation({ route: "edit_file", path: "HANDOFF.md", observedContentSha256: contentSha256("v1\n") });
    assert.equal(continued.decision, "ALLOW", "A must not fail merely because B appended coordinator state");

    const restartedA = fixture.makeBroker(fixture.sessionA.sessionId);
    const afterRestart = await restartedA.coordinateMutation({ route: "edit_file", path: "HANDOFF.md", observedContentSha256: contentSha256("v1\n") });
    assert.equal(afterRestart.decision, "ALLOW", "a fresh broker must retain the same selected-store binding");
  } finally {
    restoreEnvironment(prior);
    fixture.cleanup();
  }
});

test("R2 real handlers preserve the original observation across stale writes, patches, refs, missing reads, and rereads", async () => {
  const fixture = await createFixture();
  const prior = captureEnvironment([
    "BRIDGE_GOVERNANCE_MODE", "DEFAULT_WORKSPACE", "WORKSPACE_ROOTS", "BRIDGE_STATE_DIR", "BRIDGE_SCRATCH_DIR",
    "S7B_COORDINATOR_PYTHON", "S7B_COORDINATOR_DRIVER", "S7B_COORDINATOR_STORE",
    "S7B_COORDINATOR_BOOT_IDENTITY", "S7B_COORDINATOR_SAFETY_GENERATION",
    "S7B_COORDINATOR_REPOSITORY_ID", "S7B_COORDINATOR_ARTIFACT_SHA256",
  ]);
  let handlers;
  let active = "A";
  let delayNextEdit = false;
  let pendingRequest;
  try {
    process.env.BRIDGE_GOVERNANCE_MODE = "s6";
    process.env.BRIDGE_STATE_DIR = path.join(fixture.root, "bridge-state");
    process.env.BRIDGE_SCRATCH_DIR = path.join(fixture.root, "bridge-scratch");
    process.env.WORKSPACE_ROOTS = [fixture.sessionA.workspacePath, fixture.sessionB.workspacePath, fixture.sessionC.workspacePath].join(path.delimiter);
    process.env.S7B_COORDINATOR_PYTHON = fixture.python;
    process.env.S7B_COORDINATOR_DRIVER = fixture.driver;
    process.env.S7B_COORDINATOR_STORE = fixture.store;
    process.env.S7B_COORDINATOR_BOOT_IDENTITY = "s7b-review-fix-boot";
    process.env.S7B_COORDINATOR_SAFETY_GENERATION = "1";
    process.env.S7B_COORDINATOR_REPOSITORY_ID = REPOSITORY_ID;
    process.env.S7B_COORDINATOR_ARTIFACT_SHA256 = ARTIFACT_SHA256;
    const { registerFiles } = await import("../../src/tools/files.js");
    handlers = new Map();
    registerFiles({ registerTool(name, _definition, handler) { handlers.set(name, handler); } });
    assert.deepEqual(["read_file", "write_file", "apply_patch", "edit_file"].filter((name) => handlers.has(name)), ["read_file", "write_file", "apply_patch", "edit_file"]);

    const { setS6BrokerRequestForTests } = await import("../../src/lib/s6-broker-client.js");
    const setActive = (which) => {
      active = which;
      process.env.DEFAULT_WORKSPACE = fixture[`session${which}`].workspacePath;
    };
    const call = (name, args) => handlers.get(name)(args);
    pendingRequest = async (value) => {
      const broker = fixture[`broker${active}`];
      if (value.operation === "coordinate-mutation" && value.route === "edit_file" && delayNextEdit) {
        delayNextEdit = false;
        setActive("B");
        const changed = await call("write_file", { path: path.join(fixture.sessionB.workspacePath, "HANDOFF.md"), content: "value=two\n" });
        assert.equal(changed.isError, undefined, changed.content?.[0]?.text);
        fs.writeFileSync(path.join(fixture.sessionA.workspacePath, "HANDOFF.md"), "value=two\n", { mode: 0o600 });
        setActive("A");
      }
      if (value.operation === "coordinate-observe") return broker.coordinateObservation({ path: value.path, contentSha256: value.contentSha256 });
      if (value.operation === "coordinate-mutation") {
        return broker.coordinateMutation({
          route: value.route,
          path: value.path,
          ...(Object.hasOwn(value, "observedContentSha256") ? { observedContentSha256: value.observedContentSha256 } : {}),
        });
      }
      throw new Error(`unexpected test broker operation: ${value.operation}`);
    };
    setS6BrokerRequestForTests(pendingRequest);
    const fileA = path.join(fixture.sessionA.workspacePath, "HANDOFF.md");
    const fileB = path.join(fixture.sessionB.workspacePath, "HANDOFF.md");

    setActive("A");
    fs.writeFileSync(fileA, "v1\n", { mode: 0o600 });
    fs.writeFileSync(fileB, "v1\n", { mode: 0o600 });
    const readA = await call("read_file", { path: fileA });
    assert.equal(readA.isError, undefined, readA.content?.[0]?.text);

    setActive("B");
    const readB = await call("read_file", { path: fileB });
    assert.equal(readB.isError, undefined, readB.content?.[0]?.text);
    const bWrite = await call("write_file", { path: fileB, content: "v2\n" });
    assert.equal(bWrite.isError, undefined, bWrite.content?.[0]?.text);
    fs.writeFileSync(fileA, "v2\n", { mode: 0o600 });

    setActive("A");
    const staleWrite = await call("write_file", { path: fileA, content: "A based on v1\n" });
    assert.equal(staleWrite.isError, true);
    assert.match(staleWrite.content[0].text, /STALE_OBSERVATION|REFRESH/);
    assert.equal(fs.readFileSync(fileA, "utf8"), "v2\n", "stale write must preserve B's content");

    // B changes only the second line before A enters edit_file. The oldText
    // still matches, so refreshing the observation from the write-time bytes
    // would incorrectly authorize a lost update.
    fs.writeFileSync(fileA, "value=one\nother=one\n", { mode: 0o600 });
    fs.writeFileSync(fileB, "value=one\nother=one\n", { mode: 0o600 });
    setActive("A");
    assert.equal((await call("read_file", { path: fileA })).isError, undefined);
    setActive("B");
    assert.equal((await call("read_file", { path: fileB })).isError, undefined);
    const bEdit = await call("write_file", { path: fileB, content: "value=one\nother=two\n" });
    assert.equal(bEdit.isError, undefined, bEdit.content?.[0]?.text);
    fs.writeFileSync(fileA, "value=one\nother=two\n", { mode: 0o600 });
    setActive("A");
    const staleEdit = await call("edit_file", { path: fileA, oldText: "value=one", newText: "value=A" });
    assert.equal(staleEdit.isError, true);
    assert.match(staleEdit.content[0].text, /STALE_OBSERVATION|REFRESH/);
    assert.equal(fs.readFileSync(fileA, "utf8"), "value=one\nother=two\n", "stale edit must preserve B's content");

    // apply_patch must preserve the same original observation even though
    // git apply --check and target hashing happen before the broker request.
    fs.writeFileSync(fileA, "value=one\nother=one\n", { mode: 0o600 });
    fs.writeFileSync(fileB, "value=one\nother=one\n", { mode: 0o600 });
    setActive("A");
    assert.equal((await call("read_file", { path: fileA })).isError, undefined);
    setActive("B");
    assert.equal((await call("read_file", { path: fileB })).isError, undefined);
    const bPatchWrite = await call("write_file", { path: fileB, content: "value=one\nother=two\n" });
    assert.equal(bPatchWrite.isError, undefined, bPatchWrite.content?.[0]?.text);
    fs.writeFileSync(fileA, "value=one\nother=two\n", { mode: 0o600 });
    setActive("A");
    const stalePatch = await call("apply_patch", { cwd: fixture.sessionA.workspacePath, diff: handoffPatch("value=one", "value=A", "two") });
    assert.equal(stalePatch.isError, true);
    assert.match(stalePatch.content[0].text, /STALE_OBSERVATION|REFRESH/);
    assert.equal(fs.readFileSync(fileA, "utf8"), "value=one\nother=two\n", "stale patch must preserve B's content");

    // Explicit reread establishes the new baseline and permits a valid patch.
    const refreshed = await call("read_file", { path: fileA });
    assert.equal(refreshed.isError, undefined, refreshed.content?.[0]?.text);
    const validPatch = await call("apply_patch", { cwd: fixture.sessionA.workspacePath, diff: handoffPatch("value=one", "value=patched", "two") });
    assert.equal(validPatch.isError, undefined, validPatch.content?.[0]?.text);
    assert.equal(fs.readFileSync(fileA, "utf8"), "value=patched\nother=two\n");

    // HEAD movement is also in the freshness tuple, even when target bytes
    // remain unchanged.
    fs.writeFileSync(fileA, "value=one\n", { mode: 0o600 });
    setActive("A");
    assert.equal((await call("read_file", { path: fileA })).isError, undefined);
    runGit(["commit", "--allow-empty", "--no-verify", "-qm", "S7-B review ref movement"], fixture.sessionA.workspacePath, {
      ...process.env,
      HOME: path.join(fixture.root, "git-home-ref-movement"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    const staleRefEdit = await call("edit_file", { path: fileA, oldText: "value=one", newText: "value=ref-stale" });
    assert.equal(staleRefEdit.isError, true);
    assert.match(staleRefEdit.content[0].text, /STALE_OBSERVATION|REFRESH/);
    assert.equal(fs.readFileSync(fileA, "utf8"), "value=one\n", "ref movement must not authorize a stale edit");
    assert.equal((await call("read_file", { path: fileA })).isError, undefined);
    const validRefEdit = await call("edit_file", { path: fileA, oldText: "value=one", newText: "value=refreshed" });
    assert.equal(validRefEdit.isError, undefined, validRefEdit.content?.[0]?.text);
    assert.equal(fs.readFileSync(fileA, "utf8"), "value=refreshed\n");

    // C has an existing file but no task/read observation. Handler-entry
    // bytes are not allowed to become synthetic read evidence.
    setActive("C");
    const missingRead = await call("edit_file", { path: fixture.sessionC.workspacePath + "/HANDOFF.md", oldText: "v1", newText: "C" });
    assert.equal(missingRead.isError, true);
    assert.match(missingRead.content[0].text, /STALE_OBSERVATION|REFRESH/);
    assert.equal(fs.readFileSync(fixture.sessionC.workspacePath + "/HANDOFF.md", "utf8"), "v1\n", "missing observation must not write");

    // Preserve the already-green pending-edit case: B changes the target
    // while A's real handler is waiting in the broker request.
    fs.writeFileSync(fileA, "value=one\n", { mode: 0o600 });
    fs.writeFileSync(fileB, "value=one\n", { mode: 0o600 });
    setActive("A");
    assert.equal((await call("read_file", { path: fileA })).isError, undefined);
    setActive("B");
    assert.equal((await call("read_file", { path: fileB })).isError, undefined);
    setActive("A");
    delayNextEdit = true;
    const delayedEdit = await call("edit_file", { path: fileA, oldText: "one", newText: "A" });
    assert.equal(delayedEdit.isError, true);
    assert.match(delayedEdit.content[0].text, /STALE_OBSERVATION|REFRESH/);
    assert.equal(fs.readFileSync(fileA, "utf8"), "value=two\n", "pending stale edit must not overwrite B");

    setS6BrokerRequestForTests(null);
  } finally {
    const { setS6BrokerRequestForTests } = await import("../../src/lib/s6-broker-client.js");
    setS6BrokerRequestForTests(null);
    restoreEnvironment(prior);
    fixture.cleanup();
  }

});

test("S7-B projects a real oversized coordinator mutation decision below the bounded broker response limit", async () => {
  const fixture = await createFixture({ extraTrackedEntries: 1_200 });
  const prior = captureEnvironment([
    "S7B_COORDINATOR_PYTHON", "S7B_COORDINATOR_DRIVER", "S7B_COORDINATOR_STORE",
    "S7B_COORDINATOR_BOOT_IDENTITY", "S7B_COORDINATOR_SAFETY_GENERATION",
    "S7B_COORDINATOR_REPOSITORY_ID", "S7B_COORDINATOR_ARTIFACT_SHA256",
  ]);
  try {
    configureCoordinator(fixture);
    let completeCheck = null;
    const invokeCoordinatorBound = fixture.brokerA.invokeCoordinatorBound.bind(fixture.brokerA);
    fixture.brokerA.invokeCoordinatorBound = async (request, context) => {
      const result = await invokeCoordinatorBound(request, context);
      if (request.action === "check_before_mutation") completeCheck = result;
      return result;
    };
    await fixture.brokerA.coordinateObservation({ path: "HANDOFF.md", contentSha256: contentSha256("v1\n") });
    const projected = await fixture.brokerA.coordinateMutation({ route: "edit_file", path: "HANDOFF.md", observedContentSha256: contentSha256("v1\n") });
    const unprojectedResponse = {
      allowed: true,
      decision: completeCheck.decision,
      reason_code: completeCheck.reason_code,
      freshness: completeCheck.freshness || null,
      enforcement: completeCheck.enforcement || null,
      store_health: completeCheck.store_health || null,
      evidence_refs: completeCheck.evidence_refs || [],
      lifecycle: { session_id: fixture.sessionA.sessionId, route: "edit_file", path: "HANDOFF.md", exclusive: false },
    };
    const fullBytes = Buffer.byteLength(JSON.stringify(unprojectedResponse));
    assert.ok(fullBytes > 128 * 1024, `actual complete coordinator result must exceed the client limit (got ${fullBytes})`);
    assert.equal(projected.bridge_projection, "s7b-mutation-result-v1");
    assert.equal(projected.decision, "ALLOW");
    assert.equal(projected.reason_code, completeCheck.reason_code);
    assert.deepEqual(projected.freshness.current.worktree_content_version, completeCheck.freshness.current.worktree_content_version);
    assert.equal(Object.hasOwn(projected.freshness.current, "index_entries"), false, "the Bridge must not receive the repository-wide index");
    assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 16 * 1024, "normal Bridge mutation response must retain a small documented bound");
  } finally {
    restoreEnvironment(prior);
    fixture.cleanup();
  }
});

function handoffPatch(oldValue, newValue, otherValue) {
  return [
    "diff --git a/HANDOFF.md b/HANDOFF.md",
    "--- a/HANDOFF.md",
    "+++ b/HANDOFF.md",
    "@@ -1,2 +1,2 @@",
    `-${oldValue}`,
    `+${newValue}`,
    ` other=${otherValue}`,
    "",
  ].join("\n");
}

async function createFixture({ extraTrackedEntries = 0 } = {}) {
  ({ DisposableWorkspaceManager } = await import("../../scripts/disposable-workspace.mjs"));
  ({ S6GitHubBroker, S6_REPOSITORY_URL, S6_GOVERNANCE_HOOKS_PATH, S6_GOVERNANCE_POLICY_PATH, S6_CANONICAL_PLACEHOLDER_PATHS } = await import("../../scripts/s6-github-broker.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7b-review-fix-"));
  const source = path.join(root, "source");
  const managerRoot = path.join(root, "chatgpt-local-bridge-s6-review-fix-manager");
  fs.mkdirSync(managerRoot, { recursive: true, mode: 0o700 });
  createSource(source, extraTrackedEntries);
  const store = path.join(root, "coordinator.sqlite3");
  const python = provisionedCoordinatorPython();
  const driver = path.join(REPO_ROOT, "scripts", "s7b-coordinator-driver.py");
  const init = spawnSync(python, ["-c", [
    "import sys",
    "from work_coordinator.infrastructure.storage.migration_runner import MigrationRunner",
    "MigrationRunner(sys.argv[1], busy_timeout_ms=5000, max_attempts=3).migrate()",
  ].join("\n"), store], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: TEST_HOME_ROOT,
      XDG_CONFIG_HOME: path.join(TEST_HOME_ROOT, "config"),
      PYTHONNOUSERSITE: "1",
      PYTHONPATH: "",
    },
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  fs.chmodSync(store, 0o600);

  const makeBroker = (sessionId) => new S6GitHubBroker({
    managerRoot,
    bridgeRoot: REPO_ROOT,
    sessionId,
    platform: "linux",
    gitRunner: (args, cwd, env) => offlineGitRunner(args, cwd, env, source),
    credentialRunner: (_options, callback) => callback({ helperBin: "/usr/bin/false" }),
  });
  const manager = new DisposableWorkspaceManager({
    root: managerRoot,
    source: S6_REPOSITORY_URL,
    remoteName: "origin",
    materializer: (context) => makeBroker(context.sessionId).materializeWorkspace(context),
    allowedTrackedPaths: S6_CANONICAL_PLACEHOLDER_PATHS,
    governance: {
      external: true,
      hookFile: path.join(REPO_ROOT, "scripts", "s6-pre-commit"),
      policyFile: path.join(REPO_ROOT, "scripts", "pre-commit-policy.mjs"),
      hooksPath: S6_GOVERNANCE_HOOKS_PATH,
      policyPath: S6_GOVERNANCE_POLICY_PATH,
    },
    gitIdentity: { name: "S7-B Review Fixture", email: "s7b-review-fixture@example.invalid" },
    protectedPaths: [REPO_ROOT, path.join(path.dirname(REPO_ROOT), "homelab")],
    sessionPrefix: "s6",
    branchPrefix: "bridge/s6",
    staleAfterMs: 15 * 60_000,
  });
  const sessionA = manager.create();
  const sessionB = manager.create();
  const sessionC = manager.create();
  const brokerA = makeBroker(sessionA.sessionId);
  const brokerB = makeBroker(sessionB.sessionId);
  const brokerC = makeBroker(sessionC.sessionId);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, store, python, driver, manager, sessionA, sessionB, sessionC, brokerA, brokerB, brokerC, makeBroker, cleanup };
}

function provisionedCoordinatorPython() {
  const python = process.env.S7B_REVIEW_COORDINATOR_PYTHON;
  const artifact = process.env.S7B_REVIEW_COORDINATOR_ARTIFACT_SHA256;
  const missing = !python || !path.isAbsolute(python) || !fs.existsSync(python) || !fs.statSync(python).isFile()
    || artifact !== ARTIFACT_SHA256;
  if (missing) {
    throw new Error("S7-B review fixture prerequisite missing: set S7B_REVIEW_COORDINATOR_PYTHON to an absolute provisioned interpreter and S7B_REVIEW_COORDINATOR_ARTIFACT_SHA256 to the accepted wheel SHA");
  }
  const probe = spawnSync(python, ["-c", [
    "import importlib.metadata as metadata",
    "assert metadata.version('work-coordinator') == '0.2.0'",
  ].join("\n")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: TEST_HOME_ROOT,
      XDG_CONFIG_HOME: path.join(TEST_HOME_ROOT, "config"),
      PYTHONNOUSERSITE: "1",
      PYTHONPATH: "",
    },
  });
  if (probe.status !== 0) {
    throw new Error(`S7-B review fixture prerequisite failed: provisioned interpreter does not expose work-coordinator==0.2.0 (${String(probe.stderr || probe.stdout || "unknown error").trim()})`);
  }
  return python;
}

function createSource(source, extraTrackedEntries = 0) {
  const files = {
    ".gitignore": "/runtime/\n*.log\n.env\n",
    "README.md": "S7-B review fixture\n",
    "HANDOFF.md": "v1\n",
    "docs/notes.md": "fixture\n",
    "package.json": "{\"name\":\"s7b-review-fixture\",\"private\":true}\n",
    "paperless/secrets/decrypt-passwords.txt.example": "change-me\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600 });
  }
  for (let index = 0; index < extraTrackedEntries; index += 1) {
    const relative = `docs/oversized-index/${String(index).padStart(4, "0")}.txt`;
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, `distinct coordinator index fixture ${index}\n`, { mode: 0o600 });
  }
  fs.mkdirSync(path.join(source, ".githooks"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, ".githooks", "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = { ...process.env, HOME: path.join(source, "git-home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  runGit(["init", "-q", "-b", "main"], source, env);
  runGit(["config", "core.hooksPath", "/dev/null"], source, env);
  runGit(["config", "user.name", "S7-B review source"], source, env);
  runGit(["config", "user.email", "s7b-review-source@example.invalid"], source, env);
  runGit(["add", "--all"], source, env);
  runGit(["commit", "--no-verify", "-qm", "S7-B review fixture baseline"], source, env);
}

function offlineGitRunner(args, cwd, env, source) {
  const mapped = args.map((item) => item === S6_REPOSITORY_URL ? source : item);
  const result = spawnSync("git", mapped, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (mapped[0] === "clone" && result.status === 0) {
    const configured = spawnSync("git", ["config", "remote.origin.url", S6_REPOSITORY_URL], { cwd: mapped.at(-1), env, encoding: "utf8" });
    if (configured.status !== 0) return configured;
  }
  return result;
}

function runGit(args, cwd, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr || result.stdout}`);
  return result.stdout || "";
}

function captureEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function configureCoordinator(fixture) {
  process.env.S7B_COORDINATOR_PYTHON = fixture.python;
  process.env.S7B_COORDINATOR_DRIVER = fixture.driver;
  process.env.S7B_COORDINATOR_STORE = fixture.store;
  process.env.S7B_COORDINATOR_BOOT_IDENTITY = "s7b-review-fix-boot";
  process.env.S7B_COORDINATOR_SAFETY_GENERATION = "1";
  process.env.S7B_COORDINATOR_REPOSITORY_ID = REPOSITORY_ID;
  process.env.S7B_COORDINATOR_ARTIFACT_SHA256 = ARTIFACT_SHA256;
}

function contentSha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
