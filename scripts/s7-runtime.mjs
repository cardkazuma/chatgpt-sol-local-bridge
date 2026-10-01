#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startController } from "../src/s7/controller.js";
import { RecoveryBudget } from "../src/s7/recovery.js";
import { OwnedProcess } from "../src/s7/owned-process.js";
import { atomicJson, privateDirectory } from "../src/s7/registry.js";
import { withTunnelClientEnvFile } from "./s5-credential.mjs";
import { parseTunnelControlPlaneHealthReport } from "./s4-readiness.mjs";

const ARTIFACT = "3e528011ce130797af25aeca2f1bb1faea294cd46838cfbadffc488cd9463f96";
const TUNNEL = "c5d1ab3ccf3aa402f631e2fac66c763fa0b1b82e6134e995c9a44bc6a06fb93c";
const LABEL = "com.cardkazuma.chatgpt-local-bridge.s7";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
function privateFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error("unsafe runtime binding file");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function readRuntimeConfig(file) {
  const c = privateFile(file);
  if (c.version !== 1 || !path.isAbsolute(c.root || "") || !path.isAbsolute(c.tunnelBinary || "")) throw new Error("invalid runtime binding");
  if (!fs.existsSync(c.tunnelBinary) || fs.lstatSync(c.tunnelBinary).isSymbolicLink() || sha(fs.readFileSync(c.tunnelBinary)) !== TUNNEL || c.tunnelSha256 !== TUNNEL) throw new Error("tunnel binary binding mismatch");
  if (!/^tunnel_[A-Za-z0-9_-]+$/.test(c.tunnelId) || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 || !Number.isInteger(c.healthPort) || c.healthPort < 1024 || c.healthPort > 65535 || c.port === c.healthPort) throw new Error("invalid tunnel binding");
  const coordinator = privateFile(c.coordinatorConfig);
  if (coordinator.artifactSha256 !== ARTIFACT || coordinator.version !== 1 || !coordinator.bootIdentity || !Number.isInteger(coordinator.safetyGeneration) || coordinator.safetyGeneration < 1) throw new Error("selected coordinator binding unavailable");
  for (const f of [coordinator.pythonExecutable, coordinator.driver, coordinator.store]) {
    if (!path.isAbsolute(f) || !fs.existsSync(f) || !fs.lstatSync(f).isFile() || fs.lstatSync(f).isSymbolicLink()) throw new Error("selected coordinator binding unavailable");
  }
  if (!Array.isArray(c.repositories)) throw new Error("repository bindings unavailable");
  return { ...c, coordinator };
}
export function launchAgentPlist({ node, script, config, log }) {
  const xml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${[node, script, "run", config].map((s) => `<string>${xml(s)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(node))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}
function command(executable, args, options = {}) {
  return spawnSync(executable, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options });
}
function coordinatorEnvironment(c, repositoryId) {
  return { PATH: process.env.PATH, HOME: os.homedir(), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", PYTHONNOUSERSITE: "1", WORK_COORDINATOR_SELECTED_STORE: c.store, WORK_COORDINATOR_BOOT_IDENTITY: c.bootIdentity, WORK_COORDINATOR_SAFETY_GENERATION: String(c.safetyGeneration), S7B_COORDINATOR_REPOSITORY_ID: String(repositoryId) };
}
function coordinatorHealth(c) {
  const code = "from pathlib import Path; from importlib.metadata import version; from work_coordinator.infrastructure.storage.sqlite_store import SQLiteStore; import os; assert version('work-coordinator')=='0.2.0'; s=SQLiteStore(Path(os.environ['WORK_COORDINATOR_SELECTED_STORE']), existing_only=True); assert s.integrity_check()=='ok'; print('ready')";
  const r = command(c.pythonExecutable, ["-c", code], { env: coordinatorEnvironment(c, c.repositoryId) });
  return { ready: r.status === 0 && r.stdout.trim() === "ready" && !r.stderr, reason: r.status === 0 ? "selected_store_checked" : "selected_store_unavailable", artifact: ARTIFACT, exclusiveCoverage: false };
}
function registerCoordinator(c, task) {
  const context = { project_id: task.project, task_id: task.id, session_id: `s7-${task.id}`, agent_id: "chatgpt-local-bridge", workspace_id: task.id, worktree_id: task.id, branch: task.branch, base_sha: task.baseSha, local_repository_instance_id: `sha256:${sha(task.repository.source)}` };
  for (const action of ["register_session", "attest_capabilities"]) {
    const request = { action, request_id: crypto.randomUUID(), context };
    const r = command(c.pythonExecutable, [c.driver], { input: JSON.stringify(request), env: coordinatorEnvironment(c, task.repository.id) });
    if (r.status !== 0 || r.stderr) throw new Error("coordinator registration unavailable");
    const value = JSON.parse(r.stdout);
    if (!["ALLOW", "WARN"].includes(value.decision) || value.persisted !== true) throw new Error("coordinator refused task registration");
  }
  return { session: context.session_id, artifact: ARTIFACT, coverage: "bounded_s7b" };
}
export async function runRuntime(file) {
  const c = readRuntimeConfig(file);
  const root = privateDirectory(c.root);
  const recovery = new RecoveryBudget(root);
  let tunnel;
  let controller;
  let busy = false;
  let tunnelStartedAt = 0;
  let shuttingDown = false;
  const token = crypto.randomBytes(32).toString("hex");
  const initialStore = fs.statSync(c.coordinator.store);
  const selectedBinding = sha(JSON.stringify([c.coordinator, initialStore.dev, initialStore.ino, initialStore.birthtimeMs]));
  const bindingFile = path.join(root, "selected-binding.json");
  if (fs.existsSync(bindingFile) && privateFile(bindingFile).identity !== selectedBinding) throw new Error("selected coordinator binding changed; preserve state and review");
  if (!fs.existsSync(bindingFile)) atomicJson(bindingFile, { identity: selectedBinding });
  const profile = path.join(root, "tunnel-profile.yaml");
  fs.writeFileSync(profile, `config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  api_key: "env:CONTROL_PLANE_API_KEY"\nhealth:\n  listen_addr: "127.0.0.1:${c.healthPort}"\nadmin_ui:\n  open_browser: false\nlog:\n  level: warn\n  format: json\nmcp:\n  server_urls:\n    - channel: main\n      url: "http://127.0.0.1:${c.port}/mcp"\n  extra_headers:\n    Authorization: "env:S7_MCP_AUTH"\n  discovery_extra_headers:\n    Authorization: "env:S7_MCP_AUTH"\n`, { mode: 0o600 });
  const tunnelHealth = () => {
    if (tunnel?.status().state !== "running") return { ready: false, reason: "not_running" };
    const r = command(c.tunnelBinary, ["health", "--port", String(c.healthPort), "--pid", String(tunnel.status().pid), "--json", "--require-control-plane-poll"]);
    try { return { ready: parseTunnelControlPlaneHealthReport(r.status, JSON.parse(r.stdout)).ready, reason: "live_probe" }; }
    catch { return { ready: false, reason: "tunnel_or_control_plane_unavailable" }; }
  };
  let components = { coordinator: { ready: false }, tunnel: { ready: false } };
  const dependencies = async () => components;
  const recheck = async () => {
    if (busy || shuttingDown) return;
    busy = true;
    try {
      const current = fs.statSync(c.coordinator.store);
      if (sha(JSON.stringify([c.coordinator, current.dev, current.ino, current.birthtimeMs])) !== selectedBinding) throw new Error("binding changed");
      components = { coordinator: coordinatorHealth(c.coordinator), tunnel: tunnelHealth(), github: { installed: command("gh", ["--version"]).status === 0, authentication: "checked_on_use" }, ssh: { installed: command("ssh", ["-V"]).status === 0, access: "checked_on_use" } };
      if (!components.coordinator.ready) { recovery.degraded("coordinator"); return; }
      if (components.tunnel.ready) { recovery.ready(); return; }
      if (tunnel?.status().state === "running" && Date.now() - tunnelStartedAt < 90_000) return;
      if (!recovery.attempt().allowed) return;
      await tunnel?.stop();
      await withTunnelClientEnvFile({ tempRoot: root }, async (envFile) => {
        // Existing fixed Keychain custody path; the key goes only to the owned
        // tunnel worker, never a tool response, argv, task, or audit record.
        const text = fs.readFileSync(envFile, "utf8");
        const secret = text.slice("CONTROL_PLANE_API_KEY=".length).trimEnd();
        tunnel = new OwnedProcess({ executable: c.tunnelBinary, args: ["run", "--profile-file", profile, "--control-plane.tunnel-id", c.tunnelId], cwd: root, env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(), CONTROL_PLANE_API_KEY: secret, S7_MCP_AUTH: `Bearer ${token}` } });
        await tunnel.start();
        tunnelStartedAt = Date.now();
      });
    } catch { components.tunnel = { ready: false, reason: "startup_or_binding_failed" }; }
    finally {
      busy = false;
      atomicJson(path.join(root, "status.json"), { at: new Date().toISOString(), controller: { pid: process.pid, port: c.port }, components, recovery: recovery.status() });
    }
  };
  controller = await startController({ root, port: c.port, token, dependencies, recovery, repositories: c.repositories, registerCoordinator: (task) => registerCoordinator(c.coordinator, task), recover: recheck });
  // One budget owner: runtime; the controller sends explicit recovery requests.
  let previous = Date.now();
  let network = sha(JSON.stringify(os.networkInterfaces()));
  const timer = setInterval(() => {
    const now = Date.now(); const sample = sha(JSON.stringify(os.networkInterfaces()));
    if (now - previous > 30_000) recovery.event("wake", String(now));
    if (sample !== network) recovery.event("network", sample);
    previous = now; network = sample;
    void recheck();
  }, 10_000);
  const close = async () => { if (shuttingDown) return; shuttingDown = true; clearInterval(timer); await tunnel?.stop(); await controller.close(); };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close().then(() => process.exit(0)); });
  await recheck();
  return { controller, close };
}

async function main() {
  const [action, file] = process.argv.slice(2);
  if (action === "run" && file) { await runRuntime(path.resolve(file)); return; }
  if (action === "status" && file) {
    const c = readRuntimeConfig(path.resolve(file));
    try { const response = await fetch(`http://127.0.0.1:${c.port}/readyz`, { signal: AbortSignal.timeout(5000) }); console.log(JSON.stringify(await response.json())); }
    catch { console.log(JSON.stringify({ ready: false, controller: { ready: false, reason: "unreachable" } })); process.exitCode = 1; }
    return;
  }
  throw new Error("usage: s7-runtime.mjs {run|status} /absolute/config.json");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(() => { console.error("S7 runtime unavailable; check reviewed configuration and component state"); process.exitCode = 1; });
