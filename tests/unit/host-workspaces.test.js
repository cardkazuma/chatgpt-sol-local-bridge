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

test("workspace index attaches an existing Git directory without creating refs or worktrees", async () => {
  const { HostWorkspaceIndex } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  try {
    const beforeWorktrees = git(["worktree", "list", "--porcelain"], fx.repo);
    const beforeBranches = git(["branch", "--format=%(refname)"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });

    const attached = index.attach({ directoryPath: fx.repo, objective: "use existing checkout", project: "fixture" });

    assert.match(attached.id, /^ws_[a-f0-9]{16}$/);
    assert.equal(attached.kind, "attached");
    assert.equal(attached.worktreePath, fs.realpathSync.native(fx.repo));
    assert.equal(attached.git.repository, true);
    assert.equal(index.status(attached.id).git.head, git(["rev-parse", "HEAD"], fx.repo));
    assert.equal(git(["worktree", "list", "--porcelain"], fx.repo), beforeWorktrees);
    assert.equal(git(["branch", "--format=%(refname)"], fx.repo), beforeBranches);
    assert.equal(fs.existsSync(fx.worktreeRoot), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace index identifies an attached Git repository before its first commit", async () => {
  const { HostWorkspaceIndex } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const unborn = path.join(fx.root, "unborn");
  fs.mkdirSync(unborn);
  git(["init", "-q", "-b", "main"], unborn);
  try {
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const attached = index.attach({ directoryPath: unborn, objective: "initialize existing repository" });
    assert.equal(attached.git.repository, true);
    assert.equal(attached.git.head, null);
    assert.equal(attached.git.branch, "main");
    assert.equal(index.status(attached.id).git.repository, true);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace index attaches an existing Git worktree in place", async () => {
  const { HostWorkspaceIndex } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const existing = path.join(fx.root, "existing-worktree");
  const head = git(["rev-parse", "HEAD"], fx.repo);
  git(["branch", "review/existing", head], fx.repo);
  git(["worktree", "add", "-q", existing, "review/existing"], fx.repo);
  try {
    const before = git(["worktree", "list", "--porcelain"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const attached = index.attachBranch({
      repositoryPath: fx.repo, branch: "review/existing", expectedHead: head, objective: "existing worktree",
    });
    assert.equal(attached.kind, "existing-branch");
    assert.equal(attached.managedWorktree, false);
    assert.equal(attached.worktreePath, fs.realpathSync.native(existing));
    assert.equal(attached.git.head, head);
    assert.equal(git(["worktree", "list", "--porcelain"], fx.repo), before);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace index checks out the same existing local branch once without creating a ref", async () => {
  const { HostWorkspaceIndex } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const head = git(["rev-parse", "HEAD"], fx.repo);
  git(["branch", "review/local", head], fx.repo);
  try {
    const beforeBranches = git(["branch", "--format=%(refname):%(objectname)"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const first = index.attachBranch({
      repositoryPath: fx.repo, branch: "review/local", expectedHead: head, objective: "existing local branch",
    });
    const afterFirst = git(["worktree", "list", "--porcelain"], fx.repo);
    const second = index.attachBranch({
      repositoryPath: fx.repo, branch: "review/local", expectedHead: head, objective: "same existing local branch",
    });
    assert.equal(first.kind, "existing-branch");
    assert.equal(first.managedWorktree, true);
    assert.equal(first.branch, "review/local");
    assert.equal(second.id, first.id);
    assert.equal(second.worktreePath, first.worktreePath);
    assert.equal(git(["worktree", "list", "--porcelain"], fx.repo), afterFirst);
    assert.equal(git(["branch", "--format=%(refname):%(objectname)"], fx.repo), beforeBranches);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace index refuses an expected-head mismatch without refs, worktrees, or metadata", async () => {
  const { HostWorkspaceIndex } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const head = git(["rev-parse", "HEAD"], fx.repo);
  git(["branch", "review/mismatch", head], fx.repo);
  try {
    const beforeWorktrees = git(["worktree", "list", "--porcelain"], fx.repo);
    const beforeBranches = git(["branch", "--format=%(refname):%(objectname)"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    assert.throws(() => index.attachBranch({
      repositoryPath: fx.repo, branch: "review/mismatch", expectedHead: "0".repeat(40), objective: "must refuse",
    }), /expected-head mismatch/);
    assert.equal(git(["worktree", "list", "--porcelain"], fx.repo), beforeWorktrees);
    assert.equal(git(["branch", "--format=%(refname):%(objectname)"], fx.repo), beforeBranches);
    assert.equal(fs.existsSync(fx.stateFile), false);
    assert.equal(fs.existsSync(fx.worktreeRoot), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace index attaches an exact remote-only branch without creating a local branch", async () => {
  const { HostWorkspaceIndex } = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const remote = path.join(fx.root, "remote.git");
  fs.mkdirSync(remote);
  git(["init", "-q", "--bare"], remote);
  git(["remote", "add", "fixture", remote], fx.repo);
  const head = git(["rev-parse", "HEAD"], fx.repo);
  git(["branch", "review/remote", head], fx.repo);
  git(["push", "-q", "fixture", "review/remote"], fx.repo);
  git(["branch", "-D", "review/remote"], fx.repo);
  try {
    const beforeBranches = git(["branch", "--format=%(refname):%(objectname)"], fx.repo);
    const index = new HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const attached = index.attachBranch({
      repositoryPath: fx.repo, branch: "review/remote", expectedHead: head, remote: "fixture", objective: "exact remote branch",
    });
    assert.equal(attached.kind, "remote-branch");
    assert.equal(attached.managedWorktree, true);
    assert.equal(attached.requestedBranch, "review/remote");
    assert.equal(attached.git.head, head);
    assert.equal(attached.git.branch, "");
    assert.equal(git(["branch", "--format=%(refname):%(objectname)"], fx.repo), beforeBranches);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace index attaches and resumes an ordinary non-Git directory", async () => {
  const mod = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const directory = path.join(fx.root, "ordinary");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "notes.txt"), "keep in place\n");
  try {
    const first = new mod.HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const attached = first.attach({ directoryPath: directory, objective: "use ordinary folder" });
    assert.equal(attached.kind, "attached");
    assert.deepEqual(attached.git, { repository: false });

    const afterRestart = new mod.HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const resumed = afterRestart.resume(attached.id);
    assert.equal(resumed.worktreePath, fs.realpathSync.native(directory));
    assert.deepEqual(resumed.git, { repository: false });
    const checkpoint = afterRestart.checkpoint(attached.id, { summary: "plain directory checkpoint" });
    assert.equal(checkpoint.checkpoint.summary, "plain directory checkpoint");
    assert.equal(checkpoint.checkpoint.head, null);
    assert.equal(fs.readFileSync(path.join(directory, "notes.txt"), "utf8"), "keep in place\n");
    assert.equal(fs.existsSync(fx.worktreeRoot), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("workspace index does not infer Git authority above an attached directory", async () => {
  const mod = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const nested = path.join(fx.repo, "nested");
  fs.mkdirSync(nested);
  try {
    const index = new mod.HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const attached = index.attach({ directoryPath: nested, objective: "bounded nested folder" });
    assert.deepEqual(attached.git, { repository: false });
    assert.equal(attached.repositoryPath, fs.realpathSync.native(nested));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("attached directories keep request-local context and serialize mutations by real path", async () => {
  const mod = await import("../../src/lib/host-workspaces.js");
  const fx = fixture();
  const directory = path.join(fx.root, "ordinary");
  fs.mkdirSync(directory);
  try {
    const index = new mod.HostWorkspaceIndex({ stateFile: fx.stateFile, worktreeRoot: fx.worktreeRoot });
    const a = index.attach({ directoryPath: directory, objective: "chat A" });
    const b = index.attach({ directoryPath: directory, objective: "chat B" });
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
    ]);
    assert.deepEqual(observed, [`a-start:${a.id}`, `a-end:${a.id}`, `b:${b.id}`]);
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
    assert.throws(() => index.attach({ directoryPath: fx.repo, objective: "must refuse" }), WorkspaceIndexCorruptError);
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
    assert.throws(() => index.attach({ directoryPath: fx.repo, objective: "must refuse" }), WorkspaceIndexCorruptError);
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
