import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DisposableWorkspaceManager } from "./disposable-workspace.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tunnelClient = process.env.TUNNEL_CLIENT_BIN;
const tunnelAsset = process.env.TUNNEL_CLIENT_ASSET;
const tunnelChecksums = process.env.TUNNEL_CLIENT_CHECKSUMS;
const tunnelProvenance = process.env.TUNNEL_CLIENT_PROVENANCE;
const tunnelLinuxBinary = process.env.TUNNEL_CLIENT_LINUX_BIN;
const tunnelLinuxAsset = process.env.TUNNEL_CLIENT_LINUX_ASSET;
const tunnelLinuxChecksums = process.env.TUNNEL_CLIENT_LINUX_CHECKSUMS || tunnelChecksums;
const tunnelVersion = "0.0.13";
const tunnelCommit = "4b5267f823be0b046bb883aacb51603cfde3a0ea";
const tunnelAssetSha256 = "c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c";
const tunnelBinarySha256 = "c5d1ab3ccf3aa402f631e2fac66c763fa0b1b82e6134e995c9a44bc6a06fb93c";
const tunnelLinuxAssetSha256 = "e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906";
const tunnelLinuxBinarySha256 = "7a686d9e156dfe461d9751de6d0e7296c14040a4b3638f1b1527a2fa153e2196";
// macOS AF_UNIX paths are short; keep this dedicated proof root under /tmp so
// the socket path remains below the platform limit.
const base = fs.mkdtempSync(path.join("/tmp", "bridge-s3-transport-"));
const source = path.join(base, "source-repo");
const sourceHome = path.join(base, "source-home");
const managerRoot = path.join(base, "manager");
const transportDir = path.join(base, "bridge-transport");
const relayDir = path.join(base, "relay");
const tunnelProfile = path.join(relayDir, "profile.yaml");
const workspace = "/workspace/repo";
const bridgeSocket = path.join(transportDir, "mcp.sock");
const composeOverride = path.join(base, "compose.s3.yaml");
const projectName = `bridge-s3-${process.pid}`;
const containerName = `bridge-s3-transport-${process.pid}`;
const imageTag = `chatgpt-sol-local-bridge:s3-proof-${process.pid}`;
const sidecarImage = "node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de";
const localToken = crypto.randomBytes(24).toString("hex");
const proofUid = typeof process.getuid === "function" ? process.getuid() : 501;
const proofGid = typeof process.getgid === "function" ? process.getgid() : proofUid;
const protectedPaths = [repo, path.resolve(repo, "..", "homelab"), path.resolve(repo, "..", "homelab-s3")];
const governance = {
  hookFile: path.join(repo, ".githooks", "pre-commit"),
  policyFile: path.join(repo, "scripts", "pre-commit-policy.mjs"),
};

let bridgeProcess;
let proxyProcess;
let sidecarName;
let sidecarGeneration = 0;
let client;
let manager;
let session;
let imageDigest = null;

try {
  assert(tunnelClient, "TUNNEL_CLIENT_BIN must point to the tested tunnel-client binary");
  validateTunnelClient();
  prepareSource();
  writeComposeOverride();
  manager = new DisposableWorkspaceManager({ root: managerRoot, source, governance, protectedPaths });
  session = manager.create();
  validateWorkspaceFixture(session.workspacePath);

  const composeEnv = dockerEnv({
    BRIDGE_WORKSPACE: session.workspacePath,
    BRIDGE_GIT_CONFIG: path.join(session.workspacePath, ".git", "config"),
    BRIDGE_GITHOOKS: path.join(session.workspacePath, ".githooks"),
    BRIDGE_POLICY_FILE: path.join(session.workspacePath, "scripts", "pre-commit-policy.mjs"),
    BRIDGE_TRANSPORT_DIR: transportDir,
    S3_IMAGE_TAG: imageTag,
  });
  runDocker(["compose", "-p", projectName, "-f", "compose.yaml", "-f", composeOverride, "config", "-q"], composeEnv, { emptyOutput: true });
  runDocker(["compose", "-p", projectName, "-f", "compose.yaml", "-f", composeOverride, "build", "bridge"], composeEnv);
  imageDigest = dockerImageDigest(imageTag);

  bridgeProcess = startProcess("docker", ["compose", "-p", projectName, "-f", "compose.yaml", "-f", composeOverride, "run", "--no-deps", "--name", containerName, "bridge"], composeEnv);
  await waitFor(() => isSocket(bridgeSocket), "bridge Unix socket", bridgeProcess);
  const initialInspect = dockerInspect(containerName);
  assertContainerBoundary(initialInspect);
  assert.equal((fs.statSync(transportDir).mode & 0o077), 0, "transport directory is not private");
  assert.equal(fs.statSync(bridgeSocket).isSocket(), true, "bridge transport path is not a Unix socket");

  const first = await connectThroughTunnel();
  client = first.client;
  await assertSidecarRelayAuthentication();
  assert.equal(assertDirectUnixSocketResidual(), 200, "private socket residual was not measured");
  await assertTransportBehavior(client, session.workspacePath);
  await client.close();
  client = null;
  await stopTunnelSidecar();
  assert.equal(await canConnect(first.url), false, "disconnected tunnel ingress still accepted a request");

  const reconnected = await connectThroughTunnel();
  client = reconnected.client;
  assertMcpOk(await client.callTool({ name: "read_file", arguments: { path: `${workspace}/transport-marker.txt` } }));
  await client.close();
  client = null;

  runDocker(["stop", "-t", "5", containerName], composeEnv);
  await waitFor(() => !fs.existsSync(bridgeSocket), "bridge socket cleanup after restart");
  const unavailable = sidecarRequest(initializeBody(4));
  assert.equal(unavailable.status, 502, `relay did not report bridge disconnect: ${unavailable.status}`);
  await stopTunnelSidecar();
  await stopProcess(bridgeProcess);
  bridgeProcess = null;
  runDocker(["rm", "-f", containerName], composeEnv);
  bridgeProcess = startProcess("docker", ["compose", "-p", projectName, "-f", "compose.yaml", "-f", composeOverride, "run", "--no-deps", "--name", containerName, "bridge"], composeEnv);
  await waitFor(() => isSocket(bridgeSocket), "bridge Unix socket after restart", bridgeProcess);
  assertContainerBoundary(dockerInspect(containerName));

  const afterRestart = await connectThroughTunnel();
  client = afterRestart.client;
  assertMcpOk(await client.callTool({ name: "read_file", arguments: { path: `${workspace}/transport-marker.txt` } }));
  const finalShell = assertMcpOk(await client.callTool({ name: "repo_shell", arguments: { cwd: workspace, command: isolationCommand() } }));
  assertNoCredentialMaterial(finalShell);

  console.log(JSON.stringify({
    proof: "s3-transport-authentication-and-reconnect",
    pass: true,
    tunnelClient: {
      release: `v${tunnelVersion}`,
      sourceCommit: tunnelCommit,
      binarySha256: tunnelBinarySha256,
      releaseAssetSha256: tunnelAssetSha256,
      linuxBinarySha256: tunnelLinuxBinarySha256,
      linuxReleaseAssetSha256: tunnelLinuxAssetSha256,
      imageDigest,
      localProxyMode: "dev proxy; in-memory control plane, not OpenAI control-plane evidence",
    },
    architecture: {
      ingress: "foreground Linux tunnel-client dev proxy in a separate temporary container, published only to host loopback",
      bridgeEndpoint: "Unix socket /transport/mcp.sock; Docker network_mode=none; no published port",
      authentication: "proof-only relay bearer token; relay and tunnel-client are outside bridge execution; bridge receives neither relay token nor OpenAI control-plane key",
      relay: "foreground loopback-only relay process in the separate tunnel-client proof container; forwards authenticated requests without Authorization to bridge",
      localResidual: "EXPECTED: a same-UID process that can obtain the private transport-volume mount can bypass the relay; it is explicitly bounded and not accepted as production authorization",
    },
    checks: {
      tunnelClientVersionAndProvenance: "PASS",
      currentQuickstartRequirements: "PASS",
      bridgeUnixTransport: "PASS",
      relayUnauthorizedMissingWrongMalformedAuth: "PASS",
      directSocketSameUidResidualMeasured: "EXPECTED RESIDUAL (200 without relay auth; private socket mount required)",
      tunnelForwardingAndMcpDiscovery: "PASS",
      exactCatalog: "PASS",
      tunnelDisconnectReconnect: "PASS",
      bridgeRestartAndWorkspaceRetention: "PASS",
      childEnvironmentNoLocalOrControlPlaneCredential: "PASS",
      noPublicOrHostWideListener: "PASS",
      privateSocketParent: "PASS (0700 transport directory; Docker Desktop does not permit chmod on the socket inode)",
      networkNoneAndNoSocketMount: "PASS",
    },
    cleanup: "foreground proxy, relay, bridge container, disposable workspace, transport sockets, and unique proof image removed in finally",
  }, null, 2));
} finally {
  if (client) await client.close().catch(() => {});
  await stopTunnelSidecar();
  await stopProcess(bridgeProcess);
  runDockerQuiet(["rm", "-f", containerName]);
  runDockerQuiet(["image", "rm", "-f", imageTag]);
  if (manager && session) manager.destroy(session.sessionId);
  fs.rmSync(base, { recursive: true, force: true });
}

function validateTunnelClient() {
  assert.equal(fs.statSync(tunnelClient).isFile(), true, "tunnel-client path is not a regular file");
  assert(tunnelLinuxBinary, "TUNNEL_CLIENT_LINUX_BIN must point to the sidecar tunnel-client binary");
  assert.equal(fs.statSync(tunnelLinuxBinary).isFile(), true, "Linux tunnel-client path is not a regular file");
  assert.equal(sha256(tunnelClient), tunnelBinarySha256, "tunnel-client binary hash mismatch");
  assert.equal(sha256(tunnelLinuxBinary), tunnelLinuxBinarySha256, "Linux tunnel-client binary hash mismatch");
  const help = run(tunnelClient, ["run", "--help"]);
  assert.match(help.output, new RegExp(`run version ${tunnelVersion}\\+${tunnelCommit}`));
  const linuxHelp = runDocker([
    "run", "--rm", "--platform", "linux/amd64", "--user", "10001:10001",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--network", "none", "--mount", `type=bind,src=${tunnelLinuxBinary},dst=/opt/tunnel-client,readonly`,
    "--entrypoint", "/opt/tunnel-client", sidecarImage, "run", "--help",
  ], dockerEnv());
  assert.match(linuxHelp.output, new RegExp(`run version ${tunnelVersion}\\+${tunnelCommit}`));
  const quickstart = run(tunnelClient, ["help", "quickstart"]);
  for (const pattern of [/CONTROL_PLANE_TUNNEL_ID/, /CONTROL_PLANE_API_KEY/, /Tunnels Read \+ Use/, /OPENAI_ADMIN_KEY/]) assert.match(quickstart.output, pattern);
  if (tunnelAsset) assert.equal(sha256(tunnelAsset), tunnelAssetSha256, "release asset hash mismatch");
  if (tunnelChecksums) {
    const checksums = fs.readFileSync(tunnelChecksums, "utf8");
    assert.match(checksums, new RegExp(`${tunnelAssetSha256}\\s+.*tunnel-client-v${tunnelVersion}-darwin-amd64\\.zip`));
  }
  if (tunnelLinuxAsset) assert.equal(sha256(tunnelLinuxAsset), tunnelLinuxAssetSha256, "Linux release asset hash mismatch");
  if (tunnelLinuxChecksums) {
    const checksums = fs.readFileSync(tunnelLinuxChecksums, "utf8");
    assert.match(checksums, new RegExp(`${tunnelLinuxAssetSha256}\\s+.*tunnel-client-v${tunnelVersion}-linux-amd64\\.zip`));
  }
  if (tunnelProvenance) assert.equal(fs.statSync(tunnelProvenance).isFile(), true, "provenance bundle is missing");
}

function prepareSource() {
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sourceHome, { recursive: true, mode: 0o700 });
  writeSource(".gitignore", [".env", "db.env", ".storage/", "runtime/", "backups/", "*.log", "*.db"].join("\n") + "\n");
  writeSource("README.md", "S3 transport disposable fixture\n");
  writeSource("package.json", JSON.stringify({ name: "s3-transport-fixture", version: "1.0.0" }, null, 2) + "\n");
  fs.mkdirSync(path.join(source, ".githooks"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true, mode: 0o700 });
  fs.copyFileSync(governance.hookFile, path.join(source, ".githooks", "pre-commit"));
  fs.copyFileSync(governance.policyFile, path.join(source, "scripts", "pre-commit-policy.mjs"));
  fs.chmodSync(path.join(source, ".githooks", "pre-commit"), 0o755);
  writeSource(".env", "transport fixture only\n");
  writeSource("db.env", "transport fixture only\n");
  writeSource("fixture.log", "transport fixture only\n");
  writeSource("runtime/state.json", "transport fixture only\n");
  writeSource(".storage/token", "transport fixture only\n");
  writeSource("backups/archive.db", "transport fixture only\n");
  const env = sourceGitEnv();
  git(["init", "-q", "-b", "main"], source, env);
  git(["config", "core.hooksPath", "/dev/null"], source, env);
  git(["config", "user.name", "S3 Transport Fixture"], source, env);
  git(["config", "user.email", "s3-transport@example.invalid"], source, env);
  git(["add", ".gitignore", "README.md", "package.json", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs"], source, env);
  git(["commit", "-qm", "transport fixture baseline"], source, env);
  writeSource("README.md", "S3 transport disposable fixture with history\n");
  git(["add", "README.md"], source, env);
  git(["commit", "-qm", "transport fixture second commit"], source, env);
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

function writeComposeOverride() {
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(relayDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tunnelProfile, [
    "config_version: 1",
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    "      url: http://127.0.0.1:8081/mcp",
    "  extra_headers:",
    "    Authorization: env:S3_RELAY_AUTH_HEADER",
    "  discovery_extra_headers:",
    "    Authorization: env:S3_RELAY_AUTH_HEADER",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(composeOverride, [
    "services:",
    "  bridge:",
    `    image: \${S3_IMAGE_TAG:?set S3_IMAGE_TAG to a unique proof tag}`,
    "    environment:",
    "      MCP_UNIX_SOCKET_PATH: /transport/mcp.sock",
    "    volumes:",
    "      - type: bind",
    "        source: ${BRIDGE_TRANSPORT_DIR:?set BRIDGE_TRANSPORT_DIR to a disposable transport directory}",
    "        target: /transport",
    "        read_only: false",
    "",
  ].join("\n"), { mode: 0o600 });
}

async function connectThroughTunnel() {
  await startTunnelSidecar();
  const proxyFile = path.join(relayDir, `proxy-${sidecarGeneration}.json`);
  await waitFor(() => fs.existsSync(proxyFile), "tunnel-client local proxy info", proxyProcess);
  const info = JSON.parse(fs.readFileSync(proxyFile, "utf8"));
  assert.equal(info.backend, "go-in-memory");
  assert.equal(info.mcp_transport, "tcp");
  const sidecar = dockerInspect(sidecarName);
  assert.equal(sidecar.State.Running, true);
  const published = sidecar.NetworkSettings?.Ports?.["8080/tcp"] || [];
  assert.equal(published.length, 1, "tunnel-client proof ingress was not published exactly once");
  assert.equal(published[0].HostIp, "127.0.0.1", "tunnel-client proof ingress was not loopback-only");
  const url = new URL(info.mcp_url);
  url.hostname = "127.0.0.1";
  url.port = published[0].HostPort;
  const nextClient = new Client({ name: "s3-transport-proof", version: "1.0.0" });
  await nextClient.connect(new StreamableHTTPClientTransport(url));
  return { client: nextClient, info, url };
}

async function startTunnelSidecar() {
  assert(tunnelLinuxBinary, "Linux tunnel-client binary is required for the separate proof container");
  sidecarGeneration += 1;
  sidecarName = `bridge-s3-tunnel-${process.pid}-${sidecarGeneration}`;
  const proxyFile = `proxy-${sidecarGeneration}.json`;
  proxyProcess = startProcess("docker", [
    "run", "--rm", "--name", sidecarName,
    "--platform", "linux/amd64",
    "--user", `${proofUid}:${proofGid}`,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64",
    "--memory", "256m",
    "--network", "bridge",
    "--publish", "127.0.0.1::8080",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=32m,uid=${proofUid},gid=${proofGid},mode=1777`,
    "--mount", `type=bind,src=${transportDir},dst=/transport`,
    "--mount", `type=bind,src=${relayDir},dst=/relay`,
    "--mount", `type=bind,src=${path.join(repo, "scripts", "s3-local-relay.mjs")},dst=/opt/relay.mjs,readonly`,
    "--mount", `type=bind,src=${tunnelLinuxBinary},dst=/opt/tunnel-client,readonly`,
    "--env", "HOME=/tmp/home",
    "--env", "TMPDIR=/tmp",
    "--env", `S3_BRIDGE_SOCKET=/transport/mcp.sock`,
    "--env", "S3_RELAY_HOST=127.0.0.1",
    "--env", "S3_RELAY_PORT=8081",
    "--env", `S3_RELAY_TOKEN=${localToken}`,
    "--env", `S3_RELAY_AUTH_HEADER=Bearer ${localToken}`,
    sidecarImage,
    "sh", "-c",
    `mkdir -p /tmp/home && node /opt/relay.mjs & exec /opt/tunnel-client dev proxy --backend go --listen 0.0.0.0:8080 --tunnel-id tunnel_22222222222222222222222222222222 --profile-file /relay/profile.yaml --url-file /relay/${proxyFile} --print-json --readiness-timeout 30s --response-timeout 5s --duration 2m`,
  ], dockerEnv());
  await waitFor(() => fs.existsSync(path.join(relayDir, proxyFile)), "tunnel-client relay/proxy startup", proxyProcess);
}

async function stopTunnelSidecar() {
  if (!sidecarName && !proxyProcess) return;
  if (sidecarName) runDockerQuiet(["rm", "-f", sidecarName]);
  await stopProcess(proxyProcess);
  proxyProcess = null;
  sidecarName = null;
}

function assertSidecarRelayAuthentication() {
  const probe = `import http from "node:http";
const body = ${JSON.stringify(initializeBody(7))};
const cases = [
  ["missing", undefined, body],
  ["wrong", "Bearer wrong-token", body],
  ["basic", "Basic malformed", body],
  ["malformed", process.env.S3_RELAY_TOKEN ? "Bearer " + process.env.S3_RELAY_TOKEN : undefined, "{"],
];
function request(authorization, payload) { return new Promise((resolve, reject) => {
  const headers = { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
  if (authorization) headers.authorization = authorization;
  const q = http.request({ host: "127.0.0.1", port: 8081, path: "/mcp", method: "POST", headers }, r => { let b = ""; r.on("data", x => b += x); r.on("end", () => resolve({ status: r.statusCode, body: b })); });
  q.on("error", reject); q.end(payload);
}); }
const result = {};
for (const [name, authorization, payload] of cases) result[name] = await request(authorization, payload);
console.log(JSON.stringify(result));`;
  const result = runDocker(["exec", sidecarName, "node", "--input-type=module", "-e", probe]);
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  const statuses = JSON.parse(output);
  assert.equal(statuses.missing.status, 401);
  assert.equal(statuses.wrong.status, 401);
  assert.equal(statuses.basic.status, 401);
  assert.equal(statuses.malformed.status, 400);
  return statuses;
}

function sidecarRequest(body) {
  const probe = `import http from "node:http";
const payload = ${JSON.stringify(body)};
const q = http.request({ host: "127.0.0.1", port: 8081, path: "/mcp", method: "POST", headers: { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: "Bearer " + process.env.S3_RELAY_TOKEN } }, r => { let b = ""; r.on("data", x => b += x); r.on("end", () => console.log(JSON.stringify({ status: r.statusCode, body: b }))); });
q.on("error", e => { console.error(e.code || e.message); process.exit(2); }); q.end(payload);`;
  const result = runDocker(["exec", sidecarName, "node", "--input-type=module", "-e", probe]);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function assertDirectUnixSocketResidual() {
  const probe = `import http from "node:http";
const payload = ${JSON.stringify(initializeBody(8))};
const q = http.request({ socketPath: process.env.S3_BRIDGE_SOCKET, path: "/mcp", method: "POST", headers: { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, r => { let b = ""; r.on("data", x => b += x); r.on("end", () => console.log(JSON.stringify({ status: r.statusCode, body: b }))); });
q.on("error", e => { console.error(e.code || e.message); process.exit(2); }); q.end(payload);`;
  const result = runDocker(["exec", sidecarName, "node", "--input-type=module", "-e", probe]);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).status;
}

async function assertTransportBehavior(nextClient, hostWorkspace) {
  const tools = await nextClient.listTools();
  const names = tools.tools.map((tool) => tool.name);
  const expected = [
    "bridge_instructions", "workspace_list", "workspace_open", "workspace_tree", "workspace_snapshot",
    "read_file", "search_text", "write_file", "apply_patch", "edit_file", "git_status", "git_diff", "git_log",
    "git_branch_create", "git_branch_switch", "git_stage", "git_commit", "project_test", "project_lint",
    "project_typecheck", "project_build", "repo_shell", "process_start", "process_list", "process_logs",
    "process_stop", "health",
  ];
  assert.deepEqual(names, expected);
  for (const disabled of ["git_run", "git_push", "git_fetch", "codex_run", "workspace_add_root", "confirm_destructive", "web_fetch", "dom_cdp", "nas", "docker", "ssh"]) {
    assert.equal(names.includes(disabled), false, `${disabled} was exposed`);
  }
  assertMcpOk(await nextClient.callTool({ name: "workspace_open", arguments: { path: workspace } }));
  assertMcpOk(await nextClient.callTool({ name: "write_file", arguments: { path: `${workspace}/transport-marker.txt`, content: "transport proof marker\n" } }));
  const shell = assertMcpOk(await nextClient.callTool({ name: "repo_shell", arguments: { cwd: workspace, command: isolationCommand() } }));
  assertNoCredentialMaterial(shell);
  assert.equal(shell.includes(hostWorkspace), false, "host workspace path leaked into container shell output");
  assertMcpOk(await nextClient.callTool({ name: "health", arguments: {} }));
}

function isolationCommand() {
  return "id; test \"$(id -u)\" = 10001; test ! -e /var/run/docker.sock; test ! -e /Volumes; test ! -e /volume1/docker; test ! -e /Users; test ! -e /home/cardkazuma; if env | grep -E '^(MCP_TOKEN|S3_RELAY_TOKEN|CONTROL_PLANE_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|CODEX_|SSH_AUTH_SOCK)='; then exit 11; fi; if tr '\\0' '\\n' </proc/1/environ | grep -E '^(MCP_TOKEN|S3_RELAY_TOKEN|CONTROL_PLANE_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|CODEX_|SSH_AUTH_SOCK)='; then exit 12; fi; node -e \"const net=require('net'); const s=net.createConnection({host:'1.1.1.1',port:80}); s.on('connect',()=>process.exit(13)); s.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(0),1000);\"";
}

function assertNoCredentialMaterial(text) {
  const result = JSON.parse(text);
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  for (const value of [localToken, "CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "CODEX_", "SSH_AUTH_SOCK"]) assert.equal(output.includes(value), false, `credential material appeared in repo_shell output: ${value}`);
}

function assertContainerBoundary(value) {
  assert.equal(value.State.Running, true);
  assert.equal(value.Config.User, "10001:10001");
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.NetworkMode, "none");
  assert.equal(value.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(value.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(value.HostConfig.PidsLimit, 128);
  assert.equal(value.HostConfig.Privileged, false);
  assert.equal((value.HostConfig.CapDrop || []).includes("ALL"), true);
  assert.equal((value.HostConfig.SecurityOpt || []).includes("no-new-privileges:true"), true);
  assert.equal(Boolean(value.HostConfig.PortBindings && Object.keys(value.HostConfig.PortBindings).length), false);
  assert.equal(value.HostConfig.PidMode === "host", false);
  assert.equal(value.HostConfig.IpcMode === "host", false);
  assert.equal((value.HostConfig.Devices || []).length, 0);
  const mounts = value.Mounts || [];
  assert.equal(mounts.length, 5);
  for (const mount of mounts) {
    assert.equal(mount.Type, "bind");
    assert.equal(mount.Source.startsWith(base), true, `mount escaped proof root: ${mount.Source}`);
    assert.equal(mount.Source.includes("/Volumes"), false);
    assert.equal(mount.Source.includes("/volume1/docker"), false);
  }
  const socketMount = mounts.find((mount) => mount.Destination === "/transport");
  assert(socketMount, "transport socket mount missing");
  assert.equal(socketMount.RW, true);
  assert.equal(mounts.filter((mount) => mount.RW).map((mount) => mount.Destination).sort().join(","), "/transport,/workspace/repo");
  const env = value.Config.Env || [];
  for (const entry of env) assert.equal(/^(?:MCP_TOKEN|S3_RELAY_TOKEN|CONTROL_PLANE_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|CODEX_|SSH_AUTH_SOCK|TUNNEL_)/i.test(entry), false, `credential/control-plane env entered bridge: ${entry.split("=", 1)[0]}`);
  assert.deepEqual(Object.keys(value.NetworkSettings?.Networks || {}), ["none"]);
}

function initializeBody(id) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s3-transport-proof", version: "1.0.0" } },
  });
}

async function canConnect(url) {
  try {
    const response = await fetch(url);
    return response.status > 0;
  } catch {
    return false;
  }
}

function assertMcpOk(result) {
  assert.equal(Boolean(result?.isError), false, textOf(result));
  return textOf(result);
}

function textOf(result) {
  return (result?.content || []).map((item) => item.text || "").join("\n");
}

async function waitFor(predicate, label, process = null, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (process?.exitCode != null) throw new Error(`${label} failed because process exited ${process.exitCode}: ${process.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}${process ? `: ${process.output()}` : ""}`);
}

function isSocket(target) {
  try { return fs.lstatSync(target).isSocket(); } catch { return false; }
}

function startProcess(command, args, env) {
  const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.output = () => `${stdout}${stderr}`;
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode == null) {
    child.kill("SIGKILL");
    await Promise.race([closed.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

function runDocker(args, env, { emptyOutput = false } = {}) {
  const result = run("docker", args, env);
  assert.equal(result.status, 0, `docker ${args.join(" ")} failed: ${result.output}`);
  if (emptyOutput) assert.equal(result.output.trim(), "", `docker ${args.join(" ")} emitted output: ${result.output}`);
  return result;
}

function runDockerQuiet(args) {
  spawnSync("docker", args, { cwd: repo, encoding: "utf8", stdio: "ignore" });
}

function dockerInspect(name) {
  const result = run("docker", ["inspect", name]);
  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.stdout)[0];
}

function dockerImageDigest(tag) {
  const result = run("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", tag]);
  assert.equal(result.status, 0, result.output);
  return result.stdout.trim() || null;
}

function run(command, args, env = undefined, cwd = repo) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ...result, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function git(args, cwd, env) {
  const result = run("git", args, env, cwd);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.output}`);
  return result.stdout || "";
}

function sourceGitEnv() {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: sourceHome,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function sessionGitEnv(workspacePath) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: path.join(path.dirname(path.dirname(workspacePath)), "git-home"),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function safeEnv(extra = {}) {
  const home = path.join(base, "host-home");
  const tmp = path.join(base, "tmp");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmp,
    LANG: "C",
    LC_ALL: "C",
    ...extra,
  };
}

function dockerEnv(extra = {}) {
  const env = safeEnv(extra);
  env.HOME = process.env.HOME || os.homedir();
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  return env;
}

function writeSource(relative, content) {
  const target = path.join(source, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
