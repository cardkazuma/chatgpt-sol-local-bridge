import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-path-test-"));
const root = path.join(base, "root");
const outside = path.join(base, "outside");
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
fs.mkdirSync(path.join(root, "app", "runtime"), { recursive: true });
fs.writeFileSync(path.join(root, ".gitignore"), "app/runtime/ignored.txt\n");
fs.writeFileSync(path.join(root, "app", "runtime", "config.mjs"), "export const source = 'tracked-runtime-config';\n");
fs.writeFileSync(path.join(root, "app", "runtime", "server.mjs"), "export const server = 'tracked-runtime-server';\n");
spawnGit(["init", "-q", "-b", "main"], root);
spawnGit(["config", "user.name", "Path Fixture"], root);
spawnGit(["config", "user.email", "path-fixture@example.invalid"], root);
spawnGit(["add", "--", ".gitignore", "app/runtime/config.mjs", "app/runtime/server.mjs"], root);
spawnGit(["commit", "--no-verify", "-qm", "tracked runtime source fixture"], root);
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.WORKSPACE_ROOTS = root;
const paths = await import("../../src/lib/paths.js");
const config = await import("../../src/lib/config.js");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("grants only explicit roots by default", () => {
  assert.deepEqual(config.configuredWorkspaceRoots(), [path.resolve(root)]);
  assert.equal(config.workspaceRoots().includes(config.SCRATCH_DIR), true);
});

test("uses path-relative containment instead of vulnerable string prefixes", () => {
  assert.equal(paths.isWithin(path.join(root, "file"), root), true);
  assert.equal(paths.isWithin(`${root}-collision/file`, root), false);
});

test("accepts workspace paths and rejects paths outside configured roots", () => {
  assert.equal(paths.assertInRegisteredRoots(root), fs.realpathSync(root));
  assert.throws(() => paths.assertInRegisteredRoots(outside), /outside configured workspace roots/);
});

test("resolves symlinks before enforcing workspace authority", { skip: process.platform === "win32" && !canSymlink() }, () => {
  const link = path.join(root, "escape");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => paths.assertInWorkspace(path.join(link, "secret.txt")), /outside registered workspace roots/);
  assert.throws(() => paths.assertInWorkspace(path.join(link, "new.txt"), { write: true }), /outside registered workspace roots/);
  const dangling = path.join(root, "dangling");
  fs.symlinkSync(path.join(outside, "not-created.txt"), dangling, "file");
  assert.throws(() => paths.assertInWorkspace(dangling, { write: true }), /dangling symlink/);
});

test("structured paths deny secret-sensitive filenames and ignored repository files", () => {
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=not-for-tools\n");
  fs.writeFileSync(path.join(root, "application.log"), "credential-bearing log\n");
  assert.throws(() => paths.assertStructuredPath(path.join(root, ".env")), /secret-sensitive/);
  assert.throws(() => paths.assertStructuredPath(path.join(root, "application.log")), /secret-sensitive/);

  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
  spawnGit(["init", "-q"], root);
  assert.throws(() => paths.assertStructuredPath(path.join(root, "ignored.txt")), /repository-ignored/);
});

test("structured paths expose only tracked regular source beneath a runtime directory", () => {
  const runtime = path.join(root, "app", "runtime");
  const config = path.join(runtime, "config.mjs");
  const server = path.join(runtime, "server.mjs");
  assert.equal(paths.assertStructuredPath(config), fs.realpathSync(config));
  assert.equal(paths.assertStructuredPath(server), fs.realpathSync(server));
  assert.equal(paths.assertStructuredPath(config, { write: true }), fs.realpathSync(config));

  const denied = {
    ".env": "synthetic env fixture\n",
    "db.env": "synthetic db env fixture\n",
    "id_ed25519": "synthetic private key fixture\n",
    "cache.sqlite": "synthetic database fixture\n",
    "service.log": "synthetic log fixture\n",
    "snapshot.backup": "synthetic backup fixture\n",
  };
  for (const [name, content] of Object.entries(denied)) {
    fs.writeFileSync(path.join(runtime, name), content);
    assert.throws(() => paths.assertStructuredPath(path.join(runtime, name)), /secret-sensitive|runtime source/);
  }

  fs.writeFileSync(path.join(runtime, "ignored.txt"), "ignored runtime fixture\n");
  assert.throws(() => paths.assertStructuredPath(path.join(runtime, "ignored.txt")), /repository-ignored|runtime source/);
  fs.writeFileSync(path.join(runtime, "untracked.txt"), "untracked runtime fixture\n");
  assert.throws(() => paths.assertStructuredPath(path.join(runtime, "untracked.txt")), /tracked regular source/);

  if (process.platform !== "win32") {
    const link = path.join(runtime, "linked-source.mjs");
    fs.symlinkSync(config, link);
    assert.throws(() => paths.assertStructuredPath(link), /symlink/);
  }

  const tree = paths.walkTree(root, { maxDepth: 4 });
  const visible = tree.entries.map((entry) => entry.path.split(path.sep).join("/"));
  assert.equal(visible.includes("app/runtime/config.mjs"), true);
  assert.equal(visible.includes("app/runtime/server.mjs"), true);
  assert.equal(visible.some((entry) => /(?:\.env|db\.env|id_ed25519|\.sqlite|\.log|\.backup|ignored\.txt|untracked\.txt|linked-source)/.test(entry)), false);

  const searchable = paths.visibleFilePaths(root).map((entry) => path.relative(fs.realpathSync(root), entry).split(path.sep).join("/"));
  assert.equal(searchable.includes("app/runtime/config.mjs"), true, searchable.join(", "));
  assert.equal(searchable.includes("app/runtime/server.mjs"), true, searchable.join(", "));
  assert.equal(searchable.includes("app/runtime/untracked.txt"), false);
});

function spawnGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function canSymlink() {
  try {
    const from = path.join(base, "symlink-probe-target");
    const to = path.join(base, "symlink-probe");
    fs.mkdirSync(from);
    fs.symlinkSync(from, to, "junction");
    fs.rmSync(to, { recursive: true, force: true });
    return true;
  } catch { return false; }
}
