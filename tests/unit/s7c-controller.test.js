import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startController } from "../../src/s7/controller.js";

// The real HTTP/MCP boundary must never report ready from process liveness
// alone, or accept calls from an unauthenticated request.
test("controller authenticates MCP, distinguishes dependency failure, and requires catalog refresh", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7c-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = await startController({ root, port: 0, token: "fixture-only-token", dependencies: async () => ({ tunnel: { ready: false, reason: "disconnected" }, coordinator: { ready: false, reason: "unavailable" } }) });
  t.after(() => controller.close());
  const base = `http://127.0.0.1:${controller.port}`;
  const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(denied.status, 401);
  const call = async (method, params) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer fixture-only-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) });
    return response.json();
  };
  const catalog = await call("tools/list", {});
  assert.ok(catalog.result.tools.some((x) => x.name === "bridge_status"));
  const status = await call("tools/call", { name: "bridge_status", arguments: {} });
  const value = JSON.parse(status.result.content[0].text);
  assert.equal(value.ready, false); assert.equal(value.controller.ready, true);
  assert.equal(value.coordinator.ready, false); assert.equal(value.tunnel.ready, false);
  assert.equal(value.surface.state, "client_verification_required");
  assert.match(value.catalog.refresh, /Refresh/);
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 503);
});

test("duplicate controller listener fails cleanly and cannot take over an active runtime", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7c-listener-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { root, port: 0, token: "fixture-only-token", dependencies: async () => ({}) };
  const controller = await startController(options);
  t.after(() => controller.close());
  await assert.rejects(startController({ ...options, port: controller.port }), (error) => error.code === "EADDRINUSE");
  const response = await fetch(`http://127.0.0.1:${controller.port}/healthz`);
  assert.equal(response.status, 200);
});
