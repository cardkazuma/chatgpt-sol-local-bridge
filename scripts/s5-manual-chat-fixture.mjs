import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DisposableWorkspaceManager } from "./disposable-workspace.mjs";

export const WORKFLOW_PROOF_FILE = "workflow-proof.txt";
export const WORKFLOW_PROOF_BASELINE = "S5 manual Chat proof baseline\n";
export const WORKFLOW_PROOF_APPEND = "S5 ordinary Chat proof\n";
export const WORKFLOW_PROOF_POST_MUTATION = `${WORKFLOW_PROOF_BASELINE}${WORKFLOW_PROOF_APPEND}`;
const FORBIDDEN_BASENAMES = new Set([".env", "db.env", "secrets.yaml", "secrets.yml", "secrets.json"]);
const FORBIDDEN_DIRECTORIES = new Set([".storage", "backups", "runtime", "node_modules"]);

export function prepareManualChatFixture({ managerRoot, repoRoot, governance, protectedPaths = [] }) {
  const sourceRoot = path.join(path.resolve(managerRoot), "fixture-sources", `s5-manual-${crypto.randomBytes(8).toString("hex")}`);
  createReviewedFixtureSource({ sourceRoot, repoRoot });
  const manager = new DisposableWorkspaceManager({
    root: managerRoot,
    source: sourceRoot,
    governance,
    protectedPaths,
    staleAfterMs: 15 * 60_000,
    sessionPrefix: "s5",
    branchPrefix: "bridge/s5",
  });
  let session;
  try {
    session = manager.create();
    const baseline = verifyManualChatFixture({ workspacePath: session.workspacePath, sourceRoot, governance, expectedBranch: session.branch, gitEnv: manager.gitEnv() });
    return { session, sourceRoot, baseline };
  } catch (error) {
    if (session) manager.destroy(session.sessionId);
    throw error;
  }
}

export function verifyManualChatFixture({ workspacePath, sourceRoot, governance, expectedBranch, gitEnv = fixtureGitEnv(workspacePath) }) {
  const status = git(["status", "--porcelain", "--untracked-files=all"], workspacePath, gitEnv).trim();
  if (status) throw new Error("manual Chat fixture worktree is not clean");
  git(["diff", "--quiet"], workspacePath, gitEnv);
  git(["diff", "--cached", "--quiet"], workspacePath, gitEnv);
  const tracked = new Set(git(["ls-files", "-z"], workspacePath, gitEnv).split("\0").filter(Boolean));
  if (!tracked.has(WORKFLOW_PROOF_FILE)) throw new Error("manual Chat fixture is missing tracked workflow-proof.txt");
  if (fs.readFileSync(path.join(workspacePath, WORKFLOW_PROOF_FILE), "utf8") !== WORKFLOW_PROOF_BASELINE) {
    throw new Error("manual Chat fixture workflow-proof.txt baseline is invalid");
  }
  assertNoForbiddenMaterial(workspacePath, tracked);
  if (git(["branch", "--show-current"], workspacePath, gitEnv).trim() !== expectedBranch) throw new Error("manual Chat fixture branch is invalid");
  if (git(["rev-parse", "--is-shallow-repository"], workspacePath, gitEnv).trim() !== "false") throw new Error("manual Chat fixture clone is shallow");
  if (fs.existsSync(path.join(workspacePath, ".git", "objects", "info", "alternates"))) throw new Error("manual Chat fixture shares Git objects");
  if (sourceRoot && sharedGitObjectInode(sourceRoot, workspacePath)) throw new Error("manual Chat fixture has hardlinked Git objects");
  if (git(["config", "--local", "--get", "core.hooksPath"], workspacePath, gitEnv).trim() !== ".githooks") throw new Error("manual Chat fixture hook path is invalid");
  for (const relative of [".githooks/pre-commit", "scripts/pre-commit-policy.mjs"]) {
    const target = path.join(workspacePath, relative);
    if (!fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error(`manual Chat fixture governance file is invalid: ${relative}`);
    if (governance?.[relative === ".githooks/pre-commit" ? "hookFile" : "policyFile"]
      && sha256(target) !== sha256(governance[relative === ".githooks/pre-commit" ? "hookFile" : "policyFile"])) {
      throw new Error(`manual Chat fixture governance file differs from review: ${relative}`);
    }
  }
  runFixtureTest(workspacePath, gitEnv);
  return {
    workflowProofTracked: true,
    trackedWorktreeClean: true,
    baselineProjectTest: "PASS",
    branch: expectedBranch,
    baseCommit: git(["rev-parse", "HEAD"], workspacePath, gitEnv).trim(),
    historyCommits: Number(git(["rev-list", "--all", "--count"], workspacePath, gitEnv).trim()),
  };
}

function createReviewedFixtureSource({ sourceRoot, repoRoot }) {
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const gitEnv = fixtureGitEnv(sourceRoot);
  writeFile(sourceRoot, ".gitignore", [".env", "db.env", "*.log", "runtime/", "backups/", ".storage/"].join("\n") + "\n");
  writeFile(sourceRoot, "README.md", "S5 reviewed manual Chat fixture\n");
  writeFile(sourceRoot, WORKFLOW_PROOF_FILE, WORKFLOW_PROOF_BASELINE);
  writeFile(sourceRoot, "package.json", JSON.stringify({
    name: "s5-manual-chat-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { test: "node --test test/fixture.test.mjs" },
  }, null, 2) + "\n");
  writeFile(sourceRoot, "test/fixture.test.mjs", [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "test('manual Chat workflow proof contract', () => {",
    `  const validStates = new Set(${JSON.stringify([WORKFLOW_PROOF_BASELINE, WORKFLOW_PROOF_POST_MUTATION])});`,
    `  const actual = fs.readFileSync(${JSON.stringify(WORKFLOW_PROOF_FILE)}, 'utf8');`,
    "  assert.equal(validStates.has(actual), true, 'workflow-proof.txt must be the clean baseline or exactly one intended appended proof line');",
    "});",
    "",
  ].join("\n"));
  copyReviewedGovernance(sourceRoot, repoRoot);
  git(["init", "-q", "-b", "main"], sourceRoot, gitEnv);
  git(["config", "core.hooksPath", "/dev/null"], sourceRoot, gitEnv);
  git(["config", "user.name", "S5 Fixture Source"], sourceRoot, gitEnv);
  git(["config", "user.email", "s5-fixture@example.invalid"], sourceRoot, gitEnv);
  git(["add", "--", ".gitignore", "README.md", WORKFLOW_PROOF_FILE, "package.json", "test/fixture.test.mjs", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs"], sourceRoot, gitEnv);
  git(["commit", "-qm", "S5 manual Chat fixture baseline"], sourceRoot, gitEnv);
  writeFile(sourceRoot, "README.md", "S5 reviewed manual Chat fixture with history\n");
  git(["add", "--", "README.md"], sourceRoot, gitEnv);
  git(["commit", "-qm", "S5 manual Chat fixture history"], sourceRoot, gitEnv);
  verifySourceClean(sourceRoot, gitEnv);
}

function copyReviewedGovernance(sourceRoot, repoRoot) {
  for (const relative of [".githooks/pre-commit", "scripts/pre-commit-policy.mjs"]) {
    const source = path.join(repoRoot, relative);
    const target = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target);
  }
  fs.chmodSync(path.join(sourceRoot, ".githooks", "pre-commit"), 0o755);
}

function verifySourceClean(sourceRoot, gitEnv) {
  if (git(["status", "--porcelain", "--untracked-files=all"], sourceRoot, gitEnv).trim()) throw new Error("reviewed manual Chat fixture source is not clean");
  if (!git(["ls-files", "--error-unmatch", WORKFLOW_PROOF_FILE], sourceRoot, gitEnv).trim()) throw new Error("reviewed manual Chat fixture source is missing workflow-proof.txt");
}

function assertNoForbiddenMaterial(workspacePath, tracked) {
  for (const relative of tracked) assertSafeRelative(relative);
  walk(workspacePath, workspacePath);
}

function walk(root, current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (current === root && entry.name === ".git") continue;
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`manual Chat fixture contains a symlink: ${path.relative(root, full)}`);
    assertSafeRelative(path.relative(root, full));
    if (entry.isDirectory()) walk(root, full);
  }
}

function assertSafeRelative(relative) {
  const parts = relative.split(path.sep).map((part) => part.toLowerCase());
  const base = parts.at(-1);
  if (parts.some((part) => FORBIDDEN_DIRECTORIES.has(part)) || FORBIDDEN_BASENAMES.has(base)
    || /^\.env(?:\.|$)/.test(base) || /\.(?:db|sqlite|sqlite3|wal|shm|dump|bak|backup|log|pem|key|p12|pfx|jks)$/.test(base)) {
    throw new Error(`manual Chat fixture contains forbidden material: ${relative}`);
  }
}

function sharedGitObjectInode(sourceRoot, workspacePath) {
  const sourceObjects = path.join(sourceRoot, ".git", "objects");
  const workspaceObjects = path.join(workspacePath, ".git", "objects");
  const sourceInodes = collectObjectInodes(sourceObjects);
  return Array.from(collectObjectInodes(workspaceObjects)).some((inode) => sourceInodes.has(inode));
}

function collectObjectInodes(root) {
  const values = new Set();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        if (stat.nlink > 1) values.add(`${stat.dev}:${stat.ino}`);
      }
    }
  };
  visit(root);
  return values;
}

function runFixtureTest(workspacePath, gitEnv) {
  const result = spawnSync("npm", ["test"], { cwd: workspacePath, env: gitEnv, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("manual Chat fixture baseline project_test failed");
}

function fixtureGitEnv(root) {
  const home = path.join(path.dirname(root), `.s5-fixture-git-home-${crypto.randomBytes(4).toString("hex")}`);
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function git(args, cwd, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout || "";
}

function writeFile(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
