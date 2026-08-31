#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DisposableWorkspaceManager } from "./disposable-workspace.mjs";
import { appendAudit, auditSize, clearAudit } from "./s5-audit.mjs";
import {
  credentialProbe,
  installKeychainItem,
  withTunnelClientEnvFile,
} from "./s5-credential.mjs";
import {
  parseTunnelControlPlaneHealthReport,
  parseTunnelReadinessResponse,
} from "./s4-readiness.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_SUPPORT_ROOT = path.join(os.homedir(), "Library", "Application Support", "ChatGPT Local Bridge");
const DEFAULT_RUNTIME_ROOT = path.join(APP_SUPPORT_ROOT, "s5-runtime");
const RUNTIME_MARKER = ".s5-runtime-root";
const STATE_FILE_NAME = "state.json";
const PROFILE_FILE_NAME = "tunnel-profile.yaml";
const OVERRIDE_FILE_NAME = "compose.s5.yaml";
const SIDECAR_IMAGE = "node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de";
const TUNNEL_VERSION = "0.0.13";
const TUNNEL_COMMIT = "4b5267f823be0b046bb883aacb51603cfde3a0ea";
const TUNNEL_BINARY_SHA256 = "7a686d9e156dfe461d9751de6d0e7296c14040a4b3638f1b1527a2fa153e2196";
const TUNNEL_ASSET_SHA256 = "e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906";
const ALLOWED_TUNNEL_ENV_NAMES = new Set(["S5_RELAY_AUTH_HEADER"]);
export const EXPECTED_TOOLS = Object.freeze([
  "bridge_instructions", "workspace_list", "workspace_open", "workspace_tree", "workspace_snapshot",
  "read_file", "search_text", "write_file", "apply_patch", "edit_file", "git_status", "git_diff", "git_log",
  "git_branch_create", "git_branch_switch", "git_stage", "git_commit", "project_test", "project_lint",
  "project_typecheck", "project_build", "repo_shell", "process_start", "process_list", "process_logs",
  "process_stop", "health",
]);
export const DISABLED_TOOLS = Object.freeze([
  "accessibility", "audio", "clipboard", "codex_run", "confirm_destructive", "dom_cdp", "file_dialog",
  "git_run", "git_push", "git_fetch", "input_event", "notification", "office", "pending_destructive",
  "penpot_status", "project_dev", "scheduler", "screen_record", "shell", "system_info", "vision", "web_fetch",
  "window", "workspace_add_root", "nas", "docker", "ssh",
]);
const SUPERVISOR_INTERVAL_MS = 10_000;
const READY_TIMEOUT_MS = 180_000;
const CONTROL_PLANE_TIMEOUT_MS = 60_000;

export class S5Runtime {
  constructor({
    runtimeRoot = process.env.S5_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT,
    managerRoot = process.env.S5_MANAGER_ROOT || undefined,
    repoRoot = REPO_ROOT,
    docker = new DockerDriver({ cwd: repoRoot }),
    platform = process.platform,
    securityBin = undefined,
    spawnSupervisor = true,
  } = {}) {
    this.runtimeRoot = path.resolve(runtimeRoot);
    assertSafeRuntimeRoot(this.runtimeRoot);
    this.repoRoot = path.resolve(repoRoot);
    this.docker = docker;
    this.platform = platform;
    this.securityBin = securityBin;
    this.spawnSupervisor = spawnSupervisor;
    this.stateFile = path.join(this.runtimeRoot, STATE_FILE_NAME);
    this.profileFile = path.join(this.runtimeRoot, PROFILE_FILE_NAME);
    this.overrideFile = path.join(this.runtimeRoot, OVERRIDE_FILE_NAME);
    this.auditRoot = path.join(this.runtimeRoot, "audit");
    this.tempRoot = path.join(this.runtimeRoot, "tmp");
    const persistedManagerRoot = managerRoot ? "" : managerRootFromRuntimeState(this.stateFile);
    this.managerRoot = path.resolve(managerRoot || persistedManagerRoot || defaultManagerRoot());
    assertSafeS5ManagerRoot(this.managerRoot);
  }

  async start({ source, tunnelId, sessionId = "", tunnelClientBin, releaseDir, caBundle = "" } = {}) {
    this.ensureRuntimeRoot();
    const existing = this.readState();
    if (existing) throw new Error("S5 runtime has existing state; run status or recover first");
    const staticInputs = this.resolveTunnelInputs({ tunnelClientBin, releaseDir, caBundle });
    validateTunnelId(tunnelId);
    const manager = this.createManager({ source, readOnly: !source });
    const staleSessions = manager.reapStale();
    for (const staleSession of staleSessions) this.audit("workspace.reap", staleSession, "recovered");
    let session;
    let createdSession = false;
    let state;
    try {
      if (sessionId) {
        session = manager.readRecord(sessionId);
        this.validateSession(session, manager);
      } else {
        if (!source) throw new Error("start requires a disposable local source or --session");
        session = manager.create();
        createdSession = true;
      }
      const resources = makeResources();
      state = {
        version: 1,
        kind: "s5-runtime",
        phase: "starting",
        sessionId: session.sessionId,
        resources,
        managerRoot: this.managerRoot,
        profileFile: this.profileFile,
        overrideFile: this.overrideFile,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tunnelClient: {
          version: TUNNEL_VERSION,
          sourceCommit: TUNNEL_COMMIT,
          binarySha256: TUNNEL_BINARY_SHA256,
          assetSha256: TUNNEL_ASSET_SHA256,
        },
        readiness: {
          bridgeHealth: "pending",
          bridgeReady: "pending",
          tunnelClient: "pending",
          controlPlanePoll: "pending",
          mcpStartup: "pending",
        },
      };
      this.writeState(state);
      this.audit("runtime.start", session.sessionId, "blocked", { phase: "preflight" });
      this.validateStaticPreflight({ ...staticInputs, source, session, resources });
      this.writeTrustBundle(staticInputs.caBundle);
      this.writeProfile();
      this.writeComposeOverride();
      this.createDockerResources(state, session);
      await this.waitFor(() => this.containerRunning(resources.bridgeName), "bridge container");
      await this.waitFor(() => this.bridgeSocketReady(resources.bridgeName), "bridge transport socket");
      this.assertBridgeBoundary(resources);
      await this.waitFor(() => this.bridgeReady(resources.bridgeName), "bridge health/readiness");
      state.readiness.bridgeHealth = "live";
      state.readiness.bridgeReady = "ready";
      this.writeState(state);

      this.startRelay(resources);
      await this.waitFor(() => this.relayReady(resources), "authenticated relay");
      this.assertRelayBoundary(resources);
      const localCatalog = this.mcpStartupProbe(resources);
      if (JSON.stringify(localCatalog) !== JSON.stringify(EXPECTED_TOOLS)) throw new Error("MCP catalog changed during startup");

      await withTunnelClientEnvFile({
        tempRoot: this.tempRoot,
        securityBin: this.securityBin,
        platform: this.platform,
      }, async (credentialFile) => {
        appendLine(credentialFile, "S5_RELAY_AUTH_HEADER", `Bearer ${resources.relayToken}`);
        this.createTunnel(resources, staticInputs, credentialFile, tunnelId);
      });
      this.assertTunnelBoundary(resources);
      await this.startTunnelAndWait(resources, state);
      state.readiness.tunnelClient = "ready";
      state.readiness.controlPlanePoll = "ready";
      state.readiness.mcpStartup = "ready";
      state.phase = "running";
      state.updatedAt = new Date().toISOString();
      this.writeState(state);
      if (this.spawnSupervisor) this.startSupervisor(state);
      this.audit("runtime.start", session.sessionId, "ok", {
        bridgeHealth: state.readiness.bridgeHealth,
        bridgeReady: state.readiness.bridgeReady,
        controlPlanePoll: state.readiness.controlPlanePoll,
        mcpStartup: state.readiness.mcpStartup,
      });
      return this.status({ inspectLive: true });
    } catch (error) {
      if (state) {
        state.phase = "failed";
        state.updatedAt = new Date().toISOString();
        state.failure = safeFailure(error);
        try { this.writeState(state); } catch {}
      }
      try { await this.cleanupRuntime(state?.resources, { removeImage: true }); } catch {}
      if (createdSession && session) {
        try { manager.destroy(session.sessionId); } catch {}
      }
      this.audit("runtime.start", session?.sessionId || null, "failed", {
        reason: safeFailure(error),
        controlPlaneDiagnostic: this.lastTunnelControlPlaneDiagnostic || "not observed",
      });
      this.removeStateArtifacts(state);
      throw new Error(`S5 start blocked: ${safeFailure(error)}`);
    }
  }

  async stop() {
    this.ensureRuntimeRoot();
    const state = this.readState();
    if (!state) {
      this.reapWorkspaces();
      this.audit("runtime.stop", null, "not-running");
      return { running: false, stopped: false, workspaceDestruction: "not requested" };
    }
    this.validateState(state);
    try {
      state.phase = "stopping";
      state.updatedAt = new Date().toISOString();
      this.writeState(state);
      this.stopSupervisor(state);
      await this.cleanupRuntime(state.resources, { removeImage: true });
      this.audit("runtime.stop", state.sessionId, "ok", { workspaceDestruction: "not requested" });
      this.removeStateArtifacts(state);
      return { running: false, stopped: true, sessionId: state.sessionId, workspaceDestruction: "not requested" };
    } catch (error) {
      this.audit("runtime.stop", state.sessionId, "failed", { reason: safeFailure(error) });
      throw new Error(`S5 stop incomplete: ${safeFailure(error)}`);
    }
  }

  async recover() {
    this.ensureRuntimeRoot();
    const state = this.readState();
    const reaped = this.reapWorkspaces();
    if (!state) {
      this.audit("runtime.recover", null, "recovered", { reapedCount: reaped.length });
      return { recovered: true, runtime: "not-running", reapedSessions: reaped };
    }
    this.validateState(state);
    try {
      this.stopSupervisor(state);
      await this.cleanupRuntime(state.resources, { removeImage: true });
      this.removeStateArtifacts(state);
      this.audit("runtime.recover", state.sessionId, "recovered", { reapedCount: reaped.length });
      return { recovered: true, runtime: "stopped", sessionId: state.sessionId, reapedSessions: reaped };
    } catch (error) {
      this.audit("runtime.recover", state.sessionId, "failed", { reason: safeFailure(error) });
      throw new Error(`S5 recovery incomplete: ${safeFailure(error)}`);
    }
  }

  status({ inspectLive = true } = {}) {
    this.ensureRuntimeRoot();
    const reapedSessions = this.reapWorkspaces();
    const state = this.readState();
    const sessions = this.listWorkspaceSessions();
    if (!state) {
      return {
        running: false,
        phase: "stopped",
        readiness: { bridgeHealth: "not-running", bridgeReady: "not-running", tunnelClient: "not-running", controlPlanePoll: "not-running", mcpStartup: "not-running" },
        credentialPlane: this.credentialStatus(),
        disposableWorkspaces: { count: sessions.length, sessionIds: sessions.map((item) => item.sessionId) },
        reapedSessions,
        auditBytes: auditSize(this.auditRoot),
      };
    }
    this.validateState(state);
    const live = inspectLive ? this.inspectRuntime(state) : null;
    const running = state.phase === "running" && (live ? live.running : true);
    return {
      running,
      phase: state.phase,
      sessionId: state.sessionId,
      readiness: live?.readiness || {
        bridgeHealth: state.readiness.bridgeHealth,
        bridgeReady: state.readiness.bridgeReady,
        tunnelClient: state.readiness.tunnelClient,
        controlPlanePoll: state.readiness.controlPlanePoll,
        mcpStartup: state.readiness.mcpStartup,
      },
      tunnelControlPlane: live?.tunnelControlPlane || state.readiness.controlPlanePoll,
      credentialPlane: this.credentialStatus(),
      disposableWorkspaces: { count: sessions.length, sessionIds: sessions.map((item) => item.sessionId) },
      reapedSessions,
      auditBytes: auditSize(this.auditRoot),
    };
  }

  doctor() {
    this.ensureRuntimeRoot();
    const checks = [];
    checks.push(check("platform", this.platform === "darwin", "macOS required"));
    checks.push(check("docker", this.docker.probeDocker(), "Docker CLI unavailable"));
    checks.push(check("compose", this.docker.probeCompose(), "Docker Compose unavailable"));
    checks.push(check("catalog", JSON.stringify(EXPECTED_TOOLS) === JSON.stringify(readCatalogFromCompose(this.repoRoot)), "exact 27-tool catalog mismatch"));
    const state = this.readState();
    if (state) {
      this.validateState(state);
      const live = this.inspectRuntime(state);
      checks.push(check("bridge-health", live.readiness.bridgeHealth === "live", live.readiness.bridgeHealth));
      checks.push(check("bridge-ready", live.readiness.bridgeReady === "ready", live.readiness.bridgeReady));
      checks.push(check("control-plane-poll", live.tunnelControlPlane === "ready", live.tunnelControlPlane));
      checks.push(check("mcp-startup", live.readiness.mcpStartup === "ready", live.readiness.mcpStartup));
    } else {
      checks.push(check("runtime", true, "not running"));
    }
    const credential = this.credentialStatus();
    checks.push(check("credential-plane", credential.available, credential.reason));
    const passed = checks.every((item) => item.pass);
    return {
      pass: passed,
      checks,
      runtime: state ? this.status({ inspectLive: true }) : { running: false },
      policy: {
        noLaunchAgent: true,
        noPush: true,
        noCodexRun: true,
        noNasOrDockerAuthorityInBridge: true,
      },
    };
  }

  workspaceCreate(source) {
    this.ensureRuntimeRoot();
    const manager = this.createManager({ source, readOnly: false });
    const reaped = manager.reapStale();
    for (const staleSession of reaped) this.audit("workspace.reap", staleSession, "recovered");
    const record = manager.create();
    this.audit("workspace.create", record.sessionId, "ok", { historyCommits: record.historyCommits });
    return publicSession(record);
  }

  workspaceList() {
    this.ensureRuntimeRoot();
    const reaped = this.reapWorkspaces();
    return { sessions: this.listWorkspaceSessions(), reapedSessions: reaped };
  }

  workspaceDestroy(sessionId) {
    this.ensureRuntimeRoot();
    const state = this.readState();
    if (state?.sessionId === sessionId) {
      throw new Error("runtime state references this workspace; stop or recover runtime before destruction");
    }
    const manager = this.createManager({ readOnly: true });
    const result = manager.destroy(sessionId);
    this.audit("workspace.destroy", sessionId, "ok");
    return result;
  }

  async rollback() {
    this.ensureRuntimeRoot();
    if (this.readState()) await this.stop();
    const manager = this.createManager({ readOnly: true });
    const destroyed = manager.destroyAll();
    const removed = [];
    for (const target of [this.stateFile, this.profileFile, this.overrideFile, path.join(this.runtimeRoot, "trust-roots.pem")]) {
      if (fs.existsSync(target)) { fs.unlinkSync(target); removed.push(path.basename(target)); }
    }
    this.audit("runtime.rollback", null, "ok", { destroyedCount: destroyed.length });
    clearAudit(this.auditRoot);
    const managerParent = isWithin(this.managerRoot, os.tmpdir()) ? os.tmpdir() : "/tmp";
    removeExactDirectory(this.managerRoot, managerParent, "chatgpt-local-bridge-s5-");
    for (const directory of [this.auditRoot, this.tempRoot]) {
      if (fs.existsSync(directory)) removeExactDirectory(directory, this.runtimeRoot, path.basename(directory));
    }
    return { rolledBack: true, destroyedSessions: destroyed, removedRuntimeFiles: removed, keychainRevoked: false };
  }

  async supervise(stateFile = this.stateFile) {
    const state = readJson(stateFile);
    if (!state || state.phase !== "running") return;
    const manager = this.createManager({ readOnly: true });
    const onSignal = () => { this.supervisorStopping = true; };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    while (!this.supervisorStopping) {
      const current = readJson(stateFile);
      if (!current || current.phase !== "running") return;
      if (!this.containerRunning(current.resources.bridgeName) || !this.containerRunning(current.resources.tunnelName)) {
        current.phase = "degraded";
        current.failure = "runtime child exited; run recover";
        current.updatedAt = new Date().toISOString();
        writeRuntimeState(stateFile, current);
        this.audit("runtime.supervisor", current.sessionId, "failed", { reason: current.failure });
        try { await this.cleanupRuntime(current.resources, { removeImage: false }); } catch {}
        current.phase = "failed";
        current.updatedAt = new Date().toISOString();
        writeRuntimeState(stateFile, current);
        return;
      }
      try { manager.touch(current.sessionId); } catch {
        current.phase = "failed";
        current.failure = "workspace heartbeat failed; run recover";
        current.updatedAt = new Date().toISOString();
        writeRuntimeState(stateFile, current);
        try { await this.cleanupRuntime(current.resources, { removeImage: false }); } catch {}
        return;
      }
      await sleep(SUPERVISOR_INTERVAL_MS);
    }
  }

  validateStaticPreflight({ tunnelClientBin, tunnelClientAsset, tunnelChecksums, tunnelProvenance, source, session, resources }) {
    if (this.platform !== "darwin") throw new Error("S5 runtime requires macOS Keychain and Docker Desktop");
    if (!source && !session) throw new Error("disposable workspace session is required");
    if (session) this.validateSession(session, this.createManager({ readOnly: true }));
    validateFile(tunnelClientBin, "tunnel-client binary");
    if (sha256(tunnelClientBin) !== TUNNEL_BINARY_SHA256) throw new Error("tunnel-client binary hash mismatch");
    validateFile(tunnelClientAsset, "tunnel-client release asset");
    if (sha256(tunnelClientAsset) !== TUNNEL_ASSET_SHA256) throw new Error("tunnel-client release asset hash mismatch");
    validateFile(tunnelChecksums, "tunnel-client checksum file");
    const checksums = fs.readFileSync(tunnelChecksums, "utf8");
    if (!checksums.includes(`${TUNNEL_ASSET_SHA256}  tunnel-client-v${TUNNEL_VERSION}-linux-amd64.zip`)) throw new Error("tunnel-client release checksum provenance mismatch");
    validateFile(tunnelProvenance, "tunnel-client provenance bundle");
    const provenance = readJson(tunnelProvenance);
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) throw new Error("tunnel-client provenance bundle is invalid");
    if (!this.docker.probeDocker()) throw new Error("Docker daemon is unavailable");
    this.ensurePinnedSidecarImage();
    const help = this.docker.run([
      "run", "--rm", "--platform", "linux/amd64", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--network", "none", "--mount", `type=bind,src=${tunnelClientBin},dst=/opt/tunnel-client,readonly`,
      "--entrypoint", "/opt/tunnel-client", SIDECAR_IMAGE, "run", "--help",
    ]);
    if (help.status !== 0 || !new RegExp(`run version ${TUNNEL_VERSION}\\+${TUNNEL_COMMIT}`).test(help.stdout || "")) throw new Error("tunnel-client version/provenance probe failed");
    if (!this.docker.probeCompose()) throw new Error("Docker Compose binary is unavailable");
    if (!resources || !/^s5-[a-z0-9]+-[0-9a-f]{12}$/.test(resources.projectName)) throw new Error("runtime resource identity is invalid");
    const credential = this.credentialStatus();
    if (!credential.available) throw new Error("dedicated Keychain runtime item is unavailable");
  }

  createDockerResources(state, session) {
    const { resources } = state;
    const composeEnv = this.composeEnvironment(session, resources);
    this.docker.checked(["volume", "create", "--name", resources.volumeName]);
    this.docker.checked([
      "run", "--rm", "--platform", "linux/amd64", "--user", "0:0", "--read-only", "--cap-drop", "ALL",
      "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges:true", "--network", "none",
      "--mount", `type=volume,src=${resources.volumeName},dst=/transport`, "--entrypoint", "/bin/sh", SIDECAR_IMAGE,
      "-c", "chown 10001:10001 /transport && chmod 0700 /transport",
    ]);
    this.docker.checked(["network", "create", "--internal", resources.privateNetworkName]);
    this.docker.checked(["network", "create", resources.egressNetworkName]);
    this.docker.checked([...composeArgs(this.repoRoot, this.overrideFile, resources), "config", "-q"], { requireEmptyStderr: true, env: composeEnv });
    this.docker.checked([...composeArgs(this.repoRoot, this.overrideFile, resources), "build", "bridge"], { env: composeEnv });
    const image = this.docker.run(["image", "inspect", "--format", "{{.Id}}", resources.imageTag]);
    if (image.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test((image.stdout || "").trim())) throw new Error("bridge image identity is not pinned");
    state.bridgeImageId = image.stdout.trim();
    this.writeState(state);
    this.docker.checked([...composeArgs(this.repoRoot, this.overrideFile, resources), "run", "-d", "--no-deps", "--name", resources.bridgeName, "bridge"], { env: composeEnv });
  }

  ensurePinnedSidecarImage() {
    if (!this.docker.imageAvailable(SIDECAR_IMAGE)) this.docker.checked(["pull", SIDECAR_IMAGE]);
    const inspection = this.docker.run(["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", SIDECAR_IMAGE]);
    const expectedDigest = SIDECAR_IMAGE.slice(SIDECAR_IMAGE.indexOf("@") + 1);
    const found = String(inspection.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (inspection.status !== 0 || !found.some((entry) => entry.endsWith(`@${expectedDigest}`))) {
      throw new Error("pinned sidecar image digest verification failed");
    }
  }

  startRelay(resources) {
    const relayEnv = path.join(this.tempRoot, `${resources.projectName}.relay.env`);
    writeEnvFile(relayEnv, { S3_RELAY_TOKEN: resources.relayToken });
    try {
      this.docker.checked([
        "run", "-d", "--name", resources.relayName, "--platform", "linux/amd64", "--user", "10001:10001", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "128m",
        "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=3",
        "--network", resources.privateNetworkName, "--network-alias", "relay", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=1777",
        "--mount", `type=volume,src=${resources.volumeName},dst=/transport,readonly`,
        "--mount", `type=bind,src=${path.join(this.repoRoot, "scripts", "s3-local-relay.mjs")},dst=/opt/relay.mjs,readonly`,
        "--env", "S3_BRIDGE_SOCKET=/transport/mcp.sock", "--env", "S3_RELAY_HOST=0.0.0.0", "--env", "S3_RELAY_PORT=8081",
        "--env", "S4_RELAY_INTERNAL=true", "--env-file", relayEnv, SIDECAR_IMAGE, "node", "/opt/relay.mjs",
      ]);
    } finally {
      fs.rmSync(relayEnv, { force: true });
    }
  }

  createTunnel(resources, inputs, credentialFile, tunnelId) {
    validateTunnelId(tunnelId);
    this.docker.checked([
      "create", "--name", resources.tunnelName, "--platform", "linux/amd64", "--user", `${currentUid()}:${currentGid()}`, "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "96", "--memory", "256m",
      "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=3", "--network", resources.egressNetworkName,
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=32m,uid=${currentUid()},gid=${currentGid()},mode=1777`,
      "--tmpfs", `/home/tunnel:rw,noexec,nosuid,nodev,size=32m,uid=${currentUid()},gid=${currentGid()},mode=700`,
      "--mount", `type=bind,src=${inputs.tunnelClientBin},dst=/opt/tunnel-client,readonly`,
      "--mount", `type=bind,src=${this.profileFile},dst=/run/tunnel/profile.yaml,readonly`,
      "--mount", `type=bind,src=${path.join(this.runtimeRoot, "trust-roots.pem")},dst=/run/tunnel/macos-system-roots.pem,readonly`,
      "--env-file", credentialFile, "--env", `CONTROL_PLANE_TUNNEL_ID=${tunnelId}`, "--env", "HOME=/home/tunnel", "--env", "TMPDIR=/tmp",
      "--env", "SSL_CERT_FILE=/run/tunnel/macos-system-roots.pem", SIDECAR_IMAGE, "/opt/tunnel-client", "run",
      "--profile-file", "/run/tunnel/profile.yaml", "--log.format", "json", "--log.level", "info",
    ]);
    this.docker.checked(["network", "connect", resources.privateNetworkName, resources.tunnelName]);
  }

  async startTunnelAndWait(resources, state) {
    this.docker.checked(["start", resources.tunnelName]);
    await this.waitFor(() => this.tunnelReady(resources.tunnelName), "tunnel-client /readyz", READY_TIMEOUT_MS);
    try {
      await this.waitFor(() => this.tunnelControlPlaneReady(resources.tunnelName), "tunnel-client control-plane poll", CONTROL_PLANE_TIMEOUT_MS);
    } catch (error) {
      const diagnostic = this.lastTunnelControlPlaneDiagnostic;
      if (diagnostic) throw new Error(`${safeFailure(error)}; last control-plane health: ${diagnostic}`);
      throw error;
    }
    state.readiness.controlPlanePoll = "ready";
    this.writeState(state);
    const doctor = this.docker.checked(["exec", resources.tunnelName, "/opt/tunnel-client", "doctor", "--profile-file", "/run/tunnel/profile.yaml", "--health.listen-addr", "127.0.0.1:0", "--explain"]);
    if (doctor.status !== 0) throw new Error("tunnel-client doctor failed");
  }

  async cleanupRuntime(resources, { removeImage = true } = {}) {
    if (!resources) return;
    for (const name of [resources.tunnelName, resources.relayName, resources.bridgeName]) {
      this.docker.run(["stop", "-t", "10", name]);
    }
    for (const name of [resources.tunnelName, resources.relayName, resources.bridgeName]) {
      this.docker.run(["rm", "-f", name]);
    }
    this.docker.run(["network", "rm", resources.privateNetworkName, resources.egressNetworkName]);
    this.docker.run(["volume", "rm", "-f", resources.volumeName]);
    if (removeImage) this.docker.run(["image", "rm", "-f", resources.imageTag]);
    for (const target of [this.profileFile, this.overrideFile, path.join(this.runtimeRoot, "trust-roots.pem")]) fs.rmSync(target, { force: true });
  }

  inspectRuntime(state) {
    const bridge = this.containerRunning(state.resources.bridgeName);
    const relay = this.containerRunning(state.resources.relayName);
    const tunnel = this.containerRunning(state.resources.tunnelName);
    let bridgeStatus = bridge ? "live" : "not-running";
    let bridgeReady = bridge ? "ready" : "not-running";
    let mcp = bridge && relay ? "ready" : "not-running";
    let tunnelReady = tunnel ? "ready" : "not-running";
    let control = tunnel ? "ready" : "not-running";
    if (bridge) {
      try {
        const ready = this.bridgeReady(state.resources.bridgeName);
        bridgeStatus = ready ? "live" : "not-ready";
        bridgeReady = ready ? "ready" : "not-ready";
        if (relay) mcp = this.mcpStartupProbe(state.resources).length === EXPECTED_TOOLS.length ? "ready" : "not-ready";
      } catch { bridgeStatus = "not-ready"; bridgeReady = "not-ready"; mcp = "not-ready"; }
    }
    if (tunnel) {
      try { tunnelReady = this.tunnelReady(state.resources.tunnelName) ? "ready" : "not-ready"; } catch { tunnelReady = "not-ready"; }
      try { control = this.tunnelControlPlaneReady(state.resources.tunnelName) ? "ready" : "not-ready"; } catch { control = "not-ready"; }
    }
    return {
      running: bridge && relay && tunnel,
      readiness: { bridgeHealth: bridgeStatus, bridgeReady, tunnelClient: tunnelReady, mcpStartup: mcp },
      tunnelControlPlane: control,
    };
  }

  bridgeReady(name) {
    const health = this.bridgeEndpoint(name, "/healthz");
    const ready = this.bridgeEndpoint(name, "/readyz");
    return health.status === 200 && health.body?.ok === true && ready.status === 200 && ready.body?.ready === true
      && Number(ready.body?.toolCount) === EXPECTED_TOOLS.length && JSON.stringify(ready.body?.tools) === JSON.stringify(EXPECTED_TOOLS);
  }

  bridgeSocketReady(name) {
    return this.docker.run(["exec", name, "/bin/sh", "-c", "test -S /transport/mcp.sock"]).status === 0;
  }

  bridgeEndpoint(name, endpoint) {
    const script = `import http from "node:http"; const r=http.request({socketPath:"/transport/mcp.sock",path:${JSON.stringify(endpoint)},method:"GET",headers:{host:"localhost"}},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>process.stdout.write(JSON.stringify({status:x.statusCode,body:b})));});r.on("error",e=>{process.stdout.write(JSON.stringify({status:599,error:e.code||e.message}));});r.end();`;
    const result = this.docker.run(["exec", name, "node", "--input-type=module", "-e", script]);
    const line = String(result.stdout || "").trim().split(/\r?\n/).at(-1);
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.body === "string") { try { parsed.body = JSON.parse(parsed.body); } catch {} }
      return parsed;
    } catch { return { status: 599, body: null }; }
  }

  relayReady(resources) {
    if (!this.containerRunning(resources.relayName)) return false;
    return this.relayRequest(resources, "missing", initializeBody(10)).status === 401;
  }

  mcpStartupProbe(resources) {
    const initialized = this.relayRequest(resources, "valid", initializeBody(1));
    if (initialized.status !== 200) throw new Error(`MCP initialize failed with HTTP ${initialized.status}`);
    const listed = this.relayRequest(resources, "valid", toolsListBody(2));
    if (listed.status !== 200) throw new Error(`MCP tools/list failed with HTTP ${listed.status}`);
    const found = extractTools(listed.body);
    if (DISABLED_TOOLS.some((tool) => found.includes(tool))) throw new Error("disabled tool appeared in MCP discovery");
    return found;
  }

  relayRequest(resources, mode, body) {
    const script = `import http from "node:http"; const payload=${JSON.stringify(body)}; const h={host:"localhost",accept:"application/json, text/event-stream","content-type":"application/json","content-length":Buffer.byteLength(payload)}; if(process.env.S5_PROBE_MODE==="valid")h.authorization="Bearer "+process.env.S3_RELAY_TOKEN; const q=http.request({host:"127.0.0.1",port:8081,path:"/mcp",method:"POST",headers:h},r=>{let b="";r.on("data",x=>b+=x);r.on("end",()=>process.stdout.write(JSON.stringify({status:r.statusCode,body:b})));});q.on("error",e=>{process.stdout.write(JSON.stringify({status:599,body:e.code||e.message}));});q.end(payload);`;
    const result = this.docker.run(["exec", "-e", `S5_PROBE_MODE=${mode}`, resources.relayName, "node", "--input-type=module", "-e", script]);
    const line = String(result.stdout || "").trim().split(/\r?\n/).at(-1);
    try { return JSON.parse(line); } catch { return { status: 599, body: "malformed probe response" }; }
  }

  tunnelReady(name) {
    const script = "const r=await fetch('http://127.0.0.1:8080/readyz'); const body=await r.text(); process.stdout.write(JSON.stringify({status:r.status,body}));";
    const result = this.docker.run(["exec", name, "node", "--input-type=module", "-e", script]);
    const line = String(result.stdout || "").trim().split(/\r?\n/).at(-1);
    try {
      const parsed = JSON.parse(line);
      return parseTunnelReadinessResponse(parsed.status, parsed.body).ready;
    } catch (error) {
      if (error.name === "TunnelReadinessProtocolError") throw error;
      return false;
    }
  }

  tunnelControlPlaneReady(name) {
    const result = this.docker.run(["exec", name, "/opt/tunnel-client", "health", "--port", "8080", "--json", "--require-control-plane-poll"]);
    let report;
    try { report = JSON.parse(result.stdout || ""); } catch { throw new Error("tunnel-client health returned malformed output"); }
    const parsed = parseTunnelControlPlaneHealthReport(result.status, report);
    this.lastTunnelControlPlaneDiagnostic = sanitizeOutput(parsed.diagnostic).slice(0, 240);
    return parsed.ready;
  }

  assertBridgeBoundary(resources) {
    const value = this.docker.inspect(resources.bridgeName);
    if (value.Config?.User !== "10001:10001") throw new Error("bridge user is not non-root");
    if (value.HostConfig?.ReadonlyRootfs !== true) throw new Error("bridge root filesystem is not read-only");
    if (value.HostConfig?.NetworkMode !== "none") throw new Error("bridge network is not disabled");
    if (!(value.HostConfig?.CapDrop || []).includes("ALL")) throw new Error("bridge capabilities were not dropped");
    if (!(value.HostConfig?.SecurityOpt || []).includes("no-new-privileges:true")) throw new Error("bridge no-new-privileges is missing");
    if (value.HostConfig?.PortBindings && Object.keys(value.HostConfig.PortBindings).length) throw new Error("bridge published a host port");
    if (value.HostConfig?.PidMode === "host" || value.HostConfig?.IpcMode === "host") throw new Error("bridge shares a host namespace");
    if ((value.HostConfig?.Devices || []).length) throw new Error("bridge has a host device");
    const mounts = value.Mounts || [];
    const transport = mounts.find((mount) => mount.Destination === "/transport");
    if (!transport || transport.Type !== "volume" || transport.Name !== resources.volumeName || transport.RW !== true) throw new Error("bridge transport mount is not the reviewed Docker volume");
    if (mounts.filter((mount) => mount.Type === "volume").length !== 1 || mounts.filter((mount) => mount.Type === "bind").length !== 4) throw new Error("bridge mount topology changed");
    if ((value.NetworkSettings?.Networks && Object.keys(value.NetworkSettings.Networks).join(",")) !== "none") throw new Error("bridge has an unexpected network");
    assertNoCredentialEnv(value.Config?.Env || [], { allowRelay: false });
  }

  assertRelayBoundary(resources) {
    const value = this.docker.inspect(resources.relayName);
    if (value.Config?.User === "0" || value.Config?.User === "0:0" || !value.Config?.User) throw new Error("relay is not non-root");
    if (value.HostConfig?.ReadonlyRootfs !== true || !(value.HostConfig?.CapDrop || []).includes("ALL")) throw new Error("relay hardening changed");
    if (!(value.HostConfig?.SecurityOpt || []).includes("no-new-privileges:true")) throw new Error("relay no-new-privileges is missing");
    if (value.HostConfig?.PortBindings && Object.keys(value.HostConfig.PortBindings).length) throw new Error("relay published a host port");
    if (value.HostConfig?.PidMode === "host" || value.HostConfig?.IpcMode === "host" || (value.HostConfig?.Devices || []).length) throw new Error("relay shares a host namespace or device");
    if (value.HostConfig?.NetworkMode !== resources.privateNetworkName) throw new Error("relay is not on the private network");
    const transport = (value.Mounts || []).find((mount) => mount.Destination === "/transport");
    if (!transport || transport.Type !== "volume" || transport.Name !== resources.volumeName || transport.RW !== false) throw new Error("relay transport mount changed");
    if ((value.Mounts || []).some((mount) => mount.Source.includes("/workspace") || mount.Source.includes("manager"))) throw new Error("relay received a workspace mount");
    if (!(value.NetworkSettings?.Networks?.[resources.privateNetworkName]?.Aliases || []).includes("relay")) throw new Error("relay network alias is missing");
    assertNoCredentialEnv(value.Config?.Env || [], { allowRelay: true });
  }

  assertTunnelBoundary(resources) {
    const value = this.docker.inspect(resources.tunnelName);
    if (value.Config?.User === "0" || value.Config?.User === "0:0" || !value.Config?.User) throw new Error("tunnel is not non-root");
    if (value.HostConfig?.ReadonlyRootfs !== true || !(value.HostConfig?.CapDrop || []).includes("ALL")) throw new Error("tunnel hardening changed");
    if (!(value.HostConfig?.SecurityOpt || []).includes("no-new-privileges:true")) throw new Error("tunnel no-new-privileges is missing");
    if (value.HostConfig?.PortBindings && Object.keys(value.HostConfig.PortBindings).length) throw new Error("tunnel published a host port");
    if (value.HostConfig?.PidMode === "host" || value.HostConfig?.IpcMode === "host" || (value.HostConfig?.Devices || []).length) throw new Error("tunnel shares a host namespace or device");
    if ((value.Mounts || []).some((mount) => mount.Type === "volume" || mount.Destination === "/workspace/repo" || mount.Destination === "/transport")) throw new Error("tunnel received bridge/workspace storage");
    if (!(value.Mounts || []).some((mount) => mount.Destination === "/run/tunnel/profile.yaml")) throw new Error("tunnel profile mount missing");
    if (!(value.Config?.Env || []).some((entry) => entry.startsWith("CONTROL_PLANE_API_KEY="))) throw new Error("tunnel runtime key was not injected into tunnel plane");
    if (!(value.Config?.Env || []).some((entry) => entry.startsWith("CONTROL_PLANE_TUNNEL_ID=tunnel_"))) throw new Error("tunnel identifier was not injected into tunnel plane");
    if (!(value.Config?.Env || []).some((entry) => entry.startsWith("S5_RELAY_AUTH_HEADER="))) throw new Error("tunnel relay credential missing");
    const networks = Object.keys(value.NetworkSettings?.Networks || {}).sort();
    if (networks.join(",") !== [resources.egressNetworkName, resources.privateNetworkName].sort().join(",")) throw new Error("tunnel network topology changed");
    assertNoCredentialEnv(value.Config?.Env || [], { allowRelay: true, tunnel: true });
  }

  createManager({ source, readOnly }) {
    return new DisposableWorkspaceManager({
      root: this.managerRoot,
      source,
      governance: {
        hookFile: path.join(this.repoRoot, ".githooks", "pre-commit"),
        policyFile: path.join(this.repoRoot, "scripts", "pre-commit-policy.mjs"),
      },
      protectedPaths: protectedPaths(this.repoRoot),
      staleAfterMs: 15 * 60_000,
      sessionPrefix: "s5",
      branchPrefix: "bridge/s5",
      readOnly,
    });
  }

  validateSession(session, manager) {
    if (!session || session.state !== "active" || !/^s5-[a-z0-9]+-[0-9a-f]{16}$/.test(session.sessionId)) throw new Error("disposable session state is invalid");
    if (session.branch !== `bridge/s5/${session.sessionId}`) throw new Error("disposable session branch is invalid");
    if (session.coreHooksPath !== ".githooks" || session.historyCommits < 1) throw new Error("disposable workspace governance/history is invalid");
    if (!isWithin(session.workspacePath, manager.sessionsRoot)) throw new Error("disposable workspace path escaped manager root");
    if (isWithin(session.workspacePath, os.homedir())) throw new Error("disposable workspace may not be under the normal user home");
  }

  resolveTunnelInputs({ tunnelClientBin, releaseDir, caBundle }) {
    const releaseRoot = releaseDir ? path.resolve(releaseDir) : "";
    const optionalPath = (value) => value ? path.resolve(value) : "";
    return {
      tunnelClientBin: optionalPath(tunnelClientBin || (releaseRoot && path.join(releaseRoot, "linux", "tunnel-client"))),
      tunnelClientAsset: optionalPath((releaseRoot && path.join(releaseRoot, "linux.zip")) || process.env.S5_TUNNEL_CLIENT_LINUX_ASSET),
      tunnelChecksums: optionalPath((releaseRoot && path.join(releaseRoot, "SHA256SUMS.txt")) || process.env.S5_TUNNEL_CLIENT_CHECKSUMS),
      tunnelProvenance: optionalPath((releaseRoot && path.join(releaseRoot, "provenance.sigstore.json")) || process.env.S5_TUNNEL_CLIENT_PROVENANCE),
      caBundle: optionalPath(caBundle),
    };
  }

  writeProfile() {
    const content = [
      "config_version: 1", "control_plane:", '  base_url: "https://api.openai.com"',
      '  api_key: "env:CONTROL_PLANE_API_KEY"', "health:", '  listen_addr: "127.0.0.1:8080"', "admin_ui:",
      "  open_browser: false", "log:", "  level: info", "  format: json", "mcp:", "  server_urls:",
      "    - channel: main", '      url: "http://relay:8081/mcp"', "  extra_headers:",
      '    Authorization: "env:S5_RELAY_AUTH_HEADER"', "  discovery_extra_headers:",
      '    Authorization: "env:S5_RELAY_AUTH_HEADER"', "",
    ].join("\n");
    writePrivateFile(this.profileFile, content);
  }

  writeTrustBundle(caBundle = "") {
    if (caBundle) {
      validateFile(caBundle, "CA bundle");
      const content = fs.readFileSync(caBundle, "utf8");
      if (!content.includes("BEGIN CERTIFICATE")) throw new Error("CA bundle does not contain PEM certificates");
      writePrivateFile(path.join(this.runtimeRoot, "trust-roots.pem"), content);
      return;
    }
    writeSystemTrustBundle(this.runtimeRoot, this.securityBin);
  }

  writeComposeOverride() {
    const content = [
      "services:", "  bridge:", `    image: \${S5_IMAGE_TAG:?set S5_IMAGE_TAG to a unique runtime tag}`,
      "    environment:", "      MCP_UNIX_SOCKET_PATH: /transport/mcp.sock", "    logging:",
      "      driver: local", "      options:", "        max-size: 1m", "        max-file: \"3\"", "    volumes:",
      "      - type: volume", "        source: s5_transport", "        target: /transport", "        read_only: false", "volumes:",
      "  s5_transport:", `    name: \${S5_TRANSPORT_VOLUME:?set S5_TRANSPORT_VOLUME to a unique runtime volume}`, "",
    ].join("\n");
    writePrivateFile(this.overrideFile, content);
  }

  composeEnvironment(session, resources) {
    return {
      ...safeHostEnvironment(),
      BRIDGE_WORKSPACE: session.workspacePath,
      BRIDGE_GIT_CONFIG: path.join(session.workspacePath, ".git", "config"),
      BRIDGE_GITHOOKS: path.join(session.workspacePath, ".githooks"),
      BRIDGE_POLICY_FILE: path.join(session.workspacePath, "scripts", "pre-commit-policy.mjs"),
      S5_IMAGE_TAG: resources.imageTag,
      S5_TRANSPORT_VOLUME: resources.volumeName,
    };
  }

  startSupervisor(state) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervise", this.stateFile], {
      cwd: this.repoRoot,
      env: safeHostEnvironment(),
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    if (!child.pid) throw new Error("runtime supervisor did not start");
    child.unref();
    state.supervisorPid = child.pid;
    state.updatedAt = new Date().toISOString();
    this.writeState(state);
  }

  stopSupervisor(state) {
    if (!Number.isInteger(state?.supervisorPid) || state.supervisorPid <= 0 || state.supervisorPid === process.pid) return;
    const command = spawnSync("ps", ["-p", String(state.supervisorPid), "-o", "command="], { encoding: "utf8" });
    if (command.status !== 0) return;
    if (!String(command.stdout || "").includes("s5-runtime.mjs supervise")) throw new Error("refusing to stop an unrelated supervisor PID");
    try { process.kill(state.supervisorPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }

  credentialStatus() {
    return credentialProbe({ securityBin: this.securityBin, platform: this.platform });
  }

  readState() {
    if (!fs.existsSync(this.stateFile)) return null;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      throw new Error("S5 runtime state is unreadable; refusing to start, stop, or recover blindly");
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("S5 runtime state is invalid");
    return state;
  }

  writeState(state) {
    state.updatedAt = new Date().toISOString();
    writeRuntimeState(this.stateFile, state);
  }

  validateState(state) {
    if (!state || state.version !== 1 || state.kind !== "s5-runtime" || !/^s5-[a-z0-9]+-[0-9a-f]{16}$/.test(state.sessionId)) throw new Error("runtime state is invalid");
    validateResources(state.resources);
    if (path.resolve(state.managerRoot) !== this.managerRoot) throw new Error("runtime manager root identity mismatch");
  }

  ensureRuntimeRoot() {
    fs.mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.runtimeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("S5 runtime root must be a real directory");
    fs.chmodSync(this.runtimeRoot, 0o700);
    const marker = path.join(this.runtimeRoot, RUNTIME_MARKER);
    if (fs.existsSync(marker)) {
      if (fs.readFileSync(marker, "utf8") !== "chatgpt-sol-local-bridge S5 runtime root\n") throw new Error("S5 runtime marker mismatch");
    } else {
      const entries = fs.readdirSync(this.runtimeRoot).filter((entry) => entry !== RUNTIME_MARKER);
      if (entries.length) throw new Error("refusing to use a non-empty unmarked S5 runtime root");
      writePrivateFile(marker, "chatgpt-sol-local-bridge S5 runtime root\n");
    }
    fs.mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.auditRoot, { recursive: true, mode: 0o700 });
  }

  removeStateArtifacts(state) {
    for (const target of [this.stateFile, this.profileFile, this.overrideFile, path.join(this.runtimeRoot, "trust-roots.pem")]) fs.rmSync(target, { force: true });
    if (state?.resources) {
      const relayEnv = path.join(this.tempRoot, `${state.resources.projectName}.relay.env`);
      fs.rmSync(relayEnv, { force: true });
    }
  }

  reapWorkspaces() {
    const manager = this.createManager({ readOnly: true });
    return manager.reapStale();
  }

  listWorkspaceSessions() {
    const manager = this.createManager({ readOnly: true });
    const records = [];
    for (const entry of fs.readdirSync(manager.stateRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes(".refresh-")) continue;
      try { records.push(publicSession(manager.readRecord(entry.name.slice(0, -5)))); } catch {}
    }
    return records.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  containerRunning(name) {
    if (!/^[a-z0-9][a-z0-9_.-]+$/.test(String(name || ""))) return false;
    const result = this.docker.run(["inspect", "--format", "{{.State.Running}}", name]);
    return result.status === 0 && String(result.stdout || "").trim() === "true";
  }

  audit(operation, sessionId, result, detail = {}) {
    try { appendAudit(this.auditRoot, { operation, sessionId, result, detail }); } catch {}
  }

  waitFor(predicate, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (callback) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        callback();
      };
      const tick = () => {
        if (Date.now() >= deadline) return finish(() => reject(new Error(`timed out waiting for ${label}`)));
        let value = false;
        try { value = predicate(); } catch (error) { return finish(() => reject(error)); }
        if (value) return finish(resolve);
        timer = setTimeout(tick, 250);
      };
      tick();
    });
  }
}

export class DockerDriver {
  constructor({ dockerBin = "docker", cwd = REPO_ROOT } = {}) {
    this.dockerBin = dockerBin;
    this.cwd = cwd;
  }

  run(args, { env = safeHostEnvironment(), timeout = 300_000 } = {}) {
    return spawnSync(this.dockerBin, args, { cwd: this.cwd, env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  }

  checked(args, options = {}) {
    const result = this.run(args, options);
    if (result.status !== 0) throw new Error(`docker command failed: ${sanitizeOutput(result.stderr || result.stdout || "unknown error")}`);
    if (options.requireEmptyStderr && String(result.stderr || "").trim()) throw new Error(`docker command emitted stderr: ${sanitizeOutput(result.stderr)}`);
    return result;
  }

  inspect(name) {
    const result = this.checked(["inspect", name]);
    return JSON.parse(result.stdout)[0];
  }

  imageAvailable(image) {
    const result = this.run(["image", "inspect", image]);
    return result.status === 0;
  }

  probeDocker() { return this.run(["version", "--format", "{{.Server.Version}}"]).status === 0; }
  probeCompose() { return this.run(["compose", "version"]).status === 0; }
}

export function makeResources() {
  const suffix = crypto.randomBytes(6).toString("hex");
  const projectName = `s5-${process.pid}-${suffix}`;
  return {
    projectName,
    imageTag: `chatgpt-sol-local-bridge:${projectName}`,
    bridgeName: `${projectName}-bridge`,
    relayName: `${projectName}-relay`,
    tunnelName: `${projectName}-tunnel`,
    volumeName: `${projectName}-transport`,
    privateNetworkName: `${projectName}-private`,
    egressNetworkName: `${projectName}-egress`,
    relayToken: crypto.randomBytes(24).toString("hex"),
  };
}

function validateResources(resources) {
  if (!resources || !/^s5-[a-z0-9]+-[0-9a-f]{12}$/.test(resources.projectName)) throw new Error("runtime resource identity is invalid");
  for (const key of ["imageTag", "bridgeName", "relayName", "tunnelName", "volumeName", "privateNetworkName", "egressNetworkName"]) {
    if (!/^[a-z0-9][a-z0-9_.:-]+$/.test(String(resources[key] || ""))) throw new Error(`runtime resource ${key} is invalid`);
  }
}

function composeArgs(repoRoot, overrideFile, resources) {
  return ["compose", "-p", resources.projectName, "-f", path.join(repoRoot, "compose.yaml"), "-f", overrideFile];
}

function defaultManagerRoot() {
  return path.join(os.tmpdir(), `chatgpt-local-bridge-s5-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

function assertSafeRuntimeRoot(root) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(APP_SUPPORT_ROOT)) throw new Error("S5 runtime root must be a dedicated child directory");
  const darwinTmpAlias = process.platform === "darwin" && (isWithin(resolved, "/tmp") || isWithin(resolved, "/private/tmp"));
  if (!isWithin(resolved, APP_SUPPORT_ROOT) && !isWithin(resolved, os.tmpdir()) && !darwinTmpAlias) throw new Error("S5 runtime root must be under Application Support or the OS temporary directory");
  assertNoSymlinkAncestors(resolved);
}

function assertSafeS5ManagerRoot(root) {
  const resolved = path.resolve(root);
  const darwinTmpAlias = process.platform === "darwin" && (isWithin(resolved, "/tmp") || isWithin(resolved, "/private/tmp"));
  if ((!isWithin(resolved, os.tmpdir()) && !darwinTmpAlias) || !path.basename(resolved).startsWith("chatgpt-local-bridge-s5-")) {
    throw new Error("S5 manager root must be a dedicated directory under the OS temporary directory");
  }
}

function protectedPaths(repoRoot) {
  const developer = path.resolve(repoRoot, "..", "..");
  return [
    repoRoot,
    path.join(developer, "chatgpt-sol-local-bridge-s1"),
    path.join(developer, "chatgpt-sol-local-bridge-s3"),
    path.join(developer, "chatgpt-sol-local-bridge-s4"),
    path.join(developer, "homelab"),
    path.join(developer, "portfolio-db"),
  ];
}

function publicSession(record) {
  return {
    sessionId: record.sessionId,
    branch: record.branch,
    state: record.state,
    sourceCommit: record.sourceCommit,
    historyCommits: record.historyCommits,
    coreHooksPath: record.coreHooksPath,
  };
}

function validateTunnelId(value) {
  if (!/^tunnel_[A-Za-z0-9_-]+$/.test(String(value || ""))) throw new Error("tunnel ID must be supplied as a tunnel_ identifier");
}

function currentUid() { return typeof process.getuid === "function" ? process.getuid() : 1000; }
function currentGid() { return typeof process.getgid === "function" ? process.getgid() : currentUid(); }

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
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function writeRuntimeState(filePath, state) {
  const persisted = structuredClone(state);
  if (persisted.resources) delete persisted.resources.relayToken;
  writePrivateFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);
}

function writeEnvFile(filePath, values) {
  writePrivateFile(filePath, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

export function appendLine(filePath, name, value) {
  if (!ALLOWED_TUNNEL_ENV_NAMES.has(name)
    || !/^[A-Z_][A-Z0-9_]*$/.test(name)
    || typeof value !== "string"
    || value.length === 0
    || /[\r\n\0]/.test(value)) {
    throw new Error("credential env assignment is invalid");
  }
  fs.appendFileSync(filePath, `${name}=${value}\n`, { encoding: "utf8" });
  fs.chmodSync(filePath, 0o600);
}

function writeSystemTrustBundle(runtimeRoot, securityBin = undefined) {
  const binary = securityBin || "/usr/bin/security";
  const result = spawnSync(binary, ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (result.status !== 0 || !result.stdout || !result.stdout.includes("BEGIN CERTIFICATE")) throw new Error("system trust bundle could not be prepared");
  writePrivateFile(path.join(runtimeRoot, "trust-roots.pem"), result.stdout);
}

function validateFile(filePath, label) {
  if (!filePath) throw new Error(`${label} path is required`);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
}

function sha256(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function managerRootFromRuntimeState(stateFile) {
  const state = readJson(stateFile);
  return state?.kind === "s5-runtime" && typeof state.managerRoot === "string" ? state.managerRoot : "";
}

function check(name, pass, detail) { return { name, pass: Boolean(pass), detail: pass ? "ok" : String(detail) }; }

function safeFailure(error) {
  return sanitizeOutput(error instanceof Error ? error.message : String(error)).slice(0, 240);
}

function sanitizeOutput(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/(?:CONTROL_PLANE_API_KEY|OPENAI_API_KEY|S3_RELAY_TOKEN|S5_RELAY_AUTH_HEADER)=\S+/g, "$1=<redacted>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>")
    .replace(/tunnel_[A-Za-z0-9_-]+/g, "tunnel_<redacted>");
}

function assertNoCredentialEnv(entries, { allowRelay = false, tunnel = false } = {}) {
  for (const entry of entries) {
    const name = String(entry).split("=", 1)[0];
    if (name === "OPENAI_API_KEY") throw new Error("OPENAI_API_KEY entered a runtime container");
    if (name === "CONTROL_PLANE_API_KEY" && !tunnel) throw new Error("control-plane key entered a non-tunnel container");
    if (["S3_RELAY_TOKEN", "S5_RELAY_AUTH_HEADER"].includes(name) && !allowRelay) throw new Error("relay credential entered bridge container");
  }
}

function extractTools(body) {
  const found = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    const value = line.startsWith("data: ") ? line.slice(6) : line;
    try { found.push(JSON.parse(value)); } catch {}
  }
  const response = found.find((item) => Array.isArray(item?.result?.tools));
  if (!response) throw new Error("MCP tools/list response did not contain a result");
  return response.result.tools.map((tool) => tool.name);
}

function initializeBody(id) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s5-runtime", version: "1.0.0" } } });
}

function toolsListBody(id) { return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }); }

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function removeExactDirectory(target, parent, basenamePrefix) {
  const resolved = path.resolve(target);
  const parentResolved = path.resolve(parent);
  if (!isWithin(resolved, parentResolved) || resolved === parentResolved || !path.basename(resolved).startsWith(basenamePrefix)) throw new Error("refusing to remove an unowned S5 directory");
  if (!fs.existsSync(resolved)) return;
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("refusing to remove a non-directory S5 target");
  fs.rmSync(resolved, { recursive: true, force: true });
}

function assertNoSymlinkAncestors(target) {
  const benignSystemAliases = process.platform === "darwin" ? new Set(["/tmp", "/var"]) : new Set();
  const absolute = path.resolve(target);
  const ancestors = [];
  let current = absolute;
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of ancestors.reverse()) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      if (!benignSystemAliases.has(candidate)) throw new Error(`S5 runtime root has a symlink ancestor: ${candidate}`);
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`S5 runtime root ancestor is not a directory: ${candidate}`);
  }
}

function readCatalogFromCompose(repoRoot) {
  const text = fs.readFileSync(path.join(repoRoot, "compose.yaml"), "utf8");
  const match = text.match(/ENABLED_TOOLS:\s*([^\n]+)/);
  return match ? match[1].trim().split(",") : [];
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
  const runtime = new S5Runtime({ runtimeRoot: args["runtime-root"] || undefined, managerRoot: args["manager-root"] || undefined });
  const [command, subcommand] = args._;
  if (command === "keychain" && subcommand === "install") {
    console.log(JSON.stringify(installKeychainItem({ platform: process.platform }), null, 2));
    return;
  }
  if (command === "start") {
    console.log(JSON.stringify(await runtime.start({
      source: args.source,
      sessionId: args.session,
      tunnelId: args["tunnel-id"] || process.env.S5_TUNNEL_ID,
      tunnelClientBin: args["tunnel-client"] || process.env.S5_TUNNEL_CLIENT_LINUX_BIN,
      releaseDir: args["release-dir"] || process.env.S5_TUNNEL_RELEASE_DIR,
      caBundle: args["ca-bundle"],
    }), null, 2));
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
  throw new Error("usage: s5-runtime.mjs {keychain install|start|status|doctor|stop|recover|rollback|workspace create|workspace list|workspace destroy|supervise}");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${safeFailure(error)}\n`);
    process.exitCode = 1;
  });
}
