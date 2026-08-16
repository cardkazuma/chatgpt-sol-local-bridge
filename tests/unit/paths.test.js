import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.homedir(), ".sol-path-test-"));
const root = path.join(base, "root");
const outside = path.join(base, "outside");
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.WORKSPACE_ROOTS = root;
const paths = await import("../../src/lib/paths.js");
const config = await import("../../src/lib/config.js");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("grants only explicit roots by default", () => {
  assert.deepEqual(config.configuredWorkspaceRoots(), [fs.realpathSync(root)]);
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
