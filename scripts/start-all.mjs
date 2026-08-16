#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.BRIDGE_ENV_FILE || defaultEnvPath();
if (!fs.existsSync(envFile)) throw new Error(`runtime env file not found: ${envFile}`);
verifySecretFile(envFile);
const env = { ...process.env, ...dotenv.parse(fs.readFileSync(envFile)) };
const profile = env.TUNNEL_PROFILE || "sol-local-bridge";
const serverEnv = { ...env };
delete serverEnv.CONTROL_PLANE_API_KEY;
const children = [
  spawn(process.execPath, [path.join(repo, "src", "server.js")], { cwd: repo, env: serverEnv, stdio: "inherit", shell: false }),
  spawn(process.execPath, [path.join(repo, "scripts", "run-tunnel.mjs"), env.TUNNEL_CLIENT_BIN || "tunnel-client"], { cwd: repo, env: { ...env, TUNNEL_PROFILE: profile }, stdio: "inherit", shell: false }),
];
let closing = false;
const shutdown = (signal = "SIGTERM") => {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(signal));
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    shutdown();
  });
  child.on("exit", (code) => {
    if (!closing) {
      console.error(`child exited with code ${code}`);
      process.exitCode = code || 1;
      shutdown();
    }
  });
}

function verifySecretFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular, non-symlink file`);
  if (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw new Error(`${filePath} must be owned by the current user and mode 0600`);
  }
}

function defaultEnvPath() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "chatgpt-sol-local-bridge", "runtime.env");
  return path.join(os.homedir(), ".config", "chatgpt-sol-local-bridge", "runtime.env");
}
