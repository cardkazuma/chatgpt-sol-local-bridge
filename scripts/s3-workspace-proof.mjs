import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { DisposableWorkspaceManager } from "./disposable-workspace.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(scriptPath), "..");
const isWorker = process.argv[2] === "--worker";
const base = isWorker ? null : fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s3-workspace-proof-"));
const source = isWorker ? process.env.S3_WORKSPACE_SOURCE : path.join(base, "source-repo");
const managerRoot = isWorker ? process.env.S3_WORKSPACE_ROOT : path.join(base, "manager");
const sourceHome = isWorker ? null : path.join(base, "source-home");
const staleAfterMs = 25;
const protectedPaths = [repo, path.resolve(repo, "..", "homelab"), path.resolve(repo, "..", "homelab-s3")];
const governance = {
  hookFile: path.join(repo, ".githooks", "pre-commit"),
  policyFile: path.join(repo, "scripts", "pre-commit-policy.mjs"),
};

if (!isWorker) try {
  prepareSource();
  assert.throws(() => new DisposableWorkspaceManager({ root: path.join(repo, "unsafe-sessions"), source, protectedPaths }), /normal user's home|protected checkout/);
  assert.throws(() => new DisposableWorkspaceManager({ root: path.join(base, "safe"), source: repo, protectedPaths }), /normal user's home|protected checkout/);
  assert.throws(() => new DisposableWorkspaceManager({ root: "/volume1/docker/bridge-sessions", source, protectedPaths }), /volume1\/docker/);

  const manager = new DisposableWorkspaceManager({ root: managerRoot, source, governance, protectedPaths, staleAfterMs });
  const concurrent = await Promise.all([runWorker(), runWorker()]);
  assert.equal(new Set(concurrent.map((item) => item.sessionId)).size, 2);
  assert.equal(new Set(concurrent.map((item) => item.workspacePath)).size, 2);
  assert.equal(new Set(concurrent.map((item) => item.branch)).size, 2);
  for (const record of concurrent) validateRecord(record);

  fs.writeFileSync(path.join(concurrent[0].workspacePath, "session-a.txt"), "A\n");
  fs.writeFileSync(path.join(concurrent[1].workspacePath, "session-b.txt"), "B\n");
  assert.equal(fs.existsSync(path.join(concurrent[0].workspacePath, "session-b.txt")), false);
  assert.equal(fs.existsSync(path.join(concurrent[1].workspacePath, "session-a.txt")), false);

  const refreshed = manager.refresh(concurrent[0].sessionId);
  validateRecord(refreshed);
  assert.equal(refreshed.workspacePath, concurrent[0].workspacePath);
  assert.equal(fs.existsSync(path.join(refreshed.workspacePath, "session-a.txt")), false);
  assert.equal(fs.readdirSync(manager.sessionsRoot).some((name) => /\.(?:incoming|retired)-/.test(name)), false);

  manager.destroy(concurrent[0].sessionId);
  manager.destroy(concurrent[1].sessionId);
  assert.equal(fs.existsSync(concurrent[0].workspacePath), false);
  assert.equal(fs.existsSync(concurrent[1].workspacePath), false);

  const stale = await runKilledWorker();
  assert.equal(fs.existsSync(stale.workspacePath), true);
  const reaped = manager.reapStale(Date.now() + staleAfterMs + 1_000);
  assert.deepEqual(reaped, [stale.sessionId]);
  assert.equal(fs.existsSync(stale.workspacePath), false);
  assert.equal(fs.existsSync(stale.statePath), false);
  assert.deepEqual(manager.destroyAll(), []);

  console.log(JSON.stringify({
    proof: "s3-disposable-workspace-lifecycle",
    pass: true,
    sourceMechanism: "full Git clone with --no-local --no-hardlinks; no worktree shared with an active checkout",
    sourceHistoryCommits: Number(git(["rev-list", "--all", "--count"], source, sourceGitEnv()).trim()),
    checks: {
      protectedPathRejection: "PASS",
      sourceOverlapRejection: "PASS",
      noHomeOrNasWorkspaceRoot: "PASS",
      concurrentSessions: "PASS",
      uniqueSessionBranches: "PASS",
      fullHistory: "PASS",
      hooksPath: "PASS",
      ignoredAndRuntimeMaterialExcluded: "PASS",
      boundedOwnershipAndPermissions: "PASS",
      replacementRefresh: "PASS",
      staleDetection: "PASS",
      abnormalTerminationReaping: "PASS",
      deterministicDestroy: "PASS",
    },
  }, null, 2));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

function prepareSource() {
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sourceHome, { recursive: true, mode: 0o700 });
  write(".gitignore", [".env", "db.env", ".storage/", "runtime/", "backups/", "*.log", "*.db"].join("\n") + "\n");
  write("README.md", "clean disposable source\n");
  write("package.json", JSON.stringify({ name: "s3-disposable-source", version: "1.0.0" }, null, 2) + "\n");
  fs.mkdirSync(path.join(source, ".githooks"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true, mode: 0o700 });
  fs.copyFileSync(governance.hookFile, path.join(source, ".githooks", "pre-commit"));
  fs.copyFileSync(governance.policyFile, path.join(source, "scripts", "pre-commit-policy.mjs"));
  fs.chmodSync(path.join(source, ".githooks", "pre-commit"), 0o755);
  write(".env", "DISPOSABLE_FIXTURE_VALUE\n");
  write("db.env", "DISPOSABLE_DATABASE_VALUE\n");
  write("fixture.log", "DISPOSABLE_LOG_VALUE\n");
  write("runtime/state.json", "DISPOSABLE_RUNTIME_VALUE\n");
  write(".storage/token", "DISPOSABLE_STORAGE_VALUE\n");
  write("backups/archive.db", "DISPOSABLE_BACKUP_VALUE\n");
  const env = sourceGitEnv();
  git(["init", "-q", "-b", "main"], source, env);
  git(["config", "core.hooksPath", "/dev/null"], source, env);
  git(["config", "user.name", "S3 Fixture"], source, env);
  git(["config", "user.email", "s3-fixture@example.invalid"], source, env);
  git(["add", ".gitignore", "README.md", "package.json", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs"], source, env);
  git(["commit", "-qm", "source baseline"], source, env);
  write("README.md", "clean disposable source with history\n");
  git(["add", "README.md"], source, env);
  git(["commit", "-qm", "source second commit"], source, env);
  assert.equal(fs.existsSync(path.join(source, ".env")), true);
  assert.equal(git(["status", "--porcelain", "--ignored", "--untracked-files=all"], source, env).includes(".env"), true);
}

function validateRecord(record) {
  assert.match(record.sessionId, /^s3-[a-z0-9]+-[0-9a-f]{16}$/);
  assert.match(record.branch, /^bridge\/s3\/s3-[a-z0-9]+-[0-9a-f]{16}$/);
  assert.equal(record.coreHooksPath, ".githooks");
  assert.equal(record.historyCommits, 2);
  assert.equal(git(["rev-parse", "--is-shallow-repository"], record.workspacePath, safeGitEnv(record)).trim(), "false");
  assert.equal(git(["branch", "--show-current"], record.workspacePath, safeGitEnv(record)).trim(), record.branch);
  for (const relative of [".env", "db.env", "fixture.log", "runtime/state.json", ".storage/token", "backups/archive.db"]) {
    assert.equal(fs.existsSync(path.join(record.workspacePath, relative)), false, `ignored/runtime material copied: ${relative}`);
  }
  assert.equal(git(["status", "--porcelain", "--ignored", "--untracked-files=all"], record.workspacePath, safeGitEnv(record)).trim(), "");
  assert.equal(git(["config", "--global", "--list"], record.workspacePath, safeGitEnv(record)).trim(), "");
  assert.equal(git(["config", "--get", "remote.source.url"], record.workspacePath, safeGitEnv(record)).includes("@"), false);
  validatePermissions(record.workspacePath);
}

function validatePermissions(target) {
  const current = typeof process.getuid === "function" ? process.getuid() : null;
  const stat = fs.lstatSync(target);
  if (current != null) assert.equal(stat.uid, current);
  assert.equal(stat.mode & 0o022, 0);
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    const child = fs.lstatSync(full);
    if (current != null) assert.equal(child.uid, current);
    assert.equal(child.mode & 0o022, 0, `group/other writable workspace entry: ${full}`);
    if (entry.isDirectory()) validatePermissions(full);
  }
}

async function runWorker() {
  return runChild({ killAfterCreate: false });
}

async function runKilledWorker() {
  return runChild({ killAfterCreate: true });
}

async function runChild({ killAfterCreate }) {
  const child = spawn(process.execPath, [scriptPath, "--worker"], {
    cwd: repo,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      S3_WORKSPACE_ROOT: managerRoot,
      S3_WORKSPACE_SOURCE: source,
      S3_WORKSPACE_HOOK: governance.hookFile,
      S3_WORKSPACE_POLICY: governance.policyFile,
      S3_WORKSPACE_PROTECTED: protectedPaths.join(path.delimiter),
      S3_WORKSPACE_STALE_MS: String(staleAfterMs),
      S3_KILL_AFTER_CREATE: killAfterCreate ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  const record = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not provision a session\n${output}\n${errorOutput}`)), 30_000);
    const onData = () => {
      const line = output.split(/\r?\n/).find((item) => item.startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  if (killAfterCreate) {
    child.kill("SIGKILL");
    await once(child, "close");
  } else {
    child.kill("SIGTERM");
    await once(child, "close");
  }
  return record;
}

if (process.argv[2] === "--worker") {
  const manager = new DisposableWorkspaceManager({
    root: process.env.S3_WORKSPACE_ROOT,
    source: process.env.S3_WORKSPACE_SOURCE,
    governance: { hookFile: process.env.S3_WORKSPACE_HOOK, policyFile: process.env.S3_WORKSPACE_POLICY },
    protectedPaths: String(process.env.S3_WORKSPACE_PROTECTED || "").split(path.delimiter).filter(Boolean),
    staleAfterMs: Number(process.env.S3_WORKSPACE_STALE_MS),
  });
  const record = manager.create();
  process.stdout.write(`${JSON.stringify(record)}\n`);
  setInterval(() => {}, 1_000);
}

function write(relative, content) {
  const target = path.join(source, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

function git(args, cwd, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout || "";
}

function sourceGitEnv() {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: sourceHome,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function safeGitEnv(record) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: path.join(path.dirname(path.dirname(record.workspacePath)), "git-home"),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}
