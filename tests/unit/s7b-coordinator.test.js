import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setS6BrokerRequestForTests } from "../../src/lib/s6-broker-client.js";

test("S7-B structured mutation seam is a real pre-mutation coordinator gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s7b-seam-"));
  const originalGovernance = process.env.BRIDGE_GOVERNANCE_MODE;
  const originalWorkspace = process.env.DEFAULT_WORKSPACE;
  const originalRoots = process.env.WORKSPACE_ROOTS;
  const calls = [];
  try {
    process.env.BRIDGE_GOVERNANCE_MODE = "s6";
    process.env.DEFAULT_WORKSPACE = root;
    process.env.WORKSPACE_ROOTS = root;
    process.env.BRIDGE_STATE_DIR = path.join(root, "state");
    const { coordinatorBeforeMutation } = await import("../../src/lib/coordinator-guard.js");
    assert.equal(typeof coordinatorBeforeMutation, "function");
    setS6BrokerRequestForTests((request) => {
      calls.push({ ...request, observedBeforeWrite: fs.existsSync(path.join(root, request.path)) ? fs.readFileSync(path.join(root, request.path), "utf8") : null });
      return { decision: "ALLOW", reason_code: "WORK_ALLOWED" };
    });

    const { registerFiles } = await import("../../src/tools/files.js");
    const handlers = new Map();
    registerFiles({ registerTool(name, _definition, handler) { handlers.set(name, handler); } });
    assert.deepEqual([...handlers.keys()].filter((name) => ["write_file", "edit_file", "apply_patch"].includes(name)), ["write_file", "apply_patch", "edit_file"]);

    const writeResult = await handlers.get("write_file")({ path: "write.txt", content: "first\n" });
    assert.equal(writeResult.isError, undefined);
    assert.equal(fs.readFileSync(path.join(root, "write.txt"), "utf8"), "first\n");

    const editResult = await handlers.get("edit_file")({ path: "write.txt", oldText: "first", newText: "second" });
    assert.equal(editResult.isError, undefined);
    assert.equal(fs.readFileSync(path.join(root, "write.txt"), "utf8"), "second\n");

    execFileSync("git", ["init", "-q", root]);
    const patchResult = await handlers.get("apply_patch")({
      cwd: root,
      diff: "diff --git a/write.txt b/write.txt\n--- a/write.txt\n+++ b/write.txt\n@@ -1 +1 @@\n-second\n+patched\n",
    });
    assert.equal(patchResult.isError, undefined);
    assert.equal(fs.readFileSync(path.join(root, "write.txt"), "utf8"), "patched\n");
    assert.deepEqual(calls.map(({ route, path: target }) => [route, target]), [
      ["write_file", "write.txt"], ["edit_file", "write.txt"], ["apply_patch", "write.txt"],
    ]);
    assert.deepEqual(calls.map(({ observedBeforeWrite }) => observedBeforeWrite), [null, "first\n", "second\n"]);
  } finally {
    setS6BrokerRequestForTests(null);
    if (originalGovernance === undefined) delete process.env.BRIDGE_GOVERNANCE_MODE; else process.env.BRIDGE_GOVERNANCE_MODE = originalGovernance;
    if (originalWorkspace === undefined) delete process.env.DEFAULT_WORKSPACE; else process.env.DEFAULT_WORKSPACE = originalWorkspace;
    if (originalRoots === undefined) delete process.env.WORKSPACE_ROOTS; else process.env.WORKSPACE_ROOTS = originalRoots;
    delete process.env.BRIDGE_STATE_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("S7-B coordinator fails closed when an S6 broker is not registered", async () => {
  const { coordinatorBeforeMutation } = await import("../../src/lib/coordinator-guard.js");
  const prior = process.env.BRIDGE_GOVERNANCE_MODE;
  process.env.BRIDGE_GOVERNANCE_MODE = "s6";
  try {
    await assert.rejects(() => coordinatorBeforeMutation({ operation: "write_file", targetPath: path.join(os.tmpdir(), "not-a-workspace") }), /not registered/);
  } finally {
    if (prior === undefined) delete process.env.BRIDGE_GOVERNANCE_MODE; else process.env.BRIDGE_GOVERNANCE_MODE = prior;
  }
});

test("S7-B broker protocol accepts only the narrow structured mutation operation", async () => {
  const { S6GitHubBroker, dispatchS6BrokerRequest } = await import("../../scripts/s6-github-broker.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-local-bridge-s6-s7b-dispatch-"));
  const session = "s6-dispatch-0123456789abcdef";
  try {
    const broker = new S6GitHubBroker({ managerRoot: root, bridgeRoot: root, sessionId: session, platform: "linux" });
    const auth = { capability: "a".repeat(64) };
    let received;
    broker.coordinateMutation = async (request) => { received = request; return { allowed: true, decision: "ALLOW", reason_code: "WORK_ALLOWED" }; };
    const response = await dispatchS6BrokerRequest(broker, auth, {
      capability: auth.capability, operation: "coordinate-mutation", route: "write_file", path: "README.md",
    });
    assert.equal(response.decision, "ALLOW");
    assert.deepEqual(received, { route: "write_file", path: "README.md" });
    await assert.rejects(() => dispatchS6BrokerRequest(broker, auth, {
      capability: auth.capability, operation: "coordinate-mutation", route: "repo_shell", path: "README.md",
    }), /route is invalid/);
    await assert.rejects(() => dispatchS6BrokerRequest(broker, auth, {
      capability: auth.capability, operation: "coordinate-mutation", route: "write_file", path: "../README.md",
    }), /path|normalized/);
    await assert.rejects(() => dispatchS6BrokerRequest(broker, auth, {
      capability: auth.capability, operation: "coordinate-mutation", route: "write_file", path: "README.md", store: "/tmp/other.db",
    }), /only a covered route and path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
