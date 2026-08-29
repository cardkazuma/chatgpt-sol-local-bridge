import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DisposableWorkspaceManager } from "./disposable-workspace.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarImage = "node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de";
const tunnelVersion = "0.0.13";
const tunnelCommit = "4b5267f823be0b046bb883aacb51603cfde3a0ea";
const tunnelLinuxBinarySha256 = "7a686d9e156dfe461d9751de6d0e7296c14040a4b3638f1b1527a2fa153e2196";
const tunnelLinuxAssetSha256 = "e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906";
const expectedTools = [
  "bridge_instructions", "workspace_list", "workspace_open", "workspace_tree", "workspace_snapshot",
  "read_file", "search_text", "write_file", "apply_patch", "edit_file", "git_status", "git_diff", "git_log",
  "git_branch_create", "git_branch_switch", "git_stage", "git_commit", "project_test", "project_lint",
  "project_typecheck", "project_build", "repo_shell", "process_start", "process_list", "process_logs",
  "process_stop", "health",
];
const disabledTools = [
  "git_run", "git_push", "git_fetch", "codex_run", "workspace_add_root", "confirm_destructive",
  "web_fetch", "dom_cdp", "nas", "docker", "ssh",
];

const tunnelId = process.env.S4_TUNNEL_ID || "";
const credentialFile = process.env.S4_CREDENTIAL_FILE || "";
const caBundle = process.env.S4_CA_BUNDLE || "";
const releaseDir = process.env.S4_TUNNEL_RELEASE_DIR || "";
const tunnelLinuxBinary = process.env.S4_TUNNEL_CLIENT_LINUX_BIN || path.join(releaseDir, "linux", "tunnel-client");
const tunnelLinuxAsset = process.env.S4_TUNNEL_CLIENT_LINUX_ASSET || path.join(releaseDir, "linux.zip");
const tunnelChecksums = process.env.S4_TUNNEL_CLIENT_CHECKSUMS || path.join(releaseDir, "SHA256SUMS.txt");
const tunnelProvenance = process.env.S4_TUNNEL_CLIENT_PROVENANCE || path.join(releaseDir, "provenance.sigstore.json");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s4-real-"));
const source = path.join(base, "source-repo");
const managerRoot = path.join(base, "manager");
const profileFile = path.join(base, "tunnel-profile.yaml");
const composeOverride = path.join(base, "compose.s4.yaml");
const projectName = `bridge-s4-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const bridgeName = `${projectName}-bridge`;
const relayName = `${projectName}-relay`;
const tunnelName = `${projectName}-tunnel`;
const volumeName = `${projectName}-transport`;
const privateNetworkName = `${projectName}-private`;
const egressNetworkName = `${projectName}-egress`;
const imageTag = `chatgpt-sol-local-bridge:s4-proof-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const relayToken = crypto.randomBytes(24).toString("hex");
const proofUid = typeof process.getuid === "function" ? process.getuid() : 501;
const proofGid = typeof process.getgid === "function" ? process.getgid() : proofUid;
const protectedPaths = [repo, path.resolve(repo, "..", "homelab"), path.resolve(repo, "..", "homelab-s3"), path.resolve(repo, "..", "homelab-s4")];
const governance = {
  hookFile: path.join(repo, ".githooks", "pre-commit"),
  policyFile: path.join(repo, "scripts", "pre-commit-policy.mjs"),
};

const dockerEnv = baseDockerEnv();
let composeEnv;
let manager;
let session;
let bridgeProcess;
let tunnelProcess;
let credentialRemoved = false;
let bridgeDigest;
let tunnelReadyCount = 0;

try {
  validateInputs();
  validateTunnelClient();
  prepareSource();
  writeProfile();
  writeComposeOverride();
  createDockerResources();

  manager = new DisposableWorkspaceManager({ root: managerRoot, source, governance, protectedPaths });
  session = manager.create();
  validateWorkspaceFixture(session.workspacePath);
  composeEnv = {
    ...dockerEnv,
    BRIDGE_WORKSPACE: session.workspacePath,
    BRIDGE_GIT_CONFIG: path.join(session.workspacePath, ".git", "config"),
    BRIDGE_GITHOOKS: path.join(session.workspacePath, ".githooks"),
    BRIDGE_POLICY_FILE: path.join(session.workspacePath, "scripts", "pre-commit-policy.mjs"),
    S4_IMAGE_TAG: imageTag,
    S4_TRANSPORT_VOLUME: volumeName,
  };

  runDocker(composeArgs(["config", "-q"]), composeEnv, { emptyOutput: true });
  runDocker(composeArgs(["build", "bridge"]), composeEnv);
  bridgeDigest = dockerImageDigest(imageTag);

  bridgeProcess = startProcess("docker", composeArgs(["run", "--no-deps", "--name", bridgeName, "bridge"]), composeEnv);
  await waitFor(() => containerRunning(bridgeName), "bridge container");
  await waitFor(() => socketReadyInContainer(bridgeName), "bridge Unix socket in managed volume", bridgeProcess);
  assertBridgeBoundary(dockerInspect(bridgeName));

  startRelay();
  await waitFor(() => relayReady(), "authenticated relay");
  assertRelayBoundary(dockerInspect(relayName));
  assert.equal(relayRequest({ mode: "missing", body: initializeBody(1) }).status, 401);
  assert.equal(relayRequest({ mode: "wrong", body: initializeBody(2) }).status, 401);
  assert.equal(relayRequest({ mode: "valid", body: "{" }).status, 400);
  assert.equal(relayRequest({ mode: "valid", body: initializeBody(3) }).status, 200);
  assert.equal(relayRequest({ mode: "valid", body: toolsListBody(4) }).status, 200);
  const localCatalog = extractTools(relayRequest({ mode: "valid", body: toolsListBody(5) }).body);
  assert.deepEqual(localCatalog, expectedTools);

  createTunnelContainer();
  assertTunnelBoundary(dockerInspect(tunnelName));
  await waitFor(() => relayNetworkReachable(), "private relay network path");
  tunnelProcess = startProcess("docker", ["start", "-a", tunnelName], dockerEnv);
  await waitFor(() => tunnelReady(tunnelName), "real OpenAI Secure MCP Tunnel readiness", tunnelProcess, 180_000);
  tunnelReadyCount += 1;
  runDocker(["exec", tunnelName, "/opt/tunnel-client", "doctor", "--profile-file", "/run/tunnel/profile.yaml", "--explain"], dockerEnv);

  assertBridgeProcessCredentialIsolation();
  console.log(JSON.stringify({
    phase: "real-tunnel-ready",
    pass: true,
    tunnel: redactIdentifier(tunnelId),
    tunnelClient: {
      version: tunnelVersion,
      sourceCommit: tunnelCommit,
      linuxBinarySha256: tunnelLinuxBinarySha256,
      linuxReleaseAssetSha256: tunnelLinuxAssetSha256,
    },
    bridgeImageDigest: bridgeDigest,
    transport: {
      endpoint: "Docker-managed volume /transport/mcp.sock",
      bridgeNetwork: "none",
      relayNetwork: "internal-only",
      tunnelNetworks: "internal relay network + separate egress network",
      hostPublishedPorts: false,
      hostSameUidSocketAccess: false,
    },
    localCatalog,
    disabledToolsAbsent: disabledTools,
    credentialPlane: {
      runtimeKey: "tunnel-client container only",
      relayBearer: "relay and tunnel-client only",
      bridgeAndChildren: "absent",
    },
    instructions: "Run the bounded ChatGPT workspace proof, then press Enter in this terminal to continue restart and cleanup checks.",
  }, null, 2));
  await waitForReviewConfirmation();
  const chatgptProof = verifyChatGptFixture(session.workspacePath);

  await assertBridgeRestartAndWorkspaceRetention(session.workspacePath);
  await assertTunnelReconnect();

  console.log(JSON.stringify({
    phase: "s4-proof-complete",
    pass: true,
    tunnel: redactIdentifier(tunnelId),
    tunnelReadyCount,
    chatgptProof,
    localCatalog: expectedTools,
    cleanup: "will run in finally",
  }, null, 2));
} finally {
  await cleanup();
}

function validateInputs() {
  assert(/^tunnel_[A-Za-z0-9_-]+$/.test(tunnelId), "S4_TUNNEL_ID must be a tunnel_ identifier supplied locally");
  assert(credentialFile, "S4_CREDENTIAL_FILE must point to a temporary 0600 env file");
  assert(caBundle, "S4_CA_BUNDLE must point to the temporary host trust bundle");
  assert(!process.env.CONTROL_PLANE_API_KEY, "CONTROL_PLANE_API_KEY must not be present in the proof harness environment");
  assert(!process.env.OPENAI_API_KEY, "OPENAI_API_KEY must not be present in the proof harness environment");
  const resolved = fs.realpathSync(credentialFile);
  const stat = fs.statSync(resolved);
  assert(stat.isFile(), "S4_CREDENTIAL_FILE must be a regular file");
  assert.equal(stat.mode & 0o077, 0, "S4_CREDENTIAL_FILE must not be group/world accessible");
  if (typeof process.getuid === "function") assert.equal(stat.uid, process.getuid(), "S4_CREDENTIAL_FILE must be owned by the invoking user");
  assert(isWithin(resolved, fs.realpathSync(os.tmpdir())), "S4_CREDENTIAL_FILE must be under the OS temporary directory");
  const lines = fs.readFileSync(resolved, "utf8").split(/\n/);
  if (lines.at(-1) === "") lines.pop();
  assert.equal(lines.length, 1, "S4_CREDENTIAL_FILE must contain exactly one env assignment");
  const separator = lines[0].indexOf("=");
  assert.equal(lines[0].slice(0, separator), "CONTROL_PLANE_API_KEY", "S4_CREDENTIAL_FILE has an unexpected key name");
  assert(separator > 0 && lines[0].slice(separator + 1).length > 0, "S4_CREDENTIAL_FILE contains an empty runtime key");
  assert(!/[\r\0]/.test(lines[0].slice(separator + 1)), "runtime key contains an unsupported control character");
  const resolvedCa = fs.realpathSync(caBundle);
  const caStat = fs.statSync(resolvedCa);
  assert(caStat.isFile(), "S4_CA_BUNDLE must be a regular file");
  assert.equal(caStat.mode & 0o077, 0, "S4_CA_BUNDLE must not be group/world accessible");
  assert(isWithin(resolvedCa, fs.realpathSync(os.tmpdir())), "S4_CA_BUNDLE must be under the OS temporary directory");
}

function validateTunnelClient() {
  assert(fs.statSync(tunnelLinuxBinary).isFile(), "Linux tunnel-client binary is missing");
  assert.equal(sha256(tunnelLinuxBinary), tunnelLinuxBinarySha256, "Linux tunnel-client binary hash mismatch");
  assert(fs.statSync(tunnelLinuxAsset).isFile(), "Linux tunnel-client release asset is missing");
  assert.equal(sha256(tunnelLinuxAsset), tunnelLinuxAssetSha256, "Linux tunnel-client release asset hash mismatch");
  const checksums = fs.readFileSync(tunnelChecksums, "utf8");
  assert.match(checksums, new RegExp(`${tunnelLinuxAssetSha256}\\s+.*tunnel-client-v${tunnelVersion}-linux-amd64\\.zip`));
  const provenance = JSON.parse(fs.readFileSync(tunnelProvenance, "utf8"));
  assert(provenance && typeof provenance === "object", "tunnel-client provenance bundle is invalid");
  const help = runDocker([
    "run", "--rm", "--platform", "linux/amd64", "--user", "10001:10001",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--network", "none", "--mount", `type=bind,src=${tunnelLinuxBinary},dst=/opt/tunnel-client,readonly`,
    "--entrypoint", "/opt/tunnel-client", sidecarImage, "run", "--help",
  ], dockerEnv);
  assert.match(help.output, new RegExp(`run version ${tunnelVersion}\\+${tunnelCommit}`));
}

function prepareSource() {
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  writeSource(".gitignore", [".env", "db.env", ".storage/", "runtime/", "backups/", "*.log", "*.db"].join("\n") + "\n");
  writeSource("README.md", "S4 disposable ChatGPT fixture\nMarker: S4_DISPOSABLE_MARKER\n");
  writeSource("package.json", JSON.stringify({
    name: "s4-chatgpt-fixture",
    version: "1.0.0",
    type: "module",
    scripts: { test: "node --test test/fixture.test.mjs" },
  }, null, 2) + "\n");
  writeSource("test/fixture.test.mjs", [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('S4 disposable fixture is healthy', () => assert.equal('S4_DISPOSABLE_MARKER'.startsWith('S4_'), true));",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(source, ".githooks"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true, mode: 0o700 });
  fs.copyFileSync(governance.hookFile, path.join(source, ".githooks", "pre-commit"));
  fs.copyFileSync(governance.policyFile, path.join(source, "scripts", "pre-commit-policy.mjs"));
  fs.chmodSync(path.join(source, ".githooks", "pre-commit"), 0o755);
  writeSource(".env", "fixture-only\n");
  writeSource("db.env", "fixture-only\n");
  writeSource("fixture.log", "fixture-only\n");
  writeSource("runtime/state.json", "fixture-only\n");
  writeSource(".storage/token", "fixture-only\n");
  writeSource("backups/archive.db", "fixture-only\n");
  const env = sourceGitEnv();
  git(["init", "-q", "-b", "main"], source, env);
  git(["config", "core.hooksPath", "/dev/null"], source, env);
  git(["config", "user.name", "S4 Fixture"], source, env);
  git(["config", "user.email", "s4-fixture@example.invalid"], source, env);
  git(["add", ".gitignore", "README.md", "package.json", "test/fixture.test.mjs", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs"], source, env);
  git(["commit", "-qm", "S4 fixture baseline"], source, env);
  writeSource("README.md", "S4 disposable ChatGPT fixture with history\nMarker: S4_DISPOSABLE_MARKER\n");
  git(["add", "README.md"], source, env);
  git(["commit", "-qm", "S4 fixture second commit"], source, env);
}

function validateWorkspaceFixture(workspacePath) {
  assert.equal(fs.existsSync(path.join(workspacePath, ".env")), false);
  assert.equal(fs.existsSync(path.join(workspacePath, "db.env")), false);
  assert.equal(fs.existsSync(path.join(workspacePath, ".storage")), false);
  assert.equal(fs.existsSync(path.join(workspacePath, "runtime")), false);
  assert.equal(fs.existsSync(path.join(workspacePath, "backups")), false);
  assert.equal(Number(git(["rev-list", "--all", "--count"], workspacePath, sessionGitEnv(workspacePath)).trim()), 2);
  assert.equal(git(["rev-parse", "--is-shallow-repository"], workspacePath, sessionGitEnv(workspacePath)).trim(), "false");
}

function writeProfile() {
  fs.writeFileSync(profileFile, [
    "config_version: 1",
    "control_plane:",
    "  base_url: \"https://api.openai.com\"",
    `  tunnel_id: "${tunnelId}"`,
    "  api_key: \"env:CONTROL_PLANE_API_KEY\"",
    "health:",
    "  listen_addr: \"127.0.0.1:8080\"",
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    "      url: \"http://relay:8081/mcp\"",
    "  extra_headers:",
    "    Authorization: \"env:S4_RELAY_AUTH_HEADER\"",
    "  discovery_extra_headers:",
    "    Authorization: \"env:S4_RELAY_AUTH_HEADER\"",
    "",
  ].join("\n"), { mode: 0o644 });
}

function writeComposeOverride() {
  fs.writeFileSync(composeOverride, [
    "services:",
    "  bridge:",
    `    image: \${S4_IMAGE_TAG:?set S4_IMAGE_TAG to a unique proof tag}`,
    "    environment:",
    "      MCP_UNIX_SOCKET_PATH: /transport/mcp.sock",
    "    volumes:",
    "      - type: volume",
    "        source: s4_transport",
    "        target: /transport",
    "        read_only: false",
    "volumes:",
    "  s4_transport:",
    `    name: \${S4_TRANSPORT_VOLUME:?set S4_TRANSPORT_VOLUME to a unique proof volume}`,
    "",
  ].join("\n"), { mode: 0o600 });
}

function createDockerResources() {
  runDocker(["volume", "create", "--name", volumeName], dockerEnv);
  runDocker([
    "run", "--rm", "--platform", "linux/amd64", "--user", "0:0", "--read-only", "--cap-drop", "ALL",
    "--cap-add", "CHOWN", "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges:true", "--network", "none", "--mount", `type=volume,src=${volumeName},dst=/transport`,
    "--entrypoint", "/bin/sh", sidecarImage, "-c", "chown 10001:10001 /transport && chmod 0700 /transport",
  ], dockerEnv);
  runDocker(["network", "create", "--internal", privateNetworkName], dockerEnv);
  runDocker(["network", "create", egressNetworkName], dockerEnv);
}

function startRelay() {
  runDocker([
    "run", "-d", "--name", relayName, "--platform", "linux/amd64", "--user", "10001:10001", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "128m",
    "--network", privateNetworkName, "--network-alias", "relay", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=1777",
    "--mount", `type=volume,src=${volumeName},dst=/transport,readonly`,
    "--mount", `type=bind,src=${path.join(repo, "scripts", "s3-local-relay.mjs")},dst=/opt/relay.mjs,readonly`,
    "--env", "S3_BRIDGE_SOCKET=/transport/mcp.sock", "--env", "S3_RELAY_HOST=0.0.0.0", "--env", "S3_RELAY_PORT=8081", "--env", "S4_RELAY_INTERNAL=true",
    "--env", `S3_RELAY_TOKEN=${relayToken}`, sidecarImage, "node", "/opt/relay.mjs",
  ], dockerEnv);
}

function createTunnelContainer() {
  validateCredentialFileStillPresent();
  runDocker([
    "create", "--name", tunnelName, "--platform", "linux/amd64", "--user", `${proofUid}:${proofGid}`, "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "96", "--memory", "256m",
    "--network", egressNetworkName, "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=32m,uid=${proofUid},gid=${proofGid},mode=1777`,
    "--tmpfs", `/home/tunnel:rw,noexec,nosuid,nodev,size=32m,uid=${proofUid},gid=${proofGid},mode=700`,
    "--mount", `type=bind,src=${tunnelLinuxBinary},dst=/opt/tunnel-client,readonly`,
    "--mount", `type=bind,src=${profileFile},dst=/run/tunnel/profile.yaml,readonly`,
    "--mount", `type=bind,src=${caBundle},dst=/run/tunnel/macos-system-roots.pem,readonly`,
    "--env-file", credentialFile, "--env", "HOME=/home/tunnel", "--env", "TMPDIR=/tmp",
    "--env", "SSL_CERT_FILE=/run/tunnel/macos-system-roots.pem",
    "--env", `S4_RELAY_AUTH_HEADER=Bearer ${relayToken}`,
    sidecarImage, "/opt/tunnel-client", "run", "--profile-file", "/run/tunnel/profile.yaml",
    "--log.format", "json", "--log.level", "info",
  ], dockerEnv);
  fs.rmSync(credentialFile, { force: true });
  credentialRemoved = true;
  runDocker(["network", "connect", privateNetworkName, tunnelName], dockerEnv);
}

function assertBridgeBoundary(value) {
  assert.equal(value.State.Running, true);
  assert.equal(value.Config.User, "10001:10001");
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.NetworkMode, "none");
  assert.equal(value.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(value.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(value.HostConfig.PidsLimit, 128);
  assert.equal(value.HostConfig.Privileged, false);
  assert((value.HostConfig.CapDrop || []).includes("ALL"));
  assert((value.HostConfig.SecurityOpt || []).includes("no-new-privileges:true"));
  assert.equal(Boolean(value.HostConfig.PortBindings && Object.keys(value.HostConfig.PortBindings).length), false);
  assert.notEqual(value.HostConfig.PidMode, "host");
  assert.notEqual(value.HostConfig.IpcMode, "host");
  assert.equal((value.HostConfig.Devices || []).length, 0);
  const mounts = value.Mounts || [];
  const transport = mounts.find((mount) => mount.Destination === "/transport");
  assert(transport);
  assert.equal(transport.Type, "volume");
  assert.equal(transport.Name, volumeName);
  assert.equal(transport.RW, true);
  assert.equal(mounts.filter((mount) => mount.Type === "volume").length, 1);
  assert.equal(mounts.filter((mount) => mount.Type === "bind").length, 4);
  assertNoCredentialEnv(value.Config.Env || [], { allowRelayToken: false });
  assert.deepEqual(Object.keys(value.NetworkSettings?.Networks || {}), ["none"]);
  assert.equal(hostCanAccessVolumeSocket(), false, "same-UID host process can access the managed transport socket");
}

function assertRelayBoundary(value) {
  assert.equal(value.State.Running, true);
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.PortBindings && Object.keys(value.HostConfig.PortBindings).length, 0);
  assert.equal((value.HostConfig.CapDrop || []).includes("ALL"), true);
  assert.equal(value.HostConfig.NetworkMode, privateNetworkName);
  const mounts = value.Mounts || [];
  const transport = mounts.find((mount) => mount.Destination === "/transport");
  assert(transport);
  assert.equal(transport.Type, "volume");
  assert.equal(transport.Name, volumeName);
  assert.equal(transport.RW, false);
  assert.equal(mounts.some((mount) => mount.Source.includes("/workspace") || mount.Source.includes("manager")), false);
  assertNoCredentialEnv(value.Config.Env || [], { allowRelayToken: true });
  assert((value.NetworkSettings?.Networks?.[privateNetworkName]?.Aliases || []).includes("relay"));
}

function assertTunnelBoundary(value) {
  assert.equal(value.State.Status, "created");
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.PortBindings && Object.keys(value.HostConfig.PortBindings).length, 0);
  assert.equal((value.HostConfig.CapDrop || []).includes("ALL"), true);
  assert.equal((value.Mounts || []).some((mount) => mount.Type === "volume"), false);
  assert.equal((value.Mounts || []).some((mount) => mount.Destination === "/workspace/repo" || mount.Destination === "/transport"), false);
  assert.equal((value.Mounts || []).filter((mount) => mount.Destination === "/run/tunnel/macos-system-roots.pem").length, 1);
  assert((value.Config.Env || []).some((entry) => entry === "SSL_CERT_FILE=/run/tunnel/macos-system-roots.pem"));
  assert((value.Config.Env || []).some((entry) => entry.startsWith("CONTROL_PLANE_API_KEY=")));
  assert((value.Config.Env || []).some((entry) => entry.startsWith("S4_RELAY_AUTH_HEADER=")));
  assert.equal((value.NetworkSettings?.Networks?.[privateNetworkName] != null), true);
  assert.equal((value.NetworkSettings?.Networks?.[privateNetworkName]?.Aliases || []).includes("relay"), false);
  assert.equal((value.NetworkSettings?.Networks?.[egressNetworkName] != null), true);
}

function assertNoCredentialEnv(entries, { allowRelayToken }) {
  for (const entry of entries) {
    const name = entry.split("=", 1)[0];
    assert.equal(name === "CONTROL_PLANE_API_KEY" || name === "OPENAI_API_KEY", false, `OpenAI key entered a non-tunnel container: ${name}`);
    if (!allowRelayToken) assert.equal(name === "S3_RELAY_TOKEN" || name === "S4_RELAY_TOKEN" || name === "S4_RELAY_AUTH_HEADER", false, `relay credential entered the bridge: ${name}`);
  }
}

function assertBridgeProcessCredentialIsolation() {
  const probe = "if env | grep -E '^(CONTROL_PLANE_API_KEY|OPENAI_API_KEY|S3_RELAY_TOKEN|S4_RELAY_TOKEN|S4_RELAY_AUTH_HEADER)=' >/dev/null; then exit 11; fi; if tr '\\0' '\\n' </proc/1/environ | grep -E '^(CONTROL_PLANE_API_KEY|OPENAI_API_KEY|S3_RELAY_TOKEN|S4_RELAY_TOKEN|S4_RELAY_AUTH_HEADER)=' >/dev/null; then exit 12; fi; test ! -e /var/run/docker.sock; test ! -e /Volumes; test ! -e /volume1/docker; test ! -e /Users";
  runDocker(["exec", bridgeName, "/bin/sh", "-c", probe], dockerEnv);
}

async function assertBridgeRestartAndWorkspaceRetention(workspacePath) {
  runDocker(["stop", "-t", "5", bridgeName], dockerEnv);
  await waitFor(() => !containerRunning(bridgeName), "bridge stop");
  await waitFor(() => !socketReadyInRelay(), "managed socket removal after bridge stop");
  assert.equal(relayRequest({ mode: "valid", body: initializeBody(20) }).status, 502);
  runDockerQuiet(["rm", "-f", bridgeName]);
  await stopAttached(bridgeProcess);
  bridgeProcess = null;
  bridgeProcess = startProcess("docker", composeArgs(["run", "--no-deps", "--name", bridgeName, "bridge"]), composeEnv);
  await waitFor(() => containerRunning(bridgeName), "bridge restart");
  await waitFor(() => socketReadyInContainer(bridgeName), "bridge Unix socket after restart", bridgeProcess);
  assertBridgeBoundary(dockerInspect(bridgeName));
  assert.equal(relayRequest({ mode: "valid", body: initializeBody(21) }).status, 200);
  const restartedCatalog = extractTools(relayRequest({ mode: "valid", body: toolsListBody(22) }).body);
  assert.deepEqual(restartedCatalog, expectedTools);
  const readResponse = relayRequest({ mode: "valid", body: callToolBody(23, "read_file", { path: "/workspace/repo/README.md" }) });
  assert.equal(readResponse.status, 200);
  assert.match(readResponse.body, /S4 disposable ChatGPT fixture/);
  assert.equal(fs.existsSync(path.join(workspacePath, "chatgpt-s4-proof.txt")), true);
}

async function assertTunnelReconnect() {
  runDocker(["stop", "-t", "5", tunnelName], dockerEnv);
  await waitFor(() => !containerRunning(tunnelName), "tunnel-client termination");
  await waitFor(() => tunnelProcess?.exitCode != null, "attached tunnel-client termination");
  tunnelProcess = startProcess("docker", ["start", "-a", tunnelName], dockerEnv);
  await waitFor(() => tunnelReady(tunnelName), "tunnel-client reconnect", tunnelProcess, 180_000);
  tunnelReadyCount += 1;
}

function verifyChatGptFixture(workspacePath) {
  const target = path.join(workspacePath, "chatgpt-s4-proof.txt");
  const stat = fs.lstatSync(target);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(fs.readFileSync(target, "utf8"), "S4 ChatGPT proof complete\n");
  const ignored = run("git", ["check-ignore", "--quiet", "--", "chatgpt-s4-proof.txt"], sessionGitEnv(workspacePath), workspacePath);
  assert.equal(ignored.status, 1, "ChatGPT proof file was unexpectedly ignored");
  const status = git(["status", "--porcelain", "--untracked-files=all"], workspacePath, sessionGitEnv(workspacePath)).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(status.length, 1);
  assert.match(status[0], /chatgpt-s4-proof\.txt$/);
  return { file: "chatgpt-s4-proof.txt", exactContent: true, onlyWorkspaceChange: true };
}

function waitForReviewConfirmation() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

function socketReadyInContainer(name) {
  const result = run("docker", ["exec", name, "/bin/sh", "-c", "test -S /transport/mcp.sock"], dockerEnv);
  return result.status === 0;
}

function socketReadyInRelay() {
  const result = run("docker", ["exec", relayName, "/bin/sh", "-c", "test -S /transport/mcp.sock"], dockerEnv);
  return result.status === 0;
}

function tunnelReady(name) {
  if (!containerRunning(name)) return false;
  const probe = "const r=await fetch('http://127.0.0.1:8080/readyz'); const b=await r.json(); process.stdout.write(JSON.stringify({status:r.status,ready:b.ready===true})); if (r.status !== 200 || b.ready !== true) process.exit(3);";
  const result = run("docker", ["exec", name, "node", "--input-type=module", "-e", probe], dockerEnv);
  return result.status === 0;
}

function relayReady() {
  if (!containerRunning(relayName)) return false;
  return relayRequest({ mode: "missing", body: initializeBody(10) }).status === 401;
}

function relayNetworkReachable() {
  const script = "const r=await fetch('http://relay:8081/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); process.exit(r.status === 401 ? 0 : 1);";
  const result = run("docker", [
    "run", "--rm", "--platform", "linux/amd64", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--network", privateNetworkName,
    "--entrypoint", "node", sidecarImage, "--input-type=module", "-e", script,
  ], dockerEnv);
  return result.status === 0;
}

function relayRequest({ mode, body }) {
  const script = `import http from "node:http";
const mode = process.env.S4_PROBE_MODE;
const payload = ${JSON.stringify(body)};
const headers = { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
if (mode === "valid") headers.authorization = "Bearer " + process.env.S3_RELAY_TOKEN;
if (mode === "wrong") headers.authorization = "Bearer wrong-proof-token";
const q = http.request({ host: "127.0.0.1", port: 8081, path: "/mcp", method: "POST", headers }, r => { let b = ""; r.on("data", x => b += x); r.on("end", () => process.stdout.write(JSON.stringify({ status: r.statusCode, body: b }))); });
q.on("error", e => { process.stdout.write(JSON.stringify({ status: 599, body: e.code || e.message })); process.exitCode = 0; });
q.end(payload);`;
  const result = run("docker", ["exec", "-e", `S4_PROBE_MODE=${mode}`, relayName, "node", "--input-type=module", "-e", script], dockerEnv);
  assert.equal(result.status, 0, sanitize(result.output));
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function extractTools(body) {
  const candidates = [];
  for (const line of String(body).split(/\r?\n/)) {
    const value = line.startsWith("data: ") ? line.slice(6) : line;
    try { candidates.push(JSON.parse(value)); } catch {}
  }
  const found = candidates.find((item) => Array.isArray(item?.result?.tools));
  assert(found, `tools/list response did not contain a result: ${sanitize(body)}`);
  return found.result.tools.map((tool) => tool.name);
}

function validateCredentialFileStillPresent() {
  assert.equal(credentialRemoved, false);
  assert(fs.existsSync(credentialFile), "temporary runtime credential disappeared before Docker create");
}

function startProcess(command, args, env) {
  const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.output = () => {
    const output = `${stdout}${stderr}`;
    if (/401|403|unauthori[sz]ed|permission|forbidden/i.test(output)) return "redacted authentication/authorization failure";
    return "no tunnel diagnostic output retained";
  };
  return child;
}

async function waitFor(predicate, label, child = null, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child?.exitCode != null) throw new Error(`${label} failed because the process exited ${child.exitCode}: ${child.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}${child ? `: ${child.output()}` : ""}`);
}

async function cleanup() {
  const cleanupFailures = [];
  if (credentialFile && !credentialRemoved) {
    fs.rmSync(credentialFile, { force: true });
    credentialRemoved = true;
  }
  await stopAttached(tunnelProcess);
  tunnelProcess = null;
  runDockerQuiet(["rm", "-f", tunnelName]);
  runDockerQuiet(["rm", "-f", relayName]);
  await stopAttached(bridgeProcess);
  bridgeProcess = null;
  runDockerQuiet(["rm", "-f", bridgeName]);
  runDockerQuiet(["volume", "rm", "-f", volumeName]);
  runDockerQuiet(["network", "rm", privateNetworkName, egressNetworkName]);
  runDockerQuiet(["image", "rm", "-f", imageTag]);
  if (manager && session) {
    try { manager.destroy(session.sessionId); } catch {}
  }
  if (credentialFile && fs.existsSync(credentialFile)) cleanupFailures.push("temporary credential file");
  for (const [kind, name] of [
    ["container", tunnelName],
    ["container", relayName],
    ["container", bridgeName],
    ["volume", volumeName],
    ["network", privateNetworkName],
    ["network", egressNetworkName],
    ["image", imageTag],
  ]) {
    if (dockerResourceExists(kind, name)) cleanupFailures.push(`${kind} ${name}`);
  }
  if (session && (fs.existsSync(session.workspacePath) || fs.existsSync(session.statePath))) {
    cleanupFailures.push("disposable workspace or manager state");
  }
  fs.rmSync(base, { recursive: true, force: true });
  if (fs.existsSync(base)) cleanupFailures.push("temporary proof root");
  if (cleanupFailures.length) throw new Error(`S4 cleanup incomplete: ${cleanupFailures.join(", ")}`);
  console.log(JSON.stringify({
    phase: "s4-cleanup",
    pass: true,
    temporaryCredentialFileRemoved: true,
    disposableWorkspaceRemoved: true,
    dockerProofResourcesRemoved: true,
    proofRootRemoved: true,
  }, null, 2));
}

async function stopAttached(child) {
  if (!child || child.exitCode != null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

function containerRunning(name) {
  const result = run("docker", ["inspect", "--format", "{{.State.Running}}", name], dockerEnv);
  return result.status === 0 && result.stdout.trim() === "true";
}

function dockerInspect(name) {
  const result = run("docker", ["inspect", name], dockerEnv);
  assert.equal(result.status, 0, sanitize(result.output));
  return JSON.parse(result.stdout)[0];
}

function hostCanAccessVolumeSocket() {
  const result = run("docker", ["volume", "inspect", "--format", "{{.Mountpoint}}", volumeName], dockerEnv);
  assert.equal(result.status, 0, sanitize(result.output));
  const mountpoint = result.stdout.trim();
  assert(path.isAbsolute(mountpoint));
  assert.notEqual(mountpoint, path.parse(mountpoint).root);
  assert(mountpoint.includes(volumeName));
  try {
    fs.accessSync(path.join(mountpoint, "mcp.sock"), fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function dockerImageDigest(tag) {
  const result = run("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", tag], dockerEnv);
  assert.equal(result.status, 0, sanitize(result.output));
  return result.stdout.trim() || null;
}

function runDocker(args, env, { emptyOutput = false } = {}) {
  const resolvedArgs = args;
  const result = run("docker", resolvedArgs, env);
  const displayArgs = resolvedArgs.map((arg) => /^(?:S3_RELAY_TOKEN|S4_RELAY_AUTH_HEADER)=/.test(arg) ? `${arg.split("=", 1)[0]}=<redacted>` : arg);
  assert.equal(result.status, 0, `docker ${displayArgs.join(" ")} failed: ${sanitize(result.output)}`);
  if (emptyOutput) assert.equal(result.output.trim(), "", `docker ${displayArgs.join(" ")} emitted output: ${sanitize(result.output)}`);
  return result;
}

function runDockerQuiet(args) {
  spawnSync("docker", args, { cwd: repo, env: dockerEnv, encoding: "utf8", stdio: "ignore" });
}

function dockerResourceExists(kind, name) {
  const command = kind === "image" ? ["image", "inspect", name] : [kind, "inspect", name];
  const result = spawnSync("docker", command, { cwd: repo, env: dockerEnv, encoding: "utf8", stdio: "ignore" });
  return result.status === 0;
}

function run(command, args, env = dockerEnv, cwd = repo) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ...result, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function composeArgs(args) {
  return ["compose", "-p", projectName, "-f", "compose.yaml", "-f", composeOverride, ...args];
}

function baseDockerEnv() {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: path.join(base, "tmp"),
    LANG: "C",
    LC_ALL: "C",
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) if (process.env[name]) env[name] = process.env[name];
  return env;
}

function sourceGitEnv() {
  return {
    ...dockerEnv,
    HOME: path.join(base, "source-home"),
    XDG_CONFIG_HOME: path.join(base, "source-home", "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function sessionGitEnv(workspacePath) {
  return {
    ...dockerEnv,
    HOME: path.join(path.dirname(path.dirname(workspacePath)), "git-home"),
    XDG_CONFIG_HOME: path.join(path.dirname(path.dirname(workspacePath)), "git-home", "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(args, cwd, env) {
  const result = run("git", args, env, cwd);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${sanitize(result.output)}`);
  return result.stdout || "";
}

function writeSource(relative, content) {
  const target = path.join(source, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

function initializeBody(id) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s4-real-tunnel-proof", version: "1.0.0" } },
  });
}

function toolsListBody(id) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
}

function callToolBody(id, name, args) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

function redactIdentifier(value) {
  const text = String(value);
  return text.length <= 8 ? "<redacted>" : `${text.slice(0, 7)}…${text.slice(-4)}`;
}

function sanitize(value) {
  return String(value)
    .replace(/Bearer\\s+\\S+/gi, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>")
    .replace(/CONTROL_PLANE_API_KEY=\\S+/g, "CONTROL_PLANE_API_KEY=<redacted>")
    .replace(new RegExp(relayToken, "g"), "<redacted>");
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
