import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S6Runtime } from "../../scripts/s6-runtime.mjs";

// Catch loss of explicit controller roots across the actual detached child
// launch. Only Docker inspection is substituted; heartbeat/state are real.
test("S6 supervisor heartbeats the selected session when its roots differ from child defaults", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "s6-supervisor-roots-"));
  const runtimeRoot = path.join(base, "selected-runtime");
  const managerRoot = path.join(base, "chatgpt-local-bridge-s6-selected");
  const home = path.join(base, "child-home");
  const temp = path.join(base, "child-tmp");
  const bin = path.join(base, "bin");
  const saved = Object.fromEntries(["HOME", "TMPDIR", "PATH"].map(k => [k, process.env[k]]));
  for (const dir of [home, temp, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, "docker"), '#!/bin/sh\nif [ "$1" = inspect ]; then echo true; exit 0; fi\nexit 1\n', { mode: 0o700 });
  const runtime = new S6Runtime({ runtimeRoot, managerRoot });
  runtime.ensureRuntimeRoot();
  const manager = runtime.createManager({ readOnly: true });
  const sessionId = "s6-fixture-0123456789abcdef";
  const statePath = path.join(manager.stateRoot, `${sessionId}.json`);
  const workspacePath = path.join(manager.sessionsRoot, sessionId);
  fs.mkdirSync(workspacePath);
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1, kind: "workspace", state: "active", sessionId,
    branch: `bridge/s6/${sessionId}`, statePath, workspacePath,
    ownerUid: process.getuid(), pid: process.pid, heartbeatAt: "2000-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  const state = { version: 1, kind: "s6-runtime", phase: "running", sessionId, managerRoot,
    resources: { bridgeName: "s6-fixture-bridge", tunnelName: "s6-fixture-tunnel" } };
  runtime.writeState(state);
  try {
    process.env.HOME = home;
    process.env.TMPDIR = temp;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    runtime.startSupervisor(state);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = JSON.parse(fs.readFileSync(runtime.stateFile));
      const record = JSON.parse(fs.readFileSync(statePath));
      if (current.phase !== "running" || record.pid === state.supervisorPid) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const current = JSON.parse(fs.readFileSync(runtime.stateFile));
    const record = JSON.parse(fs.readFileSync(statePath));
    assert.equal(current.phase, "running", current.failure);
    assert.equal(record.pid, state.supervisorPid, "child must touch the selected manager's session");
    assert.notEqual(record.heartbeatAt, "2000-01-01T00:00:00.000Z");
    assert.equal(record.workspacePath, workspacePath);
    assert.equal(record.statePath, statePath);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (state.supervisorPid) { try { process.kill(state.supervisorPid, "SIGTERM"); } catch {} }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
