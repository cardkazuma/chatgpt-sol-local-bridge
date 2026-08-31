import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("status adopts the validated manager root recorded by an active runtime", () => {
  const runtimeRoot = path.join(base, "persisted-manager-runtime");
  const recordedManagerRoot = path.join(os.tmpdir(), `chatgpt-local-bridge-s5-recorded-${process.pid}`);
  const writer = new S5Runtime({
    runtimeRoot,
    managerRoot: recordedManagerRoot,
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  writer.ensureRuntimeRoot();
  writer.writeState({ version: 1, kind: "s5-runtime", phase: "starting", sessionId: "s5-test-0123456789abcdef", managerRoot: recordedManagerRoot, resources: makeResources() });
  const reader = new S5Runtime({ runtimeRoot, platform: "darwin", securityBin: security, spawnSupervisor: false });
  assert.equal(reader.managerRoot, recordedManagerRoot);
});

test("status accepts a persisted macOS per-user temporary manager root", () => {
  const runtimeRoot = path.join(base, "persisted-darwin-manager-runtime");
  const recordedManagerRoot = "/var/folders/zz/s5-runtime-fixture/T/chatgpt-local-bridge-s5-recorded";
  const writer = new S5Runtime({
    runtimeRoot,
    managerRoot: recordedManagerRoot,
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  writer.ensureRuntimeRoot();
  writer.writeState({ version: 1, kind: "s5-runtime", phase: "starting", sessionId: "s5-test-0123456789abcdef", managerRoot: recordedManagerRoot, resources: makeResources() });
  const reader = new S5Runtime({ runtimeRoot, platform: "darwin", securityBin: security, spawnSupervisor: false });
  assert.equal(reader.managerRoot, recordedManagerRoot);
});

test("the tunnel identifier is ephemeral tunnel-plane input, not profile state", () => {
  const runtime = new S5Runtime({
    runtimeRoot: path.join(base, "tunnel-id-runtime"),
    managerRoot: path.join(os.tmpdir(), `chatgpt-local-bridge-s5-tunnel-id-${process.pid}`),
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  runtime.ensureRuntimeRoot();
  runtime.writeProfile();
  assert.doesNotMatch(fs.readFileSync(runtime.profileFile, "utf8"), /tunnel_id|CONTROL_PLANE_TUNNEL_ID/);

  const calls = [];
  runtime.docker = { checked: (args) => calls.push(args) };
  runtime.createTunnel(
    { tunnelName: "s5-test-0123456789ab-tunnel", privateNetworkName: "s5-test-0123456789ab-private" },
    { tunnelClientBin: "/tmp/tunnel-client" },
    "/tmp/tunnel.env",
    "tunnel_s5_ephemeral_fixture",
  );
  assert.equal(calls.length, 2);
  assert(calls[0].includes("CONTROL_PLANE_TUNNEL_ID=tunnel_s5_ephemeral_fixture"));
  assert.equal(fs.readFileSync(runtime.profileFile, "utf8").includes("tunnel_s5_ephemeral_fixture"), false);
});

test("missing sidecar cache is restored only from the approved exact digest", () => {
  const runtime = new S5Runtime({
    runtimeRoot: path.join(base, "sidecar-runtime"),
    managerRoot: path.join(os.tmpdir(), `chatgpt-local-bridge-s5-sidecar-${process.pid}`),
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  const calls = [];
  runtime.docker = {
    imageAvailable: () => false,
    checked: (args) => calls.push(args),
    run: () => ({ status: 0, stdout: "node@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de\n" }),
  };
  runtime.ensurePinnedSidecarImage();
  assert.deepEqual(calls, [["pull", "node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de"]]);
});

test("sidecar cache recovery rejects a non-matching digest", () => {
  const runtime = new S5Runtime({
    runtimeRoot: path.join(base, "wrong-sidecar-runtime"),
    managerRoot: path.join(os.tmpdir(), `chatgpt-local-bridge-s5-wrong-sidecar-${process.pid}`),
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  runtime.docker = {
    imageAvailable: () => true,
    checked: () => { throw new Error("unexpected pull"); },
    run: () => ({ status: 0, stdout: "node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" }),
  };
  assert.throws(() => runtime.ensurePinnedSidecarImage(), /pinned sidecar image digest verification failed/);
});

test("control-plane health keeps a bounded redacted retry diagnostic", () => {
  const runtime = new S5Runtime({
    runtimeRoot: path.join(base, "control-plane-runtime"),
    managerRoot: path.join(os.tmpdir(), `chatgpt-local-bridge-s5-control-plane-${process.pid}`),
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  runtime.docker = {
    run: () => ({
      status: 2,
      stdout: JSON.stringify({
        result: "not_ready",
        healthz: { ok: true, status: 200, body: "live" },
        readyz: { ok: true, status: 200, body: "ready" },
        control_plane_poll: { ok: false, error: "pending tunnel_s5_sensitive" },
      }),
    }),
  };
  assert.equal(runtime.tunnelControlPlaneReady("s5-test-0123456789ab-tunnel"), false);
  assert.match(runtime.lastTunnelControlPlaneDiagnostic, /control-plane-poll=fail/);
  assert.doesNotMatch(runtime.lastTunnelControlPlaneDiagnostic, /tunnel_s5_sensitive/);
});

test("tunnel failure logs retain only bounded redacted messages", () => {
  const runtime = new S5Runtime({
    runtimeRoot: path.join(base, "tunnel-log-runtime"),
    managerRoot: path.join(os.tmpdir(), `chatgpt-local-bridge-s5-tunnel-log-${process.pid}`),
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  runtime.docker = {
    run: () => ({ stdout: [
      JSON.stringify({ level: "error", msg: "control plane returned 401 for tunnel_s5_sensitive with Bearer secret-value" }),
      "not-json",
    ].join("\n") }),
  };
  const diagnostic = runtime.tunnelLogDiagnostic("s5-test-0123456789ab-tunnel");
  assert.match(diagnostic, /401/);
  assert.doesNotMatch(diagnostic, /tunnel_s5_sensitive|secret-value/);
  assert.ok(diagnostic.length <= 480);
});

test("pending waitFor keeps a process alive until its predicate succeeds", async () => {
  const runtimeModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/s5-runtime.mjs");
  const started = Date.now();
  const child = await runNode([
    `import { S5Runtime } from ${JSON.stringify(runtimeModule)};`,
    "const runtime = Object.create(S5Runtime.prototype);",
    "let ready = false;",
    "setTimeout(() => { ready = true; }, 40).unref();",
    "await runtime.waitFor(() => ready, 'fixture predicate', 500);",
    "process.stdout.write(JSON.stringify({ resolved: true }));",
  ].join("\n"));
  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.deepEqual(JSON.parse(child.stdout), { resolved: true });
  assert.ok(Date.now() - started >= 200, `waitFor completed too early: ${Date.now() - started}ms`);
});

test("waitFor honors its configured timeout and leaves no timer after rejection", async () => {
  const runtimeModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/s5-runtime.mjs");
  const timeoutMs = 80;
  const started = Date.now();
  const child = await runNode([
    `import { S5Runtime } from ${JSON.stringify(runtimeModule)};`,
    "const runtime = Object.create(S5Runtime.prototype);",
    "try { await runtime.waitFor(() => false, 'fixture timeout', 80); }",
    "catch (error) { process.stdout.write(JSON.stringify({ message: error.message })); }",
  ].join("\n"));
  const elapsed = Date.now() - started;
  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.deepEqual(JSON.parse(child.stdout), { message: "timed out waiting for fixture timeout" });
  assert.ok(elapsed >= timeoutMs, `timeout completed too early: ${elapsed}ms`);
  assert.ok(elapsed < 600, `timeout exceeded its polling window: ${elapsed}ms`);
});

test("start cannot report success while runtime state is still starting", async () => {
  const runtimeRoot = path.join(base, "starting-runtime");
  const managerRoot = path.join(base, "chatgpt-local-bridge-s5-starting-manager");
  const stateRoot = path.join(managerRoot, "manager-state");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const sessionId = "s5-starting-0123456789abcdef";
  const session = { sessionId, state: "active", branch: `bridge/s5/${sessionId}`, sourceCommit: "fixture", historyCommits: 1, coreHooksPath: ".githooks", workspacePath: path.join(base, "starting-workspace") };
  const manager = {
    stateRoot,
    reapStale: () => [],
    create: () => session,
    readRecord: () => session,
    destroy: () => ({ sessionId, destroyed: true }),
  };
  let phaseAtStartupFailure;
  let cleaned = false;
  const runtime = new S5Runtime({
    runtimeRoot,
    managerRoot,
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  runtime.createManager = () => manager;
  runtime.resolveTunnelInputs = () => ({ caBundle: "" });
  runtime.validateStaticPreflight = () => {};
  runtime.writeTrustBundle = () => {};
  runtime.writeProfile = () => {};
  runtime.writeComposeOverride = () => {};
  runtime.createDockerResources = () => {};
  runtime.containerRunning = () => true;
  runtime.bridgeSocketReady = () => true;
  runtime.bridgeReady = () => true;
  runtime.assertBridgeBoundary = () => {};
  runtime.startRelay = () => {};
  runtime.relayReady = () => true;
  runtime.assertRelayBoundary = () => {};
  runtime.mcpStartupProbe = () => {
    phaseAtStartupFailure = JSON.parse(fs.readFileSync(runtime.stateFile, "utf8")).phase;
    throw new Error("fixture startup failure");
  };
  runtime.cleanupRuntime = async (resources) => { cleaned = Boolean(resources); };
  await assert.rejects(
    () => runtime.start({ source: path.join(base, "starting-source"), tunnelId: "tunnel_s5_fixture" }),
    /S5 start blocked: fixture startup failure/,
  );
  assert.equal(phaseAtStartupFailure, "starting");
  assert.equal(cleaned, true);
  assert.equal(fs.existsSync(runtime.stateFile), false);
});

test("start failure remains fail-closed and cleans its newly-created session", async () => {
  const runtimeRoot = path.join(base, "failure-runtime");
  const managerRoot = path.join(base, "chatgpt-local-bridge-s5-failure-manager");
  const stateRoot = path.join(managerRoot, "manager-state");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const sessionId = "s5-failure-0123456789abcdef";
  const session = { sessionId, state: "active", branch: `bridge/s5/${sessionId}`, sourceCommit: "fixture", historyCommits: 1, coreHooksPath: ".githooks", workspacePath: path.join(base, "failure-workspace") };
  let destroyed = 0;
  let cleaned = false;
  const manager = {
    stateRoot,
    reapStale: () => [],
    create: () => session,
    readRecord: () => session,
    destroy: () => { destroyed += 1; return { sessionId, destroyed: true }; },
  };
  const runtime = new S5Runtime({
    runtimeRoot,
    managerRoot,
    platform: "darwin",
    securityBin: security,
    spawnSupervisor: false,
  });
  runtime.createManager = () => manager;
  runtime.resolveTunnelInputs = () => ({ caBundle: "" });
  runtime.validateStaticPreflight = () => { throw new Error("fixture preflight failure"); };
  runtime.cleanupRuntime = async (resources) => { cleaned = Boolean(resources); };
  await assert.rejects(
    () => runtime.start({ source: path.join(base, "failure-source"), tunnelId: "tunnel_s5_fixture" }),
    /S5 start blocked: fixture preflight failure/,
  );
  assert.equal(cleaned, true);
  assert.equal(destroyed, 1);
  assert.equal(fs.existsSync(runtime.stateFile), false);
  assert.equal(fs.readdirSync(stateRoot).length, 0);
});

function runNode(source, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(killTimer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
