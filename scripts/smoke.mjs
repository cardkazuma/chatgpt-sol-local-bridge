#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ENABLED_TOOL_NAMES } from "../src/lib/config.js";
import { httpUrl } from "../src/lib/net.js";

const workspace = path.resolve(process.env.SMOKE_WORKSPACE || process.cwd());
if (!fs.existsSync(workspace)) throw new Error(`SMOKE_WORKSPACE does not exist: ${workspace}`);
const url = process.env.MCP_URL || httpUrl(process.env.HOST || "127.0.0.1", process.env.PORT || "8765", "/mcp");
const headers = process.env.MCP_TOKEN ? { Authorization: `Bearer ${process.env.MCP_TOKEN}` } : undefined;
const client = new Client({ name: "bridge-s1-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: headers ? { headers } : undefined });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(ENABLED_TOOL_NAMES)) throw new Error("S1 tool catalog mismatch");
  assertOk(await call("workspace_open", { path: workspace }), "workspace_open");
  const testFile = path.join(workspace, ".s1-smoke.txt");
  assertOk(await call("write_file", { path: testFile, content: "one\n" }), "write_file");
  assertOk(await call("read_file", { path: testFile }), "read_file");
  assertOk(await call("edit_file", { path: testFile, oldText: "one", newText: "two" }), "edit_file");
  assertOk(await call("search_text", { path: workspace, pattern: "two" }), "search_text");
  assertOk(await call("health", {}), "health");
  console.log(JSON.stringify({ toolCount: names.length, tools: names, writeReadEditSearchHealth: true }, null, 2));
} finally {
  await client.close().catch(() => {});
}

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

function assertOk(result, name) {
  const text = (result.content || []).map((item) => item.text || "").join("\n");
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}
