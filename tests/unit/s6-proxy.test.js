import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

test("S6 networkless channel proxy returns a host response after the client half-closes", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "s6-channel-proxy-test-"));
  const socketPath = path.join(base, "broker.sock");
  const child = spawn(process.execPath, [path.join(repo, "scripts", "s6-broker-channel-proxy.mjs"), "--socket", socketPath], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await waitForLine(child.stderr, "S6_PROXY_READY");
    const proxyLine = waitForJsonLine(child.stdout);
    const response = new Promise((resolve, reject) => {
      let output = "";
      const socket = net.createConnection({ path: socketPath });
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.end(`${JSON.stringify({ operation: "register", capability: "a".repeat(64) })}\n`));
      socket.on("data", (chunk) => { output += chunk; });
      socket.on("error", reject);
      socket.on("close", () => resolve(output));
    });
    const envelope = await proxyLine;
    assert.equal(envelope.request.operation, "register");
    child.stdin.write(`${JSON.stringify({ id: envelope.id, response: { registered: true } })}\n`);
    assert.equal(await response, `${JSON.stringify({ registered: true })}\n`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) => { if (line === expected) { lines.close(); resolve(); } });
    stream.on("error", reject);
  });
}

function waitForJsonLine(stream) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    lines.once("line", (line) => { lines.close(); try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
    stream.on("error", reject);
  });
}
