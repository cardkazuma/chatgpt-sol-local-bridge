import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-integration-test-"));
const root = path.join(base, "workspace");
const outside = path.join(base, "outside");
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret\n");
fs.writeFileSync(path.join(root, ".gitignore"), ".env\n*.log\nignored.txt\nbackups/\n");
fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
fs.writeFileSync(path.join(root, ".env"), "TOKEN=disposable\n");
fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
fs.writeFileSync(path.join(root, "fixture.log"), "credential-bearing disposable log\n");
fs.mkdirSync(path.join(root, "backups"));
fs.writeFileSync(path.join(root, "backups", "secret.txt"), "backup-secret\n");
fs.mkdirSync(path.join(root, "app", "runtime"), { recursive: true });
fs.writeFileSync(path.join(root, "app", "runtime", "config.mjs"), "export const marker = 'TRACKED_RUNTIME_CONFIG';\n");
fs.writeFileSync(path.join(root, "app", "runtime", "server.mjs"), "export const marker = 'TRACKED_RUNTIME_SERVER';\n");
fs.writeFileSync(path.join(root, "app", "runtime", "untracked.txt"), "UNTRACKED_RUNTIME_MATERIAL\n");
spawnGit(["init", "-q", "-b", "main"], root);
spawnGit(["config", "user.name", "Integration Fixture"], root);
spawnGit(["config", "user.email", "integration-fixture@example.invalid"], root);
spawnGit(["add", "--", ".gitignore", "README.md", "app/runtime/config.mjs", "app/runtime/server.mjs"], root);
spawnGit(["commit", "--no-verify", "-qm", "tracked runtime source fixture"], root);
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.BRIDGE_SCRATCH_DIR = path.join(base, "scratch");
process.env.INCLUDE_SCRATCH_ROOT = "false";
process.env.WORKSPACE_ROOTS = root;
process.env.MCP_TOKEN = "integration-secret";
process.env.DESTRUCTIVE_APPROVAL_MODE = "deny";
process.env.HOST = "127.0.0.1";
const { createApp, startHttpServer } = await import("../../src/server.js");
const { EXPECTED_TOOL_NAMES } = await import("../../src/tool-contract.js");

const runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
const port = runtime.httpServer.address().port;
const url = `http://127.0.0.1:${port}/mcp`;
const unixSocketPath = path.join(base, "transport", "mcp.sock");
const unixRuntime = startHttpServer({ unixSocketPath });
if (!unixRuntime.httpServer.listening) await once(unixRuntime.httpServer, "listening");
const client = new Client({ name: "integration-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: "Bearer integration-secret" } },
});
await client.connect(transport);

test.after(async () => {
  await client.close().catch(() => {});
  await runtime.shutdown("test");
  await unixRuntime.shutdown("test");
  fs.rmSync(base, { recursive: true, force: true });
});

test("programmatic non-loopback host overrides still enforce bind policy", () => {
  assert.throws(() => createApp({ host: "0.0.0.0" }), /loopback-only/);
});

test("HTTP endpoint enforces bearer authentication", async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 401);
});

test("Unix socket endpoint enforces the same explicit bearer authentication", async () => {
  const denied = await requestUnix({
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(denied.status, 401);

  const allowed = await requestUnix({
    authorization: "Bearer integration-secret",
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "unix-integration-test", version: "1.0.0" },
      },
    },
  });
  assert.equal(allowed.status, 200);
  assert.match(allowed.body, /serverInfo|protocolVersion/);
});

test("MCP discovery exposes exactly the reviewed 28-tool bridge catalog", async () => {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...EXPECTED_TOOL_NAMES]);
  assert.equal(tools.tools.every((tool) => tool.inputSchema?.type === "object"), true);
  for (const disabled of ["shell", "git_run", "git_push", "git_fetch", "codex_run", "workspace_add_root", "confirm_destructive", "web_fetch", "office", "system_info", "dom_cdp"]) {
    assert.equal(names.includes(disabled), false, `${disabled} must not be discoverable`);
  }
});

test("the only remote-write catalog entry is the controller-derived S6 publisher", async () => {
  const tools = await client.listTools();
  const publish = tools.tools.find((tool) => tool.name === "git_publish_branch");
  assert.ok(publish);
  assert.deepEqual(publish.inputSchema?.properties || {}, {});
  assert.equal(publish.inputSchema?.additionalProperties ?? false, false);
  assertError(await call("git_publish_branch", { branch: "main", force: true, refspec: "*" }), /no caller-supplied authority|S6|Unrecognized keys/);
  assertError(await call("git_publish_branch", {}), /active S6 session/);
});

test("disabled tools are not invocable through the MCP server", async () => {
  try {
    const result = await call("shell", { command: "printf should-not-run" });
    assert.equal(result.isError, true);
  } catch (error) {
    assert.match(String(error.message), /not found|unknown tool|invalid/i);
  }
});

test("workspace/file/search/patch tools round-trip inside configured authority", async () => {
  assertOk(await call("workspace_open", { path: root }));
  assertOk(await call("write_file", { path: path.join(root, "hello.txt"), content: "hello\n" }));
  assert.match(assertOk(await call("read_file", { path: path.join(root, "hello.txt") })), /hello/);
  assertOk(await call("write_file", { path: path.join(root, "hello.txt"), content: "overwritten\n" }));
  assert.match(assertOk(await call("read_file", { path: path.join(root, "hello.txt") })), /overwritten/);
  assertOk(await call("edit_file", { path: path.join(root, "hello.txt"), oldText: "overwritten", newText: "world" }));

  spawnGit(["init", "-q", "-b", "main"], root);
  const patch = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-world\n+patched\n";
  assertOk(await call("apply_patch", { cwd: root, diff: patch }));
  assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "patched\n");
  assert.match(assertOk(await call("search_text", { path: root, pattern: "patched" })), /patched/);
});

test("workspace views and structured file access omit ignored/secret-sensitive paths", async () => {
  const directory = JSON.parse(assertOk(await call("read_file", { path: root })));
  assert.equal(directory.entries.some((entry) => [".env", "fixture.log", "ignored.txt", "backups"].includes(entry.name)), false);
  for (const target of [
    ".env", "db.env", "secrets.yaml", ".storage", "fixture.log", "backups/secret.txt", "ignored.txt",
  ]) assertError(await call("read_file", { path: path.join(root, target) }), /secret-sensitive|repository-ignored/);

  const tree = assertOk(await call("workspace_tree", { path: root, maxDepth: 4 }));
  assert.doesNotMatch(tree, /\.env|fixture\.log|ignored\.txt|backups/);
  const snapshot = assertOk(await call("workspace_snapshot", {}));
  assert.doesNotMatch(snapshot, /\.env|fixture\.log|ignored\.txt|backups/);
  const search = assertOk(await call("search_text", { path: root, pattern: "disposable" }));
  assert.doesNotMatch(search, /fixture\.log|\.env|backup/);
});

test("structured read, write, tree, and search expose tracked runtime source but not untracked runtime material", async () => {
  const runtimeRoot = path.join(root, "app", "runtime");
  const config = path.join(runtimeRoot, "config.mjs");
  const server = path.join(runtimeRoot, "server.mjs");
  assert.match(assertOk(await call("read_file", { path: config })), /TRACKED_RUNTIME_CONFIG/);
  assert.match(assertOk(await call("read_file", { path: server })), /TRACKED_RUNTIME_SERVER/);
  assertOk(await call("write_file", { path: config, content: "export const marker = 'TRACKED_RUNTIME_CONFIG';\n" }));
  assertError(await call("read_file", { path: path.join(runtimeRoot, "untracked.txt") }), /tracked regular source/);

  const tree = assertOk(await call("workspace_tree", { path: root, maxDepth: 4 }));
  assert.match(tree, /app[\\/]runtime[\\/]config\.mjs/);
  assert.match(tree, /app[\\/]runtime[\\/]server\.mjs/);
  assert.doesNotMatch(tree, /untracked\.txt/);

  const search = assertOk(await call("search_text", { path: root, pattern: "TRACKED_RUNTIME_" }));
  assert.match(search, /config\.mjs/);
  assert.match(search, /server\.mjs/);
  assert.doesNotMatch(search, /untracked\.txt/);
});

test("outside paths and symlink escapes are rejected by structured tools", async () => {
  assertError(await call("read_file", { path: path.join(outside, "secret.txt") }), /outside registered workspace roots/);
  assertError(await call("write_file", { path: path.join(outside, "new.txt"), content: "must-not-write" }), /outside registered workspace roots/);
  assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
  if (process.platform !== "win32") {
    const link = path.join(root, "escape");
    fs.symlinkSync(path.join(outside, "secret.txt"), link);
    assertError(await call("read_file", { path: link }), /outside registered workspace roots/);
    assertError(await call("write_file", { path: link, content: "must-not-write" }), /outside registered workspace roots/);
  }
  assertError(await call("read_file", { path: path.join(root, ".git", "config") }), /secret-sensitive|protected/);
});

test("non-empty overwrite works while empty overwrite remains deny-mode blocked", async () => {
  const target = path.join(root, "nonempty.txt");
  fs.writeFileSync(target, "keep-me\n");
  assertOk(await call("write_file", { path: target, content: "replace-me\n" }));
  assert.equal(fs.readFileSync(target, "utf8"), "replace-me\n");
  const blocked = assertError(await call("write_file", { path: target, content: "" }), /DELETE BLOCKED|truncate/);
  assert.match(blocked, /destructive execution is disabled|Token:/);
  assert.equal(fs.readFileSync(target, "utf8"), "replace-me\n");
  assertError(await call("apply_patch", {
    cwd: root,
    diff: "diff --git a/nonempty.txt b/nonempty.txt\ndeleted file mode 100644\n--- a/nonempty.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-replace-me\n",
  }), /DELETE BLOCKED/);
});

test("structured Git writes use local branches, selected staging, and the reviewed hook", async () => {
  installReviewedHook(root);
  spawnGit(["config", "user.name", "S1 Fixture"], root);
  spawnGit(["config", "user.email", "s1-fixture@example.invalid"], root);
  spawnGit(["config", "core.hooksPath", ".githooks"], root);
  spawnGit(["add", ".gitignore", "README.md", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs", "hello.txt"], root);
  spawnGit(["commit", "-qm", "fixture baseline"], root);

  assertOk(await call("git_branch_create", { cwd: root, name: "s1/isolated" }));
  assertOk(await call("git_branch_switch", { cwd: root, name: "s1/isolated" }));
  assertOk(await call("write_file", { path: path.join(root, "commit.txt"), content: "committed\n" }));
  assertOk(await call("git_stage", { cwd: root, paths: ["commit.txt"] }));
  const commit = assertOk(await call("git_commit", { cwd: root, message: "S1 fixture commit" }));
  assert.match(commit, /S1 pre-commit policy passed/);

  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "project-resolver.json"), "{\"state\":\"baseline\"}\n");
  fs.appendFileSync(path.join(root, ".gitignore"), "/*/*\n");
  spawnGit(["add", "--", ".gitignore"], root);
  spawnGit(["add", "-f", "--", "docs/project-resolver.json"], root);
  spawnGit(["commit", "--no-verify", "-qm", "tracked ignored fixture baseline"], root);
  fs.writeFileSync(path.join(root, "docs", "project-resolver.json"), "{\"state\":\"modified\"}\n");
  spawnGit(["add", "--", "docs/project-resolver.json"], root);
  const trackedIgnoredCommit = assertOk(await call("git_commit", { cwd: root, message: "Commit pretracked ignored fixture" }));
  assert.match(trackedIgnoredCommit, /S1 pre-commit policy passed/);

  fs.writeFileSync(path.join(root, "docs", "new-ignored.json"), "{\"state\":\"new\"}\n");
  assertError(await call("git_stage", { cwd: root, paths: ["docs/new-ignored.json"] }), /repository-ignored/);

  assert.match(assertOk(await call("git_status", { cwd: root })), /s1\/isolated/);
  assert.match(assertOk(await call("git_log", { cwd: root, limit: 5 })), /S1 fixture commit/);
  assertOk(await call("git_diff", { cwd: root }));
  assertError(await call("git_stage", { cwd: root, paths: ["../outside/secret.txt"] }), /literal workspace-relative|may not contain/);
  assertError(await call("git_stage", { cwd: root, paths: [".git/config"] }), /secret-sensitive|protected/);
  await assertUnknownTool("git_run");
});

test("health is bounded and reports the active S1 runtime", async () => {
  const health = assertOk(await call("health", {}));
  assert.match(health, /"runtime": "s1-contained"/);
  assert.match(health, /"managedProcesses": \[/);
  assert.doesNotMatch(health, /"host"|hostname|loadAverage/);
});

async function assertUnknownTool(name) {
  try {
    const result = await call(name, {});
    assert.equal(result.isError, true);
  } catch (error) {
    assert.match(String(error.message), /not found|unknown tool|invalid/i);
  }
}

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

function installReviewedHook(target) {
  fs.mkdirSync(path.join(target, ".githooks"), { recursive: true });
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), ".githooks", "pre-commit"), path.join(target, ".githooks", "pre-commit"));
  fs.copyFileSync(path.join(process.cwd(), "scripts", "pre-commit-policy.mjs"), path.join(target, "scripts", "pre-commit-policy.mjs"));
  fs.chmodSync(path.join(target, ".githooks", "pre-commit"), 0o755);
}

function spawnGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function requestUnix({ authorization, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    };
    if (authorization) headers.authorization = authorization;
    const request = http.request({
      socketPath: unixSocketPath,
      path: "/mcp",
      method: "POST",
      headers,
    }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: chunks.join("") }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function textOf(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

function assertOk(result) {
  const text = textOf(result);
  assert.equal(Boolean(result.isError), false, text);
  return text;
}

function assertError(result, pattern) {
  const text = textOf(result);
  assert.equal(Boolean(result.isError), true, text);
  assert.match(text, pattern);
  return text;
}
