#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DisposableWorkspaceManager } from "./disposable-workspace.mjs";
import {
  S6GitHubBroker,
  S6_REPOSITORY_URL,
  S6_GOVERNANCE_HOOKS_PATH,
  S6_GOVERNANCE_POLICY_PATH,
  s6BrokerSocketPath,
  parseBrokerReady,
} from "./s6-github-broker.mjs";
import { s6CredentialProbe } from "./s6-credential.mjs";
import { S5Runtime, EXPECTED_TOOLS as S5_EXPECTED_TOOLS, DISABLED_TOOLS, readCatalogFromFile } from "./s5-runtime.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_SUPPORT_ROOT = path.join(os.homedir(), "Library", "Application Support", "ChatGPT Local Bridge");
const DEFAULT_RUNTIME_ROOT = path.join(APP_SUPPORT_ROOT, "s6-runtime");
const DEFAULT_MANAGER_ROOT = path.join(os.tmpdir(), `chatgpt-local-bridge-s6-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
const BROKER_SCRIPT = path.join(REPO_ROOT, "scripts", "s6-github-broker.mjs");
const S6_EXPECTED_TOOLS = Object.freeze([
  ...S5_EXPECTED_TOOLS.slice(0, S5_EXPECTED_TOOLS.indexOf("project_test")),
  "git_publish_branch",
  ...S5_EXPECTED_TOOLS.slice(S5_EXPECTED_TOOLS.indexOf("project_test")),
]);

export { S6_EXPECTED_TOOLS, DISABLED_TOOLS };

export class S6Runtime extends S5Runtime {
  constructor({
    runtimeRoot = process.env.S6_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT,
    managerRoot = process.env.S6_MANAGER_ROOT || DEFAULT_MANAGER_ROOT,
    ...options
  } = {}) {
    super({ ...options, runtimeRoot, managerRoot });
    this.brokerProcess = null;
    this.brokerSocketPath = "";
    this.activeSession = null;
  }

  runtimeKind() { return "s6-runtime"; }
  runtimeLabel() { return "S6"; }
  expectedTools() { return S6_EXPECTED_TOOLS; }
  resourcePrefix() { return "s6"; }
  managerRootPrefix() { return "chatgpt-local-bridge-s6-"; }
  runtimeMarkerContent() { return "chatgpt-sol-local-bridge S6 runtime root\n"; }
  runtimeMarkerName() { return ".s6-runtime-root"; }

  async start(options = {}) {
    if (options.source && options.source !== S6_REPOSITORY_URL) throw new Error("S6 start accepts no arbitrary source; use the fixed homelab repository");
    return super.start({ ...options, source: S6_REPOSITORY_URL });
  }

  workspaceCreate(source) {
    if (source && source !== S6_REPOSITORY_URL) throw new Error("S6 workspace source is fixed to the homelab repository alias");
    this.ensureRuntimeRoot();
    const manager = this.createManager({ readOnly: false });
    const reaped = manager.reapStale();
    for (const staleSession of reaped) this.audit("workspace.reap", staleSession, "recovered");
    const record = manager.create();
    this.audit("workspace.create", record.sessionId, "ok", { historyCommits: record.historyCommits, baseCommit: record.expectedBaseCommit });
    return publicS6Session(record);
  }

  workspacePrepareManualChat() {
    throw new Error("S6 does not use a local fixture source; workspace sourcing is controller-owned from GitHub");
  }

  createManager({ readOnly }) {
    return new DisposableWorkspaceManager({
      root: this.managerRoot,
      source: S6_REPOSITORY_URL,
      remoteName: "origin",
      materializer: (context) => this.createBroker(context.sessionId).materializeWorkspace(context),
      governance: {
        external: true,
        hookFile: path.join(this.repoRoot, "scripts", "s6-pre-commit"),
        policyFile: path.join(this.repoRoot, "scripts", "pre-commit-policy.mjs"),
        hooksPath: S6_GOVERNANCE_HOOKS_PATH,
        policyPath: S6_GOVERNANCE_POLICY_PATH,
      },
      gitIdentity: {
        name: "ChatGPT Local Bridge",
        email: "chatgpt-local-bridge@users.noreply.github.com",
      },
      protectedPaths: protectedPaths(this.repoRoot),
      staleAfterMs: 15 * 60_000,
      sessionPrefix: "s6",
      branchPrefix: "bridge/s6",
      readOnly,
    });
  }

  validateSession(session, manager) {
    if (!session || session.state !== "active" || !/^s6-[a-z0-9]+-[0-9a-f]{16}$/.test(session.sessionId)) throw new Error("S6 disposable session state is invalid");
    if (session.branch !== `bridge/s6/${session.sessionId}`) throw new Error("S6 disposable session branch is invalid");
    if (session.coreHooksPath !== S6_GOVERNANCE_HOOKS_PATH || session.historyCommits < 1 || !/^[0-9a-f]{40}$/.test(session.expectedBaseCommit || "")) throw new Error("S6 workspace governance/history/base is invalid");
    if (!isWithin(session.workspacePath, manager.sessionsRoot) || path.resolve(session.workspacePath) !== path.join(manager.sessionsRoot, session.sessionId)) throw new Error("S6 disposable workspace path escaped manager root");
    if (isWithin(session.workspacePath, os.homedir())) throw new Error("S6 disposable workspace may not be under the normal user home");
  }

  createBroker(sessionId) {
    return new S6GitHubBroker({
      managerRoot: this.managerRoot,
      bridgeRoot: this.repoRoot,
      sessionId,
      platform: this.platform,
      securityBin: this.securityBin,
      credentialTempRoot: path.join(this.managerRoot, "credential-tmp"),
    });
  }

  async createDockerResources(state, session) {
    this.activeSession = session;
    await this.startBroker(session.sessionId);
    try {
      await super.createDockerResources(state, session);
    } catch (error) {
      await this.stopBroker();
      throw error;
    }
  }

  async startBroker(sessionId) {
    if (this.brokerProcess) throw new Error("S6 broker is already running");
    const socketPath = s6BrokerSocketPath(this.managerRoot, sessionId);
    const child = spawn(process.execPath, [BROKER_SCRIPT, "serve", "--manager-root", this.managerRoot, "--session", sessionId], {
      cwd: this.repoRoot,
      env: safeHostEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    if (!child.pid) throw new Error("S6 GitHub broker did not start");
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    this.brokerProcess = child;
    this.brokerSocketPath = socketPath;
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("timed out waiting for S6 GitHub broker")), 10_000);
        const check = () => {
          const line = stdout.split(/\r?\n/).find((value) => value.trim() === "S6_BROKER_READY");
          if (line) {
            clearTimeout(deadline);
            try { parseBrokerReady(line); resolve(); } catch (error) { reject(error); }
          }
        };
        child.stdout.on("data", check);
        child.once("exit", (code) => {
          clearTimeout(deadline);
          reject(new Error(`S6 GitHub broker exited before readiness (${code ?? "unknown"})`));
        });
        check();
      });
      await this.waitFor(() => fs.existsSync(socketPath), "S6 GitHub broker socket", 10_000);
    } catch (error) {
      await this.stopBroker();
      const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 240);
      throw new Error(detail ? `${error.message}: ${detail}` : error.message);
    }
  }

  async stopBroker() {
    const child = this.brokerProcess;
    const socketPath = this.brokerSocketPath;
    this.brokerProcess = null;
    this.brokerSocketPath = "";
    if (child && child.exitCode == null && !child.killed) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
      });
    }
    if (socketPath) fs.rmSync(socketPath, { force: true });
  }

  expectedBridgeBindCount() { return 5; }

  assertBridgeExtraBoundary(value, _resources) {
    if (!this.activeSession || !this.brokerSocketPath) throw new Error("S6 active session broker state is missing");
    const mounts = value.Mounts || [];
    const governanceRoot = path.resolve(this.activeSession.governanceHostRoot || "");
    const expectedMounts = [
      ["/workspace/repo", this.activeSession.workspacePath, true],
      ["/workspace/repo/.git/config", path.join(this.activeSession.workspacePath, ".git", "config"), false],
      ["/bridge-governance/hooks", path.join(governanceRoot, "hooks"), false],
      ["/bridge-governance/pre-commit-policy.mjs", path.join(governanceRoot, "pre-commit-policy.mjs"), false],
      ["/bridge-broker/publish.sock", this.brokerSocketPath, false],
    ];
    for (const [destination, source, writable] of expectedMounts) {
      const mount = mounts.find((item) => item.Destination === destination);
      if (!mount || mount.Type !== "bind" || mount.RW !== writable || path.resolve(mount.Source) !== path.resolve(source)) {
        throw new Error(`S6 fixed mount changed: ${destination}`);
      }
    }
    const env = value.Config?.Env || [];
    if (env.some((entry) => /^(?:S6_GITHUB_TOKEN_FILE|S6_BROKER_CAPABILITY|GITHUB_TOKEN|GH_TOKEN|GIT_ASKPASS)=/.test(entry))) throw new Error("GitHub credential or broker capability entered the S6 bridge container");
    if (!env.some((entry) => entry === "S6_BROKER_SOCKET=/bridge-broker/publish.sock")) throw new Error("S6 broker channel was not fixed");
    if (!env.includes(`BRIDGE_GOVERNANCE_MODE=s6`) || !env.includes(`BRIDGE_REVIEWED_HOOKS_PATH=${S6_GOVERNANCE_HOOKS_PATH}`) || !env.includes(`BRIDGE_REVIEWED_POLICY_PATH=${S6_GOVERNANCE_POLICY_PATH}`)) throw new Error("S6 external governance environment changed");
  }

  writeComposeOverride() {
    const content = [
      "services:", "  bridge:", "    image: ${S5_IMAGE_TAG:?set S5_IMAGE_TAG to a unique runtime tag}",
      "    environment:", "      MCP_UNIX_SOCKET_PATH: /transport/mcp.sock", `      ENABLED_TOOLS: ${S6_EXPECTED_TOOLS.join(",")}`,
      "      BRIDGE_GOVERNANCE_MODE: s6", `      BRIDGE_REVIEWED_HOOK_PATH: ${S6_GOVERNANCE_HOOKS_PATH}/pre-commit`, `      BRIDGE_REVIEWED_HOOKS_PATH: ${S6_GOVERNANCE_HOOKS_PATH}`, `      BRIDGE_REVIEWED_POLICY_PATH: ${S6_GOVERNANCE_POLICY_PATH}`,
      "      S6_BROKER_SOCKET: /bridge-broker/publish.sock",
      "    logging:", "      driver: local", "      options:", "        max-size: 1m", "        max-file: \"3\"", "    volumes:",
      "      - type: volume", "        source: s5_transport", "        target: /transport", "        read_only: false",
      "      - type: bind", "        source: ${S6_BROKER_SOCKET_SOURCE:?S6 broker socket is required}", "        target: /bridge-broker/publish.sock", "        read_only: true", "volumes:",
      "  s5_transport:", "    name: ${S5_TRANSPORT_VOLUME:?set S5_TRANSPORT_VOLUME to a unique runtime volume}", "",
    ].join("\n");
    writePrivateFile(this.overrideFile, content);
  }

  composeEnvironment(session, resources) {
    if (!this.brokerSocketPath) throw new Error("S6 broker must be ready before Compose resources");
    const governanceRoot = path.resolve(session.governanceHostRoot || "");
    if (!governanceRoot || !isWithin(governanceRoot, path.join(this.managerRoot, "governance"))) throw new Error("S6 governance source is not manager-owned");
    return {
      ...safeHostEnvironment(),
      BRIDGE_WORKSPACE: session.workspacePath,
      BRIDGE_GIT_CONFIG: path.join(session.workspacePath, ".git", "config"),
      BRIDGE_GITHOOKS: path.join(governanceRoot, "hooks"),
      BRIDGE_POLICY_FILE: path.join(governanceRoot, "pre-commit-policy.mjs"),
      BRIDGE_GITHOOKS_TARGET: S6_GOVERNANCE_HOOKS_PATH,
      BRIDGE_POLICY_TARGET: S6_GOVERNANCE_POLICY_PATH,
      S5_IMAGE_TAG: resources.imageTag,
      S5_TRANSPORT_VOLUME: resources.volumeName,
      S6_BROKER_SOCKET_SOURCE: this.brokerSocketPath,
    };
  }

  async cleanupRuntime(resources, options = {}) {
    try {
      await this.stopBroker();
      await super.cleanupRuntime(resources, options);
    } finally {
      this.activeSession = null;
    }
  }

  readCatalogForCheck() {
    if (!fs.existsSync(this.overrideFile)) return [];
    return readCatalogFromFile(this.overrideFile);
  }

  startSupervisor(state) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervise", this.stateFile], {
      cwd: this.repoRoot,
      env: safeHostEnvironment(),
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    if (!child.pid) throw new Error("S6 runtime supervisor did not start");
    child.unref();
    state.supervisorPid = child.pid;
    state.updatedAt = new Date().toISOString();
    this.writeState(state);
  }

  stopSupervisor(state) {
    if (!Number.isInteger(state?.supervisorPid) || state.supervisorPid <= 0 || state.supervisorPid === process.pid) return;
    const command = spawnSync("ps", ["-p", String(state.supervisorPid), "-o", "command="], { encoding: "utf8" });
    if (command.status !== 0) return;
    if (!String(command.stdout || "").includes("s6-runtime.mjs supervise")) throw new Error("refusing to stop an unrelated S6 supervisor PID");
    try { process.kill(state.supervisorPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }

  status(options = {}) {
    const value = super.status(options);
    return { ...value, githubCredentialPlane: s6CredentialProbe({ platform: this.platform, securityBin: this.securityBin }) };
  }
}

function publicS6Session(record) {
  return {
    sessionId: record.sessionId,
    repository: "homelab",
    branch: record.branch,
    state: record.state,
    sourceCommit: record.sourceCommit,
    expectedBaseCommit: record.expectedBaseCommit,
    historyCommits: record.historyCommits,
    coreHooksPath: record.coreHooksPath,
  };
}

function protectedPaths(repoRoot) {
  const developer = path.resolve(repoRoot, "..", "..");
  return [
    repoRoot,
    path.join(developer, "chatgpt-sol-local-bridge-s1"),
    path.join(developer, "chatgpt-sol-local-bridge-s3"),
    path.join(developer, "chatgpt-sol-local-bridge-s4"),
    path.join(developer, "chatgpt-sol-local-bridge-s5"),
    path.join(developer, "homelab"),
    path.join(developer, "portfolio-db"),
  ];
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeHostEnvironment() {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function writePrivateFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseArgs(args) {
  const out = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item.startsWith("--")) {
      const [key, inline] = item.slice(2).split("=", 2);
      out[key] = inline ?? args[++index];
    } else out._.push(item);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = new S6Runtime({ runtimeRoot: args["runtime-root"] || undefined, managerRoot: args["manager-root"] || undefined });
  const [command, subcommand] = args._;
  if (command === "keychain" && subcommand === "status") { console.log(JSON.stringify(s6CredentialProbe({ platform: process.platform }), null, 2)); return; }
  if (command === "start") {
    console.log(JSON.stringify(await runtime.start({ source: args.source, sessionId: args.session, tunnelId: args["tunnel-id"] || process.env.S5_TUNNEL_ID, tunnelClientBin: args["tunnel-client"] || process.env.S5_TUNNEL_CLIENT_LINUX_BIN, releaseDir: args["release-dir"] || process.env.S5_TUNNEL_RELEASE_DIR, caBundle: args["ca-bundle"] }), null, 2));
    return;
  }
  if (command === "status") { console.log(JSON.stringify(runtime.status(), null, 2)); return; }
  if (command === "doctor") { console.log(JSON.stringify(runtime.doctor(), null, 2)); return; }
  if (command === "stop") { console.log(JSON.stringify(await runtime.stop(), null, 2)); return; }
  if (command === "recover") { console.log(JSON.stringify(await runtime.recover(), null, 2)); return; }
  if (command === "rollback") { console.log(JSON.stringify(await runtime.rollback(), null, 2)); return; }
  if (command === "workspace" && subcommand === "create") { console.log(JSON.stringify(runtime.workspaceCreate(args.source), null, 2)); return; }
  if (command === "workspace" && subcommand === "list") { console.log(JSON.stringify(runtime.workspaceList(), null, 2)); return; }
  if (command === "workspace" && subcommand === "destroy") { console.log(JSON.stringify(runtime.workspaceDestroy(args.session), null, 2)); return; }
  if (command === "supervise") { await runtime.supervise(args._[1] || runtime.stateFile); return; }
  throw new Error("usage: s6-runtime.mjs {keychain status|start|status|doctor|stop|recover|rollback|workspace create|workspace list|workspace destroy|supervise}");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${String(error.message).slice(0, 400)}\n`);
    process.exitCode = 1;
  });
}
