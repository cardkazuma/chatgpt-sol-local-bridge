import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

test("native package renders valid non-installed LaunchAgents and a secret-free profile", async () => {
  const mod = await import("../../scripts/native-package.mjs");
  assert.equal(typeof mod.renderNativePackage, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-package-"));
  try {
    const rendered = mod.renderNativePackage({
      outputDir: root, repoRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
      nodePath: process.execPath, tunnelPath: "/opt/pinned/tunnel-client", tunnelId: "tunnel_fixture",
    });
    assert.equal(rendered.installed, false);
    assert.equal(rendered.files.length, 4);
    assert.equal(fs.existsSync(path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."), "scripts", "native-supervisor.mjs")), true);
    assert.equal(fs.existsSync(path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."), "scripts", "native-host-launcher.mjs")), true);
    for (const plist of rendered.files.filter((file) => file.endsWith(".plist"))) {
      const content = fs.readFileSync(plist, "utf8");
      assert.match(content, /^<\?xml version="1\.0"/);
      assert.match(content, /<plist version="1\.0"><dict>/);
      assert.match(content, /<key>EnvironmentVariables<\/key><dict>/);
      assert.match(content, /<key>PATH<\/key><string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
      if (process.platform === "darwin") {
        const lint = spawnSync("plutil", ["-lint", plist], { encoding: "utf8" });
        assert.equal(lint.status, 0, lint.stderr || lint.stdout);
      }
      assert.doesNotMatch(content, /CONTROL_PLANE_API_KEY|MCP_TOKEN/);
    }
    const profile = fs.readFileSync(path.join(root, "tunnel-profile.yaml"), "utf8");
    assert.match(profile, /env:CONTROL_PLANE_API_KEY/);
    assert.match(profile, /env:BRIDGE_LOCAL_AUTH/);
    assert.doesNotMatch(profile, /tunnel_fixture|Bearer [A-Za-z0-9]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native runtime does not kickstart a job it just bootstrapped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-start-"));
  let server;
  try {
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "launchctl.log");
    const readyMarker = path.join(root, "server.ready");
    fs.mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    fs.mkdirSync(bin);
    const launchctl = path.join(bin, "launchctl");
    fs.writeFileSync(launchctl, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      "if [ \"$1\" = print ]; then exit 1; fi",
      `case "$*" in *host.tunnel*) test -f ${JSON.stringify(readyMarker)} || exit 42 ;; esac`,
      "if [ \"$1\" = bootstrap ]; then exit 0; fi",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o700 });
    for (const label of ["com.cardkazuma.chatgpt-local-bridge.host.server", "com.cardkazuma.chatgpt-local-bridge.host.tunnel"]) {
      fs.writeFileSync(path.join(home, "Library", "LaunchAgents", `${label}.plist`), "fixture\n");
    }
    const allocator = createServer();
    allocator.listen(0, "127.0.0.1");
    await once(allocator, "listening");
    const port = allocator.address().port;
    allocator.close();
    await once(allocator, "close");
    server = spawn(process.execPath, ["-e", `setTimeout(()=>{const fs=require('fs');const h=require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({ready:true,catalogVersion:'daily-use-v2'}))});h.listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(readyMarker)},'ready'))},250)`], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    assert.equal(Number.isInteger(port), true);
    const config = path.join(root, "runtime.json");
    fs.writeFileSync(config, JSON.stringify({ stateRoot: path.join(root, "state"), port }));
    const runtime = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../scripts/native-runtime.mjs");
    const result = spawnSync(process.execPath, [runtime, "start", `--config=${config}`], {
      encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(commands.filter((line) => line.startsWith("bootstrap ")).length, 2);
    assert.equal(commands.filter((line) => line.startsWith("kickstart ")).length, 0);
  } finally {
    server?.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native startup waits for daily-use server readiness before tunnel bootstrap", async () => {
  const { waitForNativeServerReady } = await import("../../scripts/native-package.mjs");
  const observations = [
    { ready: false, reason: "connection refused" },
    { ready: true, catalogVersion: "legacy-v1" },
    { ready: true, catalogVersion: "daily-use-v2" },
  ];
  const delays = [];
  const result = await waitForNativeServerReady({
    probe: async () => observations.shift(),
    delay: async (ms) => delays.push(ms),
    now: (() => { let value = 0; return () => value += 100; })(),
    timeoutMs: 5_000,
    intervalMs: 50,
  });
  assert.deepEqual(result, { ready: true, catalogVersion: "daily-use-v2" });
  assert.deepEqual(delays, [50, 50]);
});

test("native artifact verification pins platform, architecture, hash, and command version", async () => {
  const { verifyNativeArtifactEvidence, NATIVE_TUNNEL_SHA256, NATIVE_TUNNEL_VERSION } = await import("../../scripts/native-package.mjs");
  const bytes = Buffer.from("synthetic artifact evidence");
  const crypto = await import("node:crypto");
  const syntheticHash = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.notEqual(syntheticHash, NATIVE_TUNNEL_SHA256);
  assert.throws(() => verifyNativeArtifactEvidence({
    binary: "/opt/pinned/tunnel-client", bytes, helpStatus: 0,
    helpOutput: `run version ${NATIVE_TUNNEL_VERSION} --control-plane.api-key --mcp.server-url --mcp.extra-headers --health.url-file`,
    platform: "darwin", arch: "x64",
  }), /hash mismatch/);
  const result = verifyNativeArtifactEvidence({
    binary: "/opt/pinned/tunnel-client", bytes, helpStatus: 0,
    helpOutput: `run version ${NATIVE_TUNNEL_VERSION} --control-plane.api-key --mcp.server-url --mcp.extra-headers --health.url-file`,
    platform: "darwin", arch: "x64",
    expectedSha256: syntheticHash,
  });
  assert.equal(result.sha256, syntheticHash);
  assert.match(result.version, /0\.0\.13\+4b5267f/);
});

test("recovery stops after five attempts without replaying workspace commands", async () => {
  const { boundedRecovery } = await import("../../scripts/native-package.mjs");
  const calls = [];
  const result = await boundedRecovery({
    component: "server", maxAttempts: 5, windowMs: 600_000,
    restart: async (component) => { calls.push(component); return { healthy: false, reason: "offline" }; },
    delay: async () => {}, now: (() => { let n = 0; return () => n++ * 1_000; })(),
  });
  assert.equal(result.state, "DEGRADED");
  assert.equal(result.attempts, 5);
  assert.deepEqual(calls, ["server", "server", "server", "server", "server"]);
  assert.equal(Object.hasOwn(result, "command"), false);
});

test("native status distinguishes catalog, tunnel offline, and locked Keychain", async () => {
  const { nativeStatus } = await import("../../scripts/native-package.mjs");
  const result = await nativeStatus({
    catalogProbe: async () => ({ ready: true, catalogVersion: "daily-use-v2" }),
    tunnelProbe: async () => ({ ready: false, reason: "offline" }),
    keychainProbe: () => ({ available: false, reason: "interaction not allowed" }),
  });
  assert.equal(result.server.state, "READY");
  assert.equal(result.tunnel.state, "OFFLINE");
  assert.equal(result.keychain.state, "LOCKED_OR_UNAVAILABLE");
  assert.equal(result.ready, false);
});
