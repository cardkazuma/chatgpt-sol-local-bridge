#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_WORKSPACE,
  HOST,
  PORT,
  STATE_DIR,
  ENABLED_TOOL_NAMES,
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
  check("runtime config", "pass", `HOST=${HOST} PORT=${PORT} active=${ENABLED_TOOL_NAMES.length}`, true);
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

for (const binary of ["git", "rg"]) {
  check(binary, commandExists(binary) ? "pass" : "fail", commandExists(binary) ? version(binary) : "not found", true);
}

const platform = platformSummary();
for (const [capability, supported] of Object.entries(platform.capabilities)) {
  check(`platform:${capability}`, supported ? "pass" : "warn", supported ? `${platform.adapter} dependency detected (runtime permission/device probe still required)` : `${platform.adapter} backend dependency missing`);
}
check("tool contract", EXPECTED_TOOL_NAMES.length === 28 ? "pass" : "fail", `${EXPECTED_TOOL_NAMES.length} reviewed bridge catalog tools`, true);
check("runtime mode", process.env.BRIDGE_HARDENED === "true" ? "pass" : "warn", process.env.BRIDGE_HARDENED === "true" ? "hardened container requested" : "host mode; use the S1 container runtime for execution");

if (process.argv.includes("--live")) {
  try {
    const response = await fetch(httpUrl(HOST, PORT, "/readyz"));
    const body = await response.json();
    check("live bridge", response.ok && body.toolCount === ENABLED_TOOL_NAMES.length ? "pass" : "fail", `${response.status} tools=${body.toolCount}`, true);
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
