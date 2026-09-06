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
fs.mkdirSync(source);
const git = (args, cwd = source) => spawnSync("git", args, { cwd, encoding: "utf8" });
assert.equal(git(["init", "-q", "-b", "main"]).status, 0);
git(["config", "user.name", "Host Integration"]); git(["config", "user.email", "host@example.invalid"]);
fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('host-test-pass')\"" } }));
fs.writeFileSync(path.join(source, "README.md"), "baseline\n");
fs.mkdirSync(path.join(source, ".githooks"));
fs.writeFileSync(path.join(source, ".githooks", "pre-commit"), "#!/bin/sh\nprintf hook-pass\n", { mode: 0o700 });
git(["config", "core.hooksPath", ".githooks"]); git(["add", "."]); git(["commit", "-qm", "baseline"]);
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
  const created = JSON.parse(value(await call("workspace_create", { repositoryPath: source, branch: "daily/integration", objective: "host integration" })));
  const id = created.id;
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

test.after(async () => {
  await client?.close().catch(() => {}); await runtime?.shutdown("test");
  fs.rmSync(base, { recursive: true, force: true });
});
