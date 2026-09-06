import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-workspace-index-"));
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "Workspace Fixture"], repo);
  git(["config", "user.email", "workspace@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "baseline\n");
  git(["add", "README.md"], repo);
  git(["commit", "-qm", "baseline"], repo);
  return { root, repo, stateFile: path.join(root, "state", "workspaces.json"), worktreeRoot: path.join(root, "worktrees") };
}

test("workspace index creates an owned worktree and resumes dirty work after restart", async () => {
  const mod = await import("../../src/lib/host-workspaces.js");
  assert.equal(typeof mod.HostWorkspaceIndex, "function");
  const fx = fixture();
  try {
    const first = new mod.HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const created = first.create({ repositoryPath: fx.repo, branch: "daily/fixture", objective: "prove resume", project: "fixture" });
    assert.match(created.id, /^ws_[a-z0-9]+$/);
    assert.equal(created.branch, "daily/fixture");
    fs.writeFileSync(path.join(created.worktreePath, "dirty.txt"), "keep me\n");

    const afterRestart = new mod.HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const resumed = afterRestart.resume(created.id);
    assert.equal(resumed.id, created.id);
    assert.equal(resumed.git.dirty, true);
    assert.equal(fs.readFileSync(path.join(created.worktreePath, "dirty.txt"), "utf8"), "keep me\n");
    assert.equal(afterRestart.checkpoint(created.id, { summary: "tests pending", pr: 42 }).checkpoint.summary, "tests pending");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("corrupt workspace metadata preserves bytes and offers read-only recovery", async () => {
  const { HostWorkspaceIndex, WorkspaceIndexCorruptError } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  try {
    fs.mkdirSync(path.dirname(fx.stateFile), { recursive: true });
    fs.mkdirSync(fx.worktreeRoot, { recursive: true });
    const candidate = path.join(fx.worktreeRoot, "candidate");
    git(["worktree", "add", "-q", "-b", "daily/recover", candidate, "main"], fx.repo);
    fs.writeFileSync(fx.stateFile, "{broken", { mode: 0o600 });
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    assert.throws(() => index.list(), WorkspaceIndexCorruptError);
    assert.equal(fs.readFileSync(fx.stateFile, "utf8"), "{broken");
    const recovered = index.recoverCandidates();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].worktreePath, candidate);
    assert.equal(fs.readFileSync(fx.stateFile, "utf8"), "{broken");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("missing workspace metadata with recoverable work requires recovery and refuses create without Git side effects", async () => {
  const { HostWorkspaceIndex, WorkspaceIndexCorruptError } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  try {
    fs.mkdirSync(fx.worktreeRoot, { recursive: true });
    const candidate = path.join(fx.worktreeRoot, "candidate");
    git(["worktree", "add", "-q", "-b", "daily/recover-missing", candidate, "main"], fx.repo);
    fs.writeFileSync(path.join(candidate, "dirty.txt"), "preserve me\n");
    const beforeWorktrees = git(["worktree", "list", "--porcelain"], fx.repo);
    const beforeBranches = git(["branch", "--format=%(refname)"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });

    assert.throws(() => index.list(), WorkspaceIndexCorruptError);
    assert.throws(() => index.create({ repositoryPath: fx.repo, branch: "daily/refused-missing", objective: "must refuse" }), WorkspaceIndexCorruptError);
    assert.equal(fs.existsSync(fx.stateFile), false);
    assert.equal(git(["worktree", "list", "--porcelain"], fx.repo), beforeWorktrees);
    assert.equal(git(["branch", "--format=%(refname)"], fx.repo), beforeBranches);
    assert.equal(fs.readFileSync(path.join(candidate, "dirty.txt"), "utf8"), "preserve me\n");
    assert.equal(index.recoverCandidates().length, 1);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("corrupt workspace metadata refuses create before adding a branch or worktree", async () => {
  const { HostWorkspaceIndex, WorkspaceIndexCorruptError } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  try {
    fs.mkdirSync(path.dirname(fx.stateFile), { recursive: true });
    fs.writeFileSync(fx.stateFile, "{damaged", { mode: 0o600 });
    const beforeWorktrees = git(["worktree", "list", "--porcelain"], fx.repo);
    const beforeBranches = git(["branch", "--format=%(refname)"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });

    assert.throws(() => index.create({ repositoryPath: fx.repo, branch: "daily/refused-corrupt", objective: "must refuse" }), WorkspaceIndexCorruptError);
    assert.equal(fs.readFileSync(fx.stateFile, "utf8"), "{damaged");
    assert.equal(git(["worktree", "list", "--porcelain"], fx.repo), beforeWorktrees);
    assert.equal(git(["branch", "--format=%(refname)"], fx.repo), beforeBranches);
    assert.equal(fs.existsSync(fx.worktreeRoot), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("invalid workspace create input is rejected before adding a branch or worktree", async () => {
  const { HostWorkspaceIndex } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  try {
    const beforeWorktrees = git(["worktree", "list", "--porcelain"], fx.repo);
    const beforeBranches = git(["branch", "--format=%(refname)"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });

    assert.throws(() => index.create({ repositoryPath: fx.repo, branch: "daily/refused-input", objective: "" }), /workspace text field is invalid/);
    assert.equal(fs.existsSync(fx.stateFile), false);
    assert.equal(fs.existsSync(fx.worktreeRoot), false);
    assert.equal(git(["worktree", "list", "--porcelain"], fx.repo), beforeWorktrees);
    assert.equal(git(["branch", "--format=%(refname)"], fx.repo), beforeBranches);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace context cannot be redirected by an interleaved chat and serializes same-worktree mutations", async () => {
  const mod = await import("../../src/lib/host-workspaces.js");
  assert.equal(typeof mod.withHostWorkspace, "function");
  const fx = fixture();
  try {
    const index = new mod.HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const a = index.create({ repositoryPath: fx.repo, branch: "daily/a", objective: "A" });
    const b = index.create({ repositoryPath: fx.repo, branch: "daily/b", objective: "B" });
    const observed = [];
    await Promise.all([
      mod.withHostWorkspace(index, a.id, { mutating: true }, async () => {
        observed.push(`a-start:${mod.activeHostWorkspace().id}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        observed.push(`a-end:${mod.activeHostWorkspace().id}`);
      }),
      mod.withHostWorkspace(index, b.id, { mutating: true }, async () => {
        observed.push(`b:${mod.activeHostWorkspace().id}`);
      }),
      mod.withHostWorkspace(index, a.id, { mutating: true }, async () => {
        observed.push(`a-second:${mod.activeHostWorkspace().id}`);
      }),
    ]);
    assert.equal(observed.indexOf(`a-second:${a.id}`) > observed.indexOf(`a-end:${a.id}`), true);
    assert.equal(observed.every((entry) => !entry.startsWith("a-") || entry.endsWith(a.id)), true);
    assert.equal(observed.find((entry) => entry.startsWith("b:")), `b:${b.id}`);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
