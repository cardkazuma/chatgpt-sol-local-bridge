import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
      const lint = spawnSync("plutil", ["-lint", plist], { encoding: "utf8" });
      assert.equal(lint.status, 0, lint.stderr || lint.stdout);
      assert.doesNotMatch(fs.readFileSync(plist, "utf8"), /CONTROL_PLANE_API_KEY|MCP_TOKEN/);
    }
    const profile = fs.readFileSync(path.join(root, "tunnel-profile.yaml"), "utf8");
    assert.match(profile, /env:CONTROL_PLANE_API_KEY/);
    assert.match(profile, /env:BRIDGE_LOCAL_AUTH/);
    assert.doesNotMatch(profile, /tunnel_fixture|Bearer [A-Za-z0-9]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native artifact verification pins platform, architecture, hash, and command version", async () => {
  const { verifyNativeArtifact, NATIVE_TUNNEL_SHA256 } = await import("../../scripts/native-package.mjs");
  const binary = "/private/tmp/bridge-s7-tunnel/native/tunnel-client";
  assert.equal(fs.existsSync(binary), true, "accepted native fixture is required");
  const result = verifyNativeArtifact({ binary, platform: "darwin", arch: "x64" });
  assert.equal(result.sha256, NATIVE_TUNNEL_SHA256);
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
    catalogProbe: async () => ({ ready: true, catalogVersion: "daily-use-v1" }),
    tunnelProbe: async () => ({ ready: false, reason: "offline" }),
    keychainProbe: () => ({ available: false, reason: "interaction not allowed" }),
  });
  assert.equal(result.server.state, "READY");
  assert.equal(result.tunnel.state, "OFFLINE");
  assert.equal(result.keychain.state, "LOCKED_OR_UNAVAILABLE");
  assert.equal(result.ready, false);
});
