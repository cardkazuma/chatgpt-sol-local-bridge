#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EXPECTED_TOOL_NAMES } from "../src/tool-contract.js";
import { httpUrl } from "../src/lib/net.js";

const config = loadRuntimeConfig();
const url = config.MCP_URL || httpUrl(config.HOST || "127.0.0.1", config.PORT || "8765", "/mcp");
const headers = config.MCP_TOKEN ? { Authorization: `Bearer ${config.MCP_TOKEN}` } : undefined;
const scratchBase = config.SMOKE_WORKSPACE
  ? expandHome(config.SMOKE_WORKSPACE)
  : config.BRIDGE_SCRATCH_DIR
    ? expandHome(config.BRIDGE_SCRATCH_DIR)
    : path.join(os.homedir(), ".chatgpt-sol-local-bridge-scratch");
fs.mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
const scratch = fs.mkdtempSync(path.join(scratchBase, "run-"));
const client = new Client({ name: "bridge-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: headers ? { headers } : undefined });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = [...EXPECTED_TOOL_NAMES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`tool contract mismatch\nexpected=${expected.join(",")}\nactual=${names.join(",")}`);
  }

  const testFile = path.join(scratch, "roundtrip.txt");
  assertOk(await call("write_file", { path: testFile, content: "one\n" }), "write_file");
  const read = assertOk(await call("read_file", { path: testFile }), "read_file");
  if (!read.includes("one")) throw new Error("read_file did not return written content");
  assertOk(await call("edit_file", { path: testFile, oldText: "one", newText: "two" }), "edit_file");

  const deleteCommand = process.platform === "win32"
    ? `del /q "${path.join(scratch, "does-not-exist.txt")}"`
    : `rm -f '${path.join(scratch, "does-not-exist.txt")}'`;
  const blocked = await call("shell", { command: deleteCommand, cwd: scratch });
  const blockedText = textOf(blocked);
  if (!blocked.isError || !blockedText.includes("DELETE BLOCKED")) throw new Error(`expected delete block, got ${blockedText}`);
  const token = blockedText.match(/Token:\s*(del_[A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error("delete block did not return an approval token");
  assertOk(await call("confirm_destructive", { token, userSaidYes: true }), "confirm_destructive");

  const health = assertOk(await call("health", {}), "health");
  console.log(JSON.stringify({ url, toolCount: names.length, tools: names, writeReadEdit: true, deleteBlockedAndConfirmed: true, health: health.slice(0, 500) }, null, 2));
} finally {
  await client.close().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
}

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

function textOf(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

function loadRuntimeConfig() {
  const candidates = [process.env.BRIDGE_ENV_FILE, defaultRuntimeEnv(), path.resolve(".env")].filter(Boolean);
  let fileConfig = {};
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      fileConfig = dotenv.parse(fs.readFileSync(candidate));
      break;
    }
  }
  return { ...fileConfig, ...process.env };
}

function defaultRuntimeEnv() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "chatgpt-sol-local-bridge", "runtime.env")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "chatgpt-sol-local-bridge", "runtime.env");
}

function expandHome(value) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
}

function assertOk(result, name) {
  const text = textOf(result);
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}
