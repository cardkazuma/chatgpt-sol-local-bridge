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
    const first = await fixture.brokerA.coordinateMutation({ route: "edit_file", path: "HANDOFF.md", observedContentSha256: contentSha256("v1\n") });
    assert.equal(first.decision, "ALLOW");

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

test("R2 real handlers preserve content freshness across stale write, pending edit, and reread", async () => {
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
    process.env.WORKSPACE_ROOTS = [fixture.sessionA.workspacePath, fixture.sessionB.workspacePath].join(path.delimiter);
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
      process.env.DEFAULT_WORKSPACE = which === "A" ? fixture.sessionA.workspacePath : fixture.sessionB.workspacePath;
    };
    const call = (name, args) => handlers.get(name)(args);
    pendingRequest = async (value) => {
      const broker = active === "A" ? fixture.brokerA : fixture.brokerB;
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

    const refreshed = await call("read_file", { path: fileA });
    assert.equal(refreshed.isError, undefined, refreshed.content?.[0]?.text);
    const validEdit = await call("edit_file", { path: fileA, oldText: "two", newText: "A2" });
    assert.equal(validEdit.isError, undefined, validEdit.content?.[0]?.text);
    assert.equal(fs.readFileSync(fileA, "utf8"), "value=A2\n");

    setS6BrokerRequestForTests(null);
  } finally {
    const { setS6BrokerRequestForTests } = await import("../../src/lib/s6-broker-client.js");
    setS6BrokerRequestForTests(null);
    restoreEnvironment(prior);
    fixture.cleanup();
  }

});

async function createFixture() {
  ({ DisposableWorkspaceManager } = await import("../../scripts/disposable-workspace.mjs"));
  ({ S6GitHubBroker, S6_REPOSITORY_URL, S6_GOVERNANCE_HOOKS_PATH, S6_GOVERNANCE_POLICY_PATH, S6_CANONICAL_PLACEHOLDER_PATHS } = await import("../../scripts/s6-github-broker.mjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7b-review-fix-"));
  const source = path.join(root, "source");
  const managerRoot = path.join(root, "chatgpt-local-bridge-s6-review-fix-manager");
  fs.mkdirSync(managerRoot, { recursive: true, mode: 0o700 });
  createSource(source);
  const store = path.join(root, "coordinator.sqlite3");
  const configPath = path.join(os.homedir(), "Library", "Application Support", "ChatGPT Local Bridge", "s7b-coordinator.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const python = config.pythonExecutable;
  const driver = path.join(REPO_ROOT, "scripts", "s7b-coordinator-driver.py");
  const init = spawnSync(python, ["-c", [
    "import sys",
    "from work_coordinator.infrastructure.storage.migration_runner import MigrationRunner",
    "MigrationRunner(sys.argv[1], busy_timeout_ms=5000, max_attempts=3).migrate()",
  ].join("\n"), store], { encoding: "utf8", env: { ...process.env, PYTHONNOUSERSITE: "1" } });
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
  const brokerA = makeBroker(sessionA.sessionId);
  const brokerB = makeBroker(sessionB.sessionId);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, store, python, driver, manager, sessionA, sessionB, brokerA, brokerB, makeBroker, cleanup };
}

function createSource(source) {
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
  fs.mkdirSync(path.join(source, ".githooks"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, ".githooks", "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = { ...process.env, HOME: path.join(source, "git-home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  runGit(["init", "-q", "-b", "main"], source, env);
  runGit(["config", "core.hooksPath", "/dev/null"], source, env);
  runGit(["config", "user.name", "S7-B review source"], source, env);
  runGit(["config", "user.email", "s7b-review-source@example.invalid"], source, env);
  runGit(["add", "--", ".gitignore", "README.md", "HANDOFF.md", "docs/notes.md", "package.json", "paperless/secrets/decrypt-passwords.txt.example", ".githooks/commit-msg"], source, env);
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
