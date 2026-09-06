import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "host-profile-integration-"));
const source = path.join(base, "source");
const ordinary = path.join(base, "ordinary");
fs.mkdirSync(source);
fs.mkdirSync(ordinary);
const git = (args, cwd = source) => spawnSync("git", args, { cwd, encoding: "utf8" });
const gitText = (args, cwd = source) => {
  const result = git(args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
assert.equal(git(["init", "-q", "-b", "main"]).status, 0);
git(["config", "user.name", "Host Integration"]); git(["config", "user.email", "host@example.invalid"]);
fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('host-test-pass')\"" } }));
fs.writeFileSync(path.join(source, "README.md"), "baseline\n");
fs.writeFileSync(path.join(ordinary, "README.md"), "ordinary folder\n");
fs.writeFileSync(path.join(ordinary, "notes.txt"), "searchable attachment\n");
fs.mkdirSync(path.join(source, ".githooks"));
fs.writeFileSync(path.join(source, ".githooks", "pre-commit"), "#!/bin/sh\nprintf hook-pass\n", { mode: 0o700 });
git(["config", "core.hooksPath", ".githooks"]); git(["add", "."]); git(["commit", "-qm", "baseline"]);
const existingBranch = "reviewed/existing";
const existingWorktree = path.join(base, "existing-worktree");
assert.equal(git(["worktree", "add", "-q", "-b", existingBranch, existingWorktree]).status, 0);
process.env.BRIDGE_PROFILE = "host";
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.HOST_WORKTREE_ROOT = path.join(base, "worktrees");
process.env.INCLUDE_SCRATCH_ROOT = "false";
process.env.MCP_TOKEN = "host-integration-token";
process.env.HOST = "127.0.0.1";
const { startHttpServer } = await import("../../src/server.js");

let runtime;
let client;
async function connect() {
  runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
  if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
  client = new Client({ name: "host-integration", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.httpServer.address().port}/mcp`), { requestInit: { headers: { Authorization: "Bearer host-integration-token" } } }));
}
async function call(name, args) { return client.callTool({ name, arguments: args }); }
function value(result) { assert.equal(result.isError, undefined, result.content?.[0]?.text); return result.content[0].text; }

test("native host profile completes and resumes an isolated developer workflow", async () => {
  await connect();
  const tools = await client.listTools();
  assert.equal(tools.tools.some(({ name }) => name === "git_publish_branch"), false);
  const contextFree = new Set([
    "bridge_instructions", "workspace_list", "workspace_create", "workspace_attach", "workspace_resume",
    "workspace_status", "workspace_checkpoint", "workspace_recover", "health",
  ]);
  for (const tool of tools.tools) {
    if (!contextFree.has(tool.name)) {
      assert.ok(tool.inputSchema?.properties?.workspaceId, `${tool.name} must require explicit workspaceId`);
    }
  }
  const created = JSON.parse(value(await call("workspace_create", { repositoryPath: source, branch: "daily/integration", objective: "host integration" })));
  const id = created.id;
  const listed = value(await call("workspace_list", {}));
  assert.equal(JSON.parse(listed).catalog, "daily-use-v2");
  assert.doesNotMatch(listed, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(listed, /repositoryPath|worktreePath/);
  value(await call("read_file", { workspaceId: id, path: path.join(created.worktreePath, "README.md") }));
  value(await call("write_file", { workspaceId: id, path: path.join(created.worktreePath, "daily.txt"), content: "daily\n" }));
  assert.match(value(await call("project_test", { workspaceId: id })), /host-test-pass/);
  assert.match(value(await call("repo_shell", { workspaceId: id, command: "node --version" })), /v\d+/);
  value(await call("git_stage", { workspaceId: id, paths: ["daily.txt"] }));
  assert.match(value(await call("git_commit", { workspaceId: id, message: "daily host fixture" })), /hook-pass/);
  const process = JSON.parse(value(await call("process_start", { workspaceId: id, command: "node -e \"setTimeout(()=>console.log('process-finished'),50)\"" })));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(value(await call("process_logs", { workspaceId: id, id: process.id, lines: 20 })), /process-finished/);
  value(await call("workspace_checkpoint", { workspaceId: id, summary: "integration checkpoint", processIds: [process.id] }));
  await client.close(); await runtime.shutdown("restart-fixture");
  await connect();
  const resumed = JSON.parse(value(await call("workspace_resume", { workspaceId: id })));
  assert.equal(resumed.id, id);
  assert.equal(resumed.checkpoint.summary, "integration checkpoint");
  assert.equal(fs.existsSync(path.join(created.worktreePath, "daily.txt")), true);
});

test("native host profile attaches existing Git and non-Git directories in place", async () => {
  const tools = await client.listTools();
  assert.equal(tools.tools.some(({ name }) => name === "workspace_attach"), true);
  const beforeWorktrees = gitText(["worktree", "list", "--porcelain"]);
  const beforeBranches = gitText(["branch", "--format=%(refname)"]);

  const attachedGit = JSON.parse(value(await call("workspace_attach", { path: source, objective: "existing Git checkout" })));
  const attachedPlain = JSON.parse(value(await call("workspace_attach", { path: ordinary, objective: "existing ordinary folder" })));
  assert.equal(attachedGit.kind, "attached");
  assert.equal(attachedGit.worktreePath, fs.realpathSync.native(source));
  assert.equal(attachedPlain.kind, "attached");
  assert.deepEqual(attachedPlain.git, { repository: false });
  assert.equal(gitText(["worktree", "list", "--porcelain"]), beforeWorktrees);
  assert.equal(gitText(["branch", "--format=%(refname)"]), beforeBranches);
  const listed = value(await call("workspace_list", {}));
  assert.doesNotMatch(listed, new RegExp(ordinary));

  const relative = await call("workspace_attach", { path: "ordinary", objective: "ambiguous relative path" });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute or start with ~/);
  const protectedPath = await call("workspace_attach", { path: "/etc", objective: "protected path" });
  assert.equal(protectedPath.isError, true);
  assert.match(protectedPath.content[0].text, /protected path/);

  const [gitRead, plainRead] = await Promise.all([
    call("read_file", { workspaceId: attachedGit.id, path: "README.md" }),
    call("read_file", { workspaceId: attachedPlain.id, path: "README.md" }),
  ]);
  assert.match(value(gitRead), /baseline/);
  assert.match(value(plainRead), /ordinary folder/);
  assert.match(value(await call("search_text", { workspaceId: attachedPlain.id, pattern: "searchable" })), /notes\.txt/);
  assert.match(value(await call("workspace_tree", { workspaceId: attachedPlain.id })), /README\.md/);
  const plainSnapshot = JSON.parse(value(await call("workspace_snapshot", { workspaceId: attachedPlain.id })));
  assert.deepEqual(plainSnapshot.git, { repository: false });
  const plainGit = await call("git_status", { workspaceId: attachedPlain.id });
  assert.equal(plainGit.isError, true);
  assert.match(plainGit.content[0].text, /not (?:inside )?a git repository/i);
  value(await call("read_file", { workspaceId: attachedPlain.id, path: "notes.txt" }));
  fs.writeFileSync(path.join(ordinary, "notes.txt"), "competing attachment edit\n");
  const stale = await call("edit_file", {
    workspaceId: attachedPlain.id, path: "notes.txt", oldText: "competing", newText: "lost",
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STALE_OBSERVATION/);
  assert.equal(fs.readFileSync(path.join(ordinary, "notes.txt"), "utf8"), "competing attachment edit\n");
  value(await call("read_file", { workspaceId: attachedPlain.id, path: "notes.txt" }));
  value(await call("edit_file", {
    workspaceId: attachedPlain.id, path: "notes.txt", oldText: "competing", newText: "reviewed",
  }));
  assert.equal(fs.readFileSync(path.join(ordinary, "notes.txt"), "utf8"), "reviewed attachment edit\n");
  value(await call("read_file", { workspaceId: attachedPlain.id, path: "notes.txt" }));
  value(await call("apply_patch", {
    workspaceId: attachedPlain.id,
    diff: "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-reviewed attachment edit\n+patched attachment edit\n",
  }));
  assert.equal(fs.readFileSync(path.join(ordinary, "notes.txt"), "utf8"), "patched attachment edit\n");
  assert.match(value(await call("repo_shell", { workspaceId: attachedPlain.id, command: "pwd" })), new RegExp(ordinary));
  assert.match(value(await call("project_lint", {
    workspaceId: attachedPlain.id, command: "node -e \"console.log('plain-lint-pass')\"",
  })), /plain-lint-pass/);
  assert.match(value(await call("git_status", { workspaceId: attachedGit.id })), /main/);
  assert.match(value(await call("project_test", { workspaceId: attachedGit.id })), /host-test-pass/);

  const process = JSON.parse(value(await call("process_start", {
    workspaceId: attachedPlain.id,
    command: "node -e \"setTimeout(()=>console.log('attached-process-finished'),50)\"",
  })));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(value(await call("process_logs", { workspaceId: attachedPlain.id, id: process.id, lines: 20 })), /attached-process-finished/);
  assert.match(value(await call("process_list", { workspaceId: attachedPlain.id })), new RegExp(process.id));
  const stoppable = JSON.parse(value(await call("process_start", {
    workspaceId: attachedPlain.id, command: "node -e \"setTimeout(()=>{},10000)\"",
  })));
  value(await call("process_stop", { workspaceId: attachedPlain.id, id: stoppable.id }));
  value(await call("write_file", { workspaceId: attachedPlain.id, path: "created-in-place.txt", content: "in place\n" }));
  assert.equal(fs.readFileSync(path.join(ordinary, "created-in-place.txt"), "utf8"), "in place\n");
});

test("native host profile attaches an exact existing branch without duplicating it", async () => {
  const branch = existingBranch;
  const expectedHead = gitText(["rev-parse", branch]);
  const beforeWorktrees = gitText(["worktree", "list", "--porcelain"]);
  const beforeBranches = gitText(["branch", "--format=%(refname)"]);

  const first = JSON.parse(value(await call("workspace_attach", {
    repositoryPath: source, branch, expectedHead, objective: "resume reviewed branch",
  })));
  const second = JSON.parse(value(await call("workspace_attach", {
    repositoryPath: source, branch, expectedHead, objective: "resume reviewed branch again",
  })));
  assert.equal(first.id, second.id);
  assert.equal(first.kind, "existing-branch");
  assert.equal(first.git.head, expectedHead);
  assert.equal(gitText(["worktree", "list", "--porcelain"]), beforeWorktrees);
  assert.equal(gitText(["branch", "--format=%(refname)"]), beforeBranches);
  assert.match(value(await call("git_status", { workspaceId: first.id })), new RegExp(branch));

  const mismatch = await call("workspace_attach", {
    repositoryPath: source, branch, expectedHead: "0".repeat(40), objective: "must fail closed",
  });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /expected[- ]head mismatch/i);
  assert.equal(gitText(["worktree", "list", "--porcelain"]), beforeWorktrees);
  assert.equal(gitText(["branch", "--format=%(refname)"]), beforeBranches);
});

test.after(async () => {
  await client?.close().catch(() => {}); await runtime?.shutdown("test");
  fs.rmSync(base, { recursive: true, force: true });
});
