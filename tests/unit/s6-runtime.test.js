import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S6Runtime, S6_EXPECTED_TOOLS } from "../../scripts/s6-runtime.mjs";
import { S6_REPOSITORY_URL, S6_GOVERNANCE_HOOKS_PATH, S6_GOVERNANCE_POLICY_PATH } from "../../scripts/s6-github-broker.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s6-runtime-test-"));
const runtimeRoot = path.join(base, "runtime");
const managerRoot = path.join(base, "chatgpt-local-bridge-s6-manager");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("S6 runtime is fixed to the homelab source and exact 28-tool catalog", () => {
  const runtime = new S6Runtime({ runtimeRoot, managerRoot, platform: "linux", spawnSupervisor: false });
  assert.equal(runtime.runtimeKind(), "s6-runtime");
  assert.equal(runtime.source, undefined);
  assert.equal(S6_EXPECTED_TOOLS.length, 28);
  assert.deepEqual(runtime.expectedTools(), S6_EXPECTED_TOOLS);
  assert.deepEqual(runtime.policySummary(), {
    noLaunchAgent: true,
    fixedBranchPublishOnly: true,
    noArbitraryGitRemoteAuthority: true,
    noCodexRun: true,
    noNasOrDockerAuthorityInBridge: true,
  });
  assert.equal(runtime.policySummary().noPush, undefined);
  assert.deepEqual(runtime.readCatalogForCheck(), []);
  assert.throws(() => runtime.workspaceCreate("https://github.com/other/repo.git"), /fixed to the homelab repository/);
  assert.throws(() => runtime.workspacePrepareManualChat(), /does not use a local fixture source/);
  runtime.writeComposeOverride();
  const override = fs.readFileSync(runtime.overrideFile, "utf8");
  assert.match(override, new RegExp(`ENABLED_TOOLS: .*git_publish_branch`));
  assert.match(override, new RegExp(`BRIDGE_REVIEWED_HOOKS_PATH: ${escapeRegExp(S6_GOVERNANCE_HOOKS_PATH)}`));
  assert.match(override, new RegExp(`BRIDGE_REVIEWED_POLICY_PATH: ${escapeRegExp(S6_GOVERNANCE_POLICY_PATH)}`));
  assert.match(override, /S6_BROKER_SOCKET: \/transport\/s6-broker\.sock/);
  assert.doesNotMatch(override, /S6_BROKER_SOCKET_SOURCE|target: \/bridge-broker/, "Docker Desktop host socket binds must not be used");
  assert.doesNotMatch(override, /S6_BROKER_CAPABILITY|S6_GITHUB_TOKEN_FILE|GITHUB_TOKEN/);
  assert.deepEqual(runtime.readCatalogForCheck(), [...S6_EXPECTED_TOOLS]);
  assert.equal(S6_REPOSITORY_URL, "https://github.com/cardkazuma/homelab.git");
});

test("S6 broker proxy resource is controller-derived and credential-free", () => {
  const runtime = new S6Runtime({
    runtimeRoot: path.join(base, "broker-runtime"),
    managerRoot: path.join(base, "chatgpt-local-bridge-s6-broker-manager"),
    platform: "linux",
    spawnSupervisor: false,
  });
  const resources = runtime.makeResources();
  assert.equal(resources.brokerProxyName, `${resources.projectName}-broker-proxy`);
  assert.match(resources.brokerProxyName, /^s6-[a-z0-9]+-[0-9a-f]{12}-broker-proxy$/);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
