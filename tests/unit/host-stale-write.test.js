import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "host-stale-write-"));
const repo = path.join(base, "repo");
fs.mkdirSync(repo);
for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"]]) {
  assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
}
fs.writeFileSync(path.join(repo, "tracked.txt"), "one\n");
spawnSync("git", ["add", "tracked.txt"], { cwd: repo });
spawnSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
process.env.BRIDGE_PROFILE = "host";
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.HOST_WORKTREE_ROOT = path.join(base, "worktrees");
process.env.INCLUDE_SCRATCH_ROOT = "false";

const { hostWorkspaceIndex } = await import("../../src/lib/tool-registry.js");
const { registerFiles } = await import("../../src/tools/files.js");
const workspace = hostWorkspaceIndex.create({ repositoryPath: repo, branch: "daily/stale", objective: "stale write fixture" });
const handlers = new Map();
const schemas = new Map();
registerFiles({ registerTool(name, definition, handler) { handlers.set(name, handler); schemas.set(name, definition.inputSchema); } });

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("host writes require workspace ID and preserve competing bytes after a stale read", async () => {
  assert.ok(schemas.get("edit_file").workspaceId);
  const target = path.join(workspace.worktreePath, "tracked.txt");
  const read = await handlers.get("read_file")({ workspaceId: workspace.id, path: target });
  assert.equal(read.isError, undefined, read.content?.[0]?.text);
  fs.writeFileSync(target, "competing\n");
  const edit = await handlers.get("edit_file")({ workspaceId: workspace.id, path: target, oldText: "competing", newText: "lost" });
  assert.equal(edit.isError, true);
  assert.match(edit.content[0].text, /STALE|REFRESH/);
  assert.equal(fs.readFileSync(target, "utf8"), "competing\n");
});
