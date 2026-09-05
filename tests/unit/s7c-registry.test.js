import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TaskRegistry } from "../../src/s7/registry.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7c-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(source, "README.md"), "baseline\n");
  git("add", "README.md"); git("commit", "-m", "fixture");
  const bare = path.join(root, "remote.git");
  git("clone", "--bare", source, bare); git("remote", "add", "origin", bare);
  const registry = new TaskRegistry(path.join(root, "registry"));
  return { root, source, bare, git, registry, repository: { id: 1, name: "fixture/repo", source, defaultBranch: "main" } };
}

test("separate tasks persist owned worktrees and resume by identity after registry restart", async (t) => {
  const f = fixture(t);
  const a = await f.registry.create({ repository: f.repository, objective: "first", project: "fixture" });
  const b = await f.registry.create({ repository: f.repository, objective: "second", project: "fixture" });
  assert.notEqual(a.id, b.id); assert.notEqual(a.worktree, b.worktree);
  fs.writeFileSync(path.join(a.worktree, "README.md"), "unfinished\n");
  const restarted = new TaskRegistry(f.registry.root);
  const resumed = await restarted.resume(a.id);
  assert.equal(resumed.worktree, a.worktree);
  assert.equal(fs.readFileSync(path.join(resumed.worktree, "README.md"), "utf8"), "unfinished\n");
  assert.equal(fs.readFileSync(path.join(b.worktree, "README.md"), "utf8"), "baseline\n");
  assert.equal(restarted.find({ project: "fixture" }).length, 2);
  assert.equal(resumed.lifecycle, "active");
});

test("retirement retains dirty, ignored and unpublished data and removes only clean recoverable completed work", async (t) => {
  const f = fixture(t);
  const a = await f.registry.create({ repository: f.repository, objective: "retention", project: "fixture" });
  await assert.rejects(f.registry.retire(a.id), /active|completed/);
  f.registry.update(a.id, { lifecycle: "completed", lastActivity: "2000-01-01T00:00:00.000Z" });
  fs.writeFileSync(path.join(a.worktree, "local.txt"), "unpublished\n");
  await assert.rejects(f.registry.retire(a.id), /dirty|untracked/);
  fs.unlinkSync(path.join(a.worktree, "local.txt"));
  fs.writeFileSync(path.join(a.worktree, "README.md"), "commit without publish\n");
  execFileSync("git", ["add", "README.md"], { cwd: a.worktree });
  execFileSync("git", ["commit", "-m", "unpublished"], { cwd: a.worktree });
  await assert.rejects(f.registry.retire(a.id), /recoverable/);
  execFileSync("git", ["push", "origin", `HEAD:refs/heads/${a.branch}`], { cwd: a.worktree });
  f.registry.update(a.id, { publishedRef: `refs/heads/${a.branch}` });
  assert.equal((await f.registry.retire(a.id)).lifecycle, "retired");
  assert.equal(fs.existsSync(a.worktree), false);
  assert.equal(fs.readFileSync(path.join(f.source, "README.md"), "utf8"), "baseline\n");
});

test("resume detects moved base and never silently updates task files", async (t) => {
  const f = fixture(t);
  const a = await f.registry.create({ repository: f.repository, objective: "freshness", project: "fixture" });
  fs.writeFileSync(path.join(f.source, "README.md"), "external change\n");
  f.git("commit", "-am", "external"); f.git("push", "origin", "main");
  const resumed = await f.registry.resume(a.id);
  assert.equal(resumed.lifecycle, "stale");
  assert.equal(fs.readFileSync(path.join(a.worktree, "README.md"), "utf8"), "baseline\n");
});

test("registry refuses unknown paths, corrupt state and symlink roots without recreation", async (t) => {
  const f = fixture(t);
  assert.throws(() => f.registry.get("../../source"), /identity/);
  const linked = path.join(f.root, "linked"); fs.symlinkSync(f.registry.root, linked);
  assert.throws(() => new TaskRegistry(linked), /symlink/);
  const a = await f.registry.create({ repository: f.repository, objective: "corruption", project: "fixture" });
  fs.writeFileSync(path.join(f.registry.root, "tasks", `${a.id}.json`), "corrupt");
  assert.throws(() => new TaskRegistry(f.registry.root).list(), /corrupt/);
  assert.equal(fs.existsSync(a.worktree), true);
});
