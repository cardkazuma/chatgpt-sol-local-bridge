#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_WORKSPACE,
  HOST,
  MCP_TOKEN,
  PORT,
  STATE_DIR,
  configuredWorkspaceRoots,
  ensureStateDirs,
  validateRuntimeConfig,
} from "./lib/config.js";
import { commandExists } from "./lib/exec.js";
import { httpUrl } from "./lib/net.js";
import { canonicalPath, isWithin } from "./lib/paths.js";
import { platformSummary } from "./platform/index.js";
import { EXPECTED_TOOL_NAMES } from "./tool-contract.js";

const checks = [];
const check = (name, status, detail, required = false) => checks.push({ name, status, detail, required });

const major = Number(process.versions.node.split(".")[0]);
check("Node.js", major >= 20 ? "pass" : "fail", process.version, true);
try {
  validateRuntimeConfig();
  check("runtime config", "pass", `HOST=${HOST} PORT=${PORT} auth=${MCP_TOKEN ? "bearer" : "loopback-only"}`, true);
} catch (error) {
  check("runtime config", "fail", error.message, true);
}
try {
  ensureStateDirs();
  const probe = path.join(STATE_DIR, `.doctor-${process.pid}`);
  fs.writeFileSync(probe, "ok", { mode: 0o600 });
  fs.unlinkSync(probe);
  check("state directory", "pass", STATE_DIR, true);
} catch (error) {
  check("state directory", "fail", error.message, true);
}

const roots = configuredWorkspaceRoots();
check("workspace roots", roots.length > 0 ? "pass" : "fail", roots.length ? roots.join(path.delimiter) : "none configured; set WORKSPACE_ROOTS", true);
if (DEFAULT_WORKSPACE) {
  let defaultValid = false;
  try {
    const target = canonicalPath(DEFAULT_WORKSPACE);
    defaultValid = roots.some((root) => isWithin(target, canonicalPath(root)));
  } catch {}
  check("default workspace", defaultValid ? "pass" : "fail", DEFAULT_WORKSPACE, true);
} else {
  check("default workspace", "warn", "not set; call workspace_open before project work");
}

for (const binary of ["git", "tunnel-client"]) {
  check(binary, commandExists(binary) ? "pass" : "fail", commandExists(binary) ? version(binary) : "not found", true);
}
for (const binary of ["rg", "codex", "interceptor", "ffmpeg", "tesseract"]) {
  check(binary, commandExists(binary) ? "pass" : "warn", commandExists(binary) ? version(binary) : "optional; corresponding tools will report unavailable");
}

const platform = platformSummary();
for (const [capability, supported] of Object.entries(platform.capabilities)) {
  check(`platform:${capability}`, supported ? "pass" : "warn", supported ? `${platform.adapter} dependency detected (runtime permission/device probe still required)` : `${platform.adapter} backend dependency missing`);
}
check("tool contract", EXPECTED_TOOL_NAMES.length === 44 ? "pass" : "fail", `${EXPECTED_TOOL_NAMES.length} declared tools`, true);
check("host", "pass", `${os.hostname()} ${process.platform}/${process.arch}`);
const tunnelId = process.env.CONTROL_PLANE_TUNNEL_ID || "";
const tunnelKey = process.env.CONTROL_PLANE_API_KEY || "";
check("tunnel id", tunnelId && !tunnelId.includes("REPLACE_ME") ? "pass" : "warn", tunnelId ? "configured" : "not present in this environment");
check("tunnel key", tunnelKey && !tunnelKey.includes("REPLACE_ME") ? "pass" : "warn", tunnelKey ? "configured (redacted)" : "not present in this environment");
const tunnelMode = process.argv.includes("--tunnel");
const tunnelProfile = process.env.TUNNEL_PROFILE || "sol-local-bridge";
if (commandExists("tunnel-client")) {
  const profilesResult = spawnSync("tunnel-client", ["profiles", "list", "--json"], { encoding: "utf8", timeout: 10_000 });
  let profileFound = false;
  try {
    const profiles = JSON.parse(profilesResult.stdout || "[]");
    profileFound = profiles.some((item) => (typeof item === "string" ? item : item.name || item.profile) === tunnelProfile);
  } catch {}
  check("tunnel profile", profileFound ? "pass" : tunnelMode ? "fail" : "warn", profileFound ? tunnelProfile : `${tunnelProfile} not found`, tunnelMode);
  if (tunnelMode && profileFound) {
    const result = spawnSync("tunnel-client", ["doctor", "--profile", tunnelProfile, "--explain"], { encoding: "utf8", timeout: 60_000, env: process.env });
    check("tunnel doctor", result.status === 0 ? "pass" : "fail", (result.status === 0 ? result.stdout : result.stderr || result.stdout).trim().slice(0, 500), true);
  }
}

if (process.argv.includes("--live")) {
  try {
    const response = await fetch(httpUrl(HOST, PORT, "/readyz"));
    const body = await response.json();
    check("live bridge", response.ok && body.toolCount === 44 ? "pass" : "fail", `${response.status} tools=${body.toolCount}`, true);
  } catch (error) {
    check("live bridge", "fail", error.message, true);
  }
}

const jsonMode = process.argv.includes("--json");
if (jsonMode) console.log(JSON.stringify({ name: APP_NAME, version: APP_VERSION, checks }, null, 2));
else {
  console.log(`${APP_NAME} doctor ${APP_VERSION}`);
  for (const item of checks) {
    const icon = item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "✗";
    console.log(`${icon} ${item.name.padEnd(24)} ${item.detail}`);
  }
}
const failed = checks.filter((item) => item.required && item.status === "fail");
if (failed.length) process.exitCode = 1;

function version(binary) {
  const probes = [["--version"], ["-version"], ["version"]];
  for (const args of probes) {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const text = `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/)[0];
    if (text) return text.slice(0, 160);
  }
  return "found";
}
