import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = fs.mkdtempSync(path.join(os.homedir(), ".sol-integration-test-"));
const root = path.join(base, "workspace");
const outside = path.join(base, "outside");
fs.mkdirSync(root);
fs.mkdirSync(outside);
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.WORKSPACE_ROOTS = root;
process.env.MCP_TOKEN = "integration-secret";
process.env.DESTRUCTIVE_APPROVAL_MODE = "chat";
process.env.HOST = "127.0.0.1";
const { createApp, startHttpServer } = await import("../../src/server.js");
const { EXPECTED_TOOL_NAMES } = await import("../../src/tool-contract.js");

const runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
const port = runtime.httpServer.address().port;
const url = `http://127.0.0.1:${port}/mcp`;
const client = new Client({ name: "integration-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: "Bearer integration-secret" } },
});
await client.connect(transport);

test.after(async () => {
  await client.close().catch(() => {});
  await runtime.shutdown("test");
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

test("MCP lists exactly 44 production tools", async () => {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOL_NAMES].sort());
  assert.equal(tools.tools.every((tool) => tool.inputSchema?.type === "object"), true);
});

test("workspace/file/patch tools round-trip inside configured authority", async () => {
  assertOk(await call("workspace_open", { path: root }));
  assertError(await call("workspace_add_root", { path: outside }), /disabled by default/);

  const file = path.join(root, "hello.txt");
  assertOk(await call("write_file", { path: file, content: "hello\n" }));
  assert.match(assertOk(await call("read_file", { path: file })), /hello/);
  assertOk(await call("edit_file", { path: file, oldText: "hello", newText: "world" }));
  assert.equal(fs.readFileSync(file, "utf8"), "world\n");

  spawnSync("git", ["init", "-q"], { cwd: root });
  const patch = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-world\n+patched\n";
  assertOk(await call("apply_patch", { cwd: root, diff: patch }));
  assert.equal(fs.readFileSync(file, "utf8"), "patched\n");
});

test("bridge internal state is not exposed as a file-tool workspace", async () => {
  assertError(await call("read_file", { path: path.join(base, "state", "state.json") }), /outside registered workspace roots/);
});

test("symlink escapes are rejected", { skip: process.platform === "win32" }, async () => {
  fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
  fs.symlinkSync(outside, path.join(root, "escape"), "dir");
  assertError(await call("read_file", { path: path.join(root, "escape", "secret.txt") }), /outside registered workspace roots/);
});

test("destructive requests validate cwd before creating approval tokens", async () => {
  const rejected = await call("shell", { command: "rm --version", cwd: outside });
  const text = assertError(rejected, /outside registered workspace roots/);
  assert.doesNotMatch(text, /DELETE BLOCKED/);
});

test("destructive command requires an exact single-use confirmation token", async () => {
  const victim = path.join(root, "delete-me.txt");
  fs.writeFileSync(victim, "temporary");
  const command = process.platform === "win32" ? `del /q "${victim}"` : `rm -f '${victim}'`;
  const blocked = await call("shell", { command, cwd: root });
  const blockedText = assertError(blocked, /DELETE BLOCKED/);
  assert.match(blockedText, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.existsSync(victim), true);
  const token = blockedText.match(/Token:\s*(del_[A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token);
  assertOk(await call("confirm_destructive", { token, userSaidYes: true }));
  assert.equal(fs.existsSync(victim), false);
  assertError(await call("confirm_destructive", { token, userSaidYes: true }), /already-used/);

  const truncate = path.join(root, "truncate-me.txt");
  fs.writeFileSync(truncate, "content");
  const truncateBlocked = await call("write_file", { path: truncate, content: "" });
  const truncateText = assertError(truncateBlocked, /truncate file to zero bytes/);
  const truncateToken = truncateText.match(/Token:\s*(del_[A-Za-z0-9_-]+)/)?.[1];
  assert.ok(truncateToken);
  assertOk(await call("confirm_destructive", { token: truncateToken, userSaidYes: true }));
  assert.equal(fs.readFileSync(truncate, "utf8"), "");

  const officeText = path.join(root, "office-note.txt");
  fs.writeFileSync(officeText, "content");
  const officeBlocked = await call("office", { action: "write", path: officeText, content: "" });
  const officeTextResult = assertError(officeBlocked, /empty document/);
  const officeToken = officeTextResult.match(/Token:\s*(del_[A-Za-z0-9_-]+)/)?.[1];
  assert.ok(officeToken);
  assertOk(await call("confirm_destructive", { token: officeToken, userSaidYes: true }));
  assert.equal(fs.readFileSync(officeText, "utf8"), "");
});

test("private-network fetch is blocked by default", async () => {
  assertError(await call("web_fetch", { url: `http://127.0.0.1:${port}/healthz` }), /private\/special address|private\/local target/);
});

test("active platform health adapter returns a bounded result", async () => {
  const health = assertOk(await call("health", {}));
  assert.match(health, /"ok": true/);
  assert.match(health, /"platform": \{/);
});

async function call(name, args) {
  return client.callTool({ name, arguments: args });
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
