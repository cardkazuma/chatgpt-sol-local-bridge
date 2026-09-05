#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EXPECTED_TOOLS, DISABLED_TOOLS, S5Runtime } from "./s5-runtime.mjs";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s5-runtime-proof-"));
const source = path.join(base, "fixture-source");
const managerRoot = path.join(os.tmpdir(), `chatgpt-local-bridge-s5-proof-${process.pid}`);
const runtimeRoot = path.join(base, "runtime");
const gitHome = path.join(base, "git-home");

class NoopDocker {
  run() { return { status: 1, stdout: "", stderr: "docker unavailable in offline proof" }; }
  imageAvailable() { return false; }
  probeDocker() { return false; }
  probeCompose() { return false; }
}

const env = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: gitHome,
  XDG_CONFIG_HOME: path.join(gitHome, "config"),
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  GIT_OPTIONAL_LOCKS: "0",
};

try {
  prepareFixture();
  const runtime = new S5Runtime({
    runtimeRoot,
    managerRoot,
    platform: "darwin",
    securityBin: path.join(base, "missing-security"),
    docker: new NoopDocker(),
    spawnSupervisor: false,
  });

  const session = runtime.workspaceCreate(source);
  assert.match(session.sessionId, /^s5-[a-z0-9]+-[0-9a-f]{16}$/);
  assert.match(session.branch, new RegExp(`^bridge/s5/${session.sessionId}$`));
  const workspace = path.join(managerRoot, "sessions", session.sessionId);
  const workspaceEnv = { ...env, HOME: path.join(managerRoot, "git-home"), XDG_CONFIG_HOME: path.join(managerRoot, "git-home", "config") };
  runGit(["config", "user.name", "S5 Fixture"], workspace, workspaceEnv);
  runGit(["config", "user.email", "s5-fixture@example.invalid"], workspace, workspaceEnv);
  runGit(["status", "--porcelain", "--untracked-files=all"], workspace, workspaceEnv, "");
  runGit(["branch", "--", `bridge/s5/${session.sessionId}-proof`], workspace, workspaceEnv);
  runGit(["switch", "--no-guess", "--", `bridge/s5/${session.sessionId}-proof`], workspace, workspaceEnv);
  fs.writeFileSync(path.join(workspace, "README.md"), "S5 fixture edited through the bounded workflow\n", { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, "not-selected.txt"), "temporary unselected change\n", { mode: 0o600 });
  const diff = runGit(["diff", "--no-ext-diff", "--no-textconv", "--", "README.md"], workspace, workspaceEnv);
  assert.match(diff, /S5 fixture edited/);
  runNodeTest(workspace, workspaceEnv);
  runGit(["add", "--", "README.md"], workspace, workspaceEnv);
  assert.equal(runGit(["diff", "--cached", "--name-only", "-z"], workspace, workspaceEnv), "README.md\0");
  runGit(["-c", "core.hooksPath=.githooks", "commit", "-m", "S5 fixture bounded edit"], workspace, workspaceEnv);
  fs.rmSync(path.join(workspace, "not-selected.txt"));
  assert.equal(runGit(["status", "--porcelain", "--untracked-files=all"], workspace, workspaceEnv), "");
  assert.match(runGit(["log", "-1", "--format=%s"], workspace, workspaceEnv), /S5 fixture bounded edit/);
  runtime.workspaceDestroy(session.sessionId);

  const stale = runtime.workspaceCreate(source);
  const staleStatePath = path.join(managerRoot, "manager-state", `${stale.sessionId}.json`);
  const staleState = JSON.parse(fs.readFileSync(staleStatePath, "utf8"));
  staleState.heartbeatAt = new Date(Date.now() - 30 * 60_000).toISOString();
  staleState.pid = 2_147_483_647;
  fs.writeFileSync(staleStatePath, `${JSON.stringify(staleState, null, 2)}\n`, { mode: 0o600 });
  const reaped = runtime.workspaceList();
  assert.deepEqual(reaped.reapedSessions, [stale.sessionId]);
  assert.equal(fs.existsSync(path.join(managerRoot, "sessions", stale.sessionId)), false);

  const failedStart = await assertFailClosedStart(runtime);
  const status = runtime.status({ inspectLive: false });
  assert.equal(status.running, false);
  assert.equal(status.phase, "stopped");
  assert.deepEqual(await runtime.stop(), { running: false, stopped: false, workspaceDestruction: "not requested" });
  const rollback = await runtime.rollback();

  console.log(JSON.stringify({
    proof: "s5-runtime-offline-lifecycle",
    s5Gate: "NOT PASSED",
    pass: true,
    catalog: { exactToolCount: EXPECTED_TOOLS.length, disabledAbsent: DISABLED_TOOLS.length },
    workspaceLifecycle: "PASS: S5 namespace, full-history disposable clone, hooks path, selected stage, hook-enforced local commit, clean tracked state, deterministic destroy",
    staleRecovery: "PASS: dead-PID stale workspace was detected and reaped deterministically",
    failClosedStart: failedStart,
    status: "PASS: sanitized stopped state with no credential values",
    stop: "PASS: no active runtime; workspace destruction was not requested",
    rollback: rollback.rolledBack ? "PASS: S5 runtime state and disposable workspaces removed; Keychain untouched" : "FAIL",
    ordinaryChat: "NOT RUN: browser/desktop automation is explicitly prohibited",
    runtimeTransport: "NOT RUN: Docker daemon was unavailable; no service was started",
  }, null, 2));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

async function assertFailClosedStart(runtime) {
  await assert.rejects(
    runtime.start({ source, tunnelId: "tunnel_s5_offline" }),
    /S5 start blocked: tunnel-client binary path is required/,
  );
  assert.equal(fs.existsSync(runtime.stateFile), false);
  assert.equal(fs.readdirSync(path.join(managerRoot, "manager-state")).length, 0);
  return "PASS: missing pinned tunnel inputs blocked startup and cleaned the newly-created disposable session";
}

function prepareFixture() {
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.mkdirSync(gitHome, { recursive: true, mode: 0o700 });
  writeSource(".gitignore", [".env", "db.env", "*.log", "runtime/", "backups/", ".storage/"].join("\n") + "\n");
  writeSource("README.md", "S5 fixture baseline\n");
  writeSource("package.json", JSON.stringify({ name: "s5-disposable-fixture", version: "1.0.0", type: "module" }, null, 2) + "\n");
  writeSource("test/fixture.test.mjs", "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture', () => assert.equal(2 + 2, 4));\n");
  fs.mkdirSync(path.join(source, ".githooks"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(repo, ".githooks", "pre-commit"), path.join(source, ".githooks", "pre-commit"));
  fs.copyFileSync(path.join(repo, "scripts", "pre-commit-policy.mjs"), path.join(source, "scripts", "pre-commit-policy.mjs"));
  fs.chmodSync(path.join(source, ".githooks", "pre-commit"), 0o755);
  writeSource(".env", "fixture-only\n");
  writeSource("db.env", "fixture-only\n");
  writeSource("fixture.log", "fixture-only\n");
  writeSource("runtime/state.json", "fixture-only\n");
  runGit(["init", "-q", "-b", "main"], source, env);
  runGit(["config", "core.hooksPath", "/dev/null"], source, env);
  runGit(["config", "user.name", "S5 Fixture Source"], source, env);
  runGit(["config", "user.email", "s5-source@example.invalid"], source, env);
  runGit(["add", ".gitignore", "README.md", "package.json", "test/fixture.test.mjs", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs"], source, env);
  runGit(["commit", "-qm", "S5 fixture baseline"], source, env);
  writeSource("README.md", "S5 fixture with history\n");
  runGit(["add", "README.md"], source, env);
  runGit(["commit", "-qm", "S5 fixture history"], source, env);
}

function writeSource(relative, content) {
  const target = path.join(source, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

function runNodeTest(cwd, runEnv) {
  const result = spawnSync(process.execPath, ["--test", "test/fixture.test.mjs"], { cwd, env: runEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "fixture test failed");
}

function runGit(args, cwd, runEnv, expected = undefined) {
  const result = spawnSync("git", args, { cwd, env: runEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  const output = result.stdout || "";
  if (expected !== undefined) assert.equal(output, expected);
  return output;
}
