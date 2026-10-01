import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRuntimeConfig, launchAgentPlist } from "../../scripts/s7-runtime.mjs";

test("runtime refuses missing or wrong tunnel binary before activation and never creates coordinator state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7c-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, root, tunnelBinary: "/missing", tunnelSha256: "a".repeat(64), coordinatorConfig: path.join(root, "missing-coordinator"), tunnelId: "tunnel_fixture", port: 18765, healthPort: 18766, repositories: [] }), { mode: 0o600 });
  assert.throws(() => readRuntimeConfig(file), /tunnel|binding/);
  assert.equal(fs.existsSync(path.join(root, "missing-coordinator")), false);
});

test("LaunchAgent uses normal-user background startup with bounded relaunch and an exact executable/config", () => {
  const xml = launchAgentPlist({ node: "/usr/local/bin/node", script: "/safe/app/scripts/s7-runtime.mjs", config: "/safe/app/config.json", log: "/safe/app/launch.log" });
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(xml, /<string>\/safe\/app\/config.json<\/string>/);
  assert.doesNotMatch(xml, /sudo|LaunchDaemon|CONTROL_PLANE_API_KEY/);
});
