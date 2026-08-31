import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-exec-test-"));
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.WORKSPACE_ROOTS = base;
const exec = await import("../../src/lib/exec.js");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("tool child environments strip secret-like variables by default", () => {
  process.env.BRIDGE_TEST_API_KEY = "must-not-leak";
  process.env.CONTROL_PLANE_API_KEY = "tunnel-secret";
  process.env.S6_BROKER_SOCKET = "/bridge-broker/publish.sock";
  process.env.S6_BROKER_CAPABILITY = "must-not-leak";
  process.env.S6_GITHUB_TOKEN_FILE = "/private/token";
  process.env.GITHUB_TOKEN = "must-not-leak";
  process.env.GH_ENTERPRISE_TOKEN = "must-not-leak";
  process.env.SSH_AUTH_SOCK = "/private/ssh-agent";
  process.env.GIT_ASKPASS = "/private/askpass";
  process.env.BRIDGE_TEST_NORMAL = "visible";
  const childEnv = exec.toolEnvironment();
  assert.equal(childEnv.BRIDGE_TEST_API_KEY, undefined);
  assert.equal(childEnv.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(childEnv.S6_BROKER_SOCKET, undefined);
  assert.equal(childEnv.S6_BROKER_CAPABILITY, undefined);
  assert.equal(childEnv.S6_GITHUB_TOKEN_FILE, undefined);
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(childEnv.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(childEnv.SSH_AUTH_SOCK, undefined);
  assert.equal(childEnv.GIT_ASKPASS, undefined);
  assert.equal(childEnv.BRIDGE_TEST_NORMAL, "visible");
  delete process.env.BRIDGE_TEST_API_KEY;
  delete process.env.CONTROL_PLANE_API_KEY;
  delete process.env.S6_BROKER_SOCKET;
  delete process.env.S6_BROKER_CAPABILITY;
  delete process.env.S6_GITHUB_TOKEN_FILE;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_ENTERPRISE_TOKEN;
  delete process.env.SSH_AUTH_SOCK;
  delete process.env.GIT_ASKPASS;
  delete process.env.BRIDGE_TEST_NORMAL;
});

test("AbortSignal cancels bounded commands", async () => {
  const controller = new AbortController();
  const running = exec.runCommand([process.execPath, "-e", "setTimeout(()=>{}, 4000)"], { cwd: base, signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
});

test("bounded POSIX commands terminate their descendant process group on timeout", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const result = await exec.runCommand("sleep 4 & wait", { cwd: base, timeoutMs: 250 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3_000, `timeout took ${Date.now() - started}ms`);
});

test("process supervisor tracks, logs, and stops only bridge-owned processes", async () => {
  const meta = exec.startProcess([process.execPath, "-e", "console.log('ready'); setInterval(()=>{}, 1000)"], { cwd: base, shell: false });
  try {
    await waitFor(() => exec.listProcesses().find((item) => item.id === meta.id)?.running, 3_000);
    await waitFor(() => exec.tailFile(meta.stdoutPath).includes("ready"), 3_000);
    assert.match(exec.tailFile(meta.stdoutPath), /ready/);
    const stopped = await exec.stopProcess(meta.id);
    assert.equal(stopped.id, meta.id);
    await waitFor(() => !exec.isPidRunning(meta.pid), 4_000);
  } finally {
    if (exec.isPidRunning(meta.pid)) await exec.terminateProcessTree(meta.pid);
  }
  await assert.rejects(() => exec.stopProcess("not-managed"), /unknown bridge-managed process/);
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}
