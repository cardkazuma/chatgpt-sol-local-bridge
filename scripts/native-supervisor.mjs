#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const [component, configPath] = process.argv.slice(2);
if (!["server", "tunnel"].includes(component) || !path.isAbsolute(String(configPath || ""))) throw new Error("native supervisor requires component and absolute config path");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const recoveryFile = path.join(config.stateRoot, `${component}-recovery.json`);
fs.mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });
const prior = readRecovery();
const now = Date.now();
const attempts = prior && now - prior.windowStartedAt <= 600_000 ? prior.attempts : 0;
if (attempts >= 5) process.exit(0);
writeRecovery({ version: 1, state: "STARTING", attempts: attempts + 1, windowStartedAt: prior?.windowStartedAt || now, updatedAt: new Date().toISOString() });
const child = spawn(config.nodePath, [path.join(config.repoRoot, "scripts", "native-host-launcher.mjs"), component, configPath], { cwd: config.repoRoot, stdio: "inherit", shell: false });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
  writeRecovery({ version: 1, state: "DEGRADED", attempts: attempts + 1, windowStartedAt: prior?.windowStartedAt || now, reason: String(error.message).slice(0, 500), updatedAt: new Date().toISOString() });
  process.exitCode = attempts + 1 >= 5 ? 0 : 1;
});
child.once("exit", (code, signal) => {
  if (code === 0 && !signal) {
    try { fs.unlinkSync(recoveryFile); } catch {}
    process.exitCode = 0;
    return;
  }
  writeRecovery({ version: 1, state: attempts + 1 >= 5 ? "DEGRADED" : "RETRY", attempts: attempts + 1, windowStartedAt: prior?.windowStartedAt || now, reason: signal || `exit ${code}`, updatedAt: new Date().toISOString() });
  process.exitCode = attempts + 1 >= 5 ? 0 : 1;
});

function readRecovery() {
  try { return JSON.parse(fs.readFileSync(recoveryFile, "utf8")); } catch { return null; }
}
function writeRecovery(value) {
  const tmp = `${recoveryFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, recoveryFile);
}
