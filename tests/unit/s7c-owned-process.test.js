import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { OwnedProcess } from "../../src/s7/owned-process.js";
const worker = new URL("../../scripts/s7-owned-worker.mjs", import.meta.url);

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (predicate()) return; await new Promise((r) => setTimeout(r, 30)); }
  assert.fail("condition was not reached");
}

test("owned process survives call completion, bounds logs, and stops only its own child", async (t) => {
  const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  const job = new OwnedProcess({ executable: process.execPath, args: ["-e", "console.log('marker'); setInterval(()=>{},1000)"], cwd: process.cwd() });
  t.after(() => job.stop());
  await job.start();
  await waitFor(() => job.logs().includes("marker"));
  assert.equal(job.status().state, "running");
  await job.stop();
  assert.equal(job.status().state, "stopped");
  assert.equal(process.kill(other.pid, 0), true);
});

test("worker IPC disconnect terminates its child after controller crash", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7c-child-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrapper = fork(worker, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => wrapper.kill());
  const message = once(wrapper, "message");
  wrapper.send({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: { PATH: process.env.PATH } });
  const [result] = await message;
  assert.equal(result.type, "started");
  assert.equal(process.kill(result.pid, 0), true);
  wrapper.disconnect();
  await waitFor(() => { try { process.kill(result.pid, 0); return false; } catch { return true; } });
});
