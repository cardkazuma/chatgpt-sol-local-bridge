import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S5Runtime, makeResources } from "../../scripts/s5-runtime.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s5-runtime-test-"));
const security = path.join(base, "security");
fs.writeFileSync(security, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
fs.chmodSync(security, 0o700);

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("runtime status and stop are safe when no runtime is active", async () => {
  const runtime = new S5Runtime({
    runtimeRoot: path.join(base, "runtime"),
    managerRoot: path.join(os.tmpdir(), `chatgpt-local-bridge-s5-test-${process.pid}`),
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  const status = runtime.status({ inspectLive: false });
  assert.equal(status.running, false);
  assert.equal(status.phase, "stopped");
  assert.equal(status.credentialPlane.available, false);
  assert.deepEqual(status.disposableWorkspaces, { count: 0, sessionIds: [] });
  assert.deepEqual(await runtime.stop(), { running: false, stopped: false, workspaceDestruction: "not requested" });
  const resources = makeResources();
  assert.match(resources.projectName, /^s5-[0-9]+-[0-9a-f]{12}$/);
  assert.equal(typeof resources.relayToken, "string");
  await runtime.rollback();
  assert.equal(fs.existsSync(path.join(base, "runtime", "state.json")), false);
  assert.equal(fs.existsSync(path.join(base, "runtime", "tunnel-profile.yaml")), false);
});
test("runtime state persistence excludes the relay bearer", () => {
  const runtime = new S5Runtime({
    runtimeRoot: path.join(base, "state-runtime"),
    managerRoot: path.join(os.tmpdir(), `chatgpt-local-bridge-s5-state-${process.pid}`),
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  runtime.ensureRuntimeRoot();
  const resources = makeResources();
  runtime.writeState({ version: 1, kind: "s5-runtime", phase: "starting", sessionId: "s5-test-0123456789abcdef", resources });
  const persisted = JSON.parse(fs.readFileSync(runtime.stateFile, "utf8"));
  assert.equal("relayToken" in persisted.resources, false);
});
