#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { withTunnelClientEnvFile } from "./s5-credential.mjs";

const [component, configPath] = process.argv.slice(2);
const config = readConfig(configPath);
const tokenFile = path.join(config.stateRoot, "local-auth-token");

if (component === "server") await runServer();
else if (component === "tunnel") await runTunnel();
else throw new Error("native launcher component must be server or tunnel");

async function runServer() {
  const token = localToken();
  await child(config.nodePath, [path.join(config.repoRoot, "src", "server.js")], {
    ...process.env,
    BRIDGE_PROFILE: "host",
    BRIDGE_STATE_DIR: path.join(config.stateRoot, "bridge"),
    HOST_WORKTREE_ROOT: path.join(config.stateRoot, "worktrees"),
    HOST: "127.0.0.1",
    PORT: String(config.port),
    MCP_TOKEN: token,
  });
}

async function runTunnel() {
  const token = readToken();
  await withTunnelClientEnvFile({ tempRoot: path.join(config.stateRoot, "credential-tmp") }, async (envFile) => {
    await child(config.nodePath, [path.join(config.repoRoot, "scripts", "run-with-env.mjs"), envFile, "--", config.tunnelPath, "run", "--config", config.profileFile], {
      ...process.env,
      CONTROL_PLANE_TUNNEL_ID: config.tunnelId,
      BRIDGE_LOCAL_AUTH: `Bearer ${token}`,
    });
  });
}

function localToken() {
  fs.mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.stateRoot, 0o700);
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  return readToken();
}

function readToken() {
  const stat = fs.lstatSync(tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("native local auth token is unavailable or unsafe");
  const value = fs.readFileSync(tokenFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("native local auth token is invalid");
  return value;
}

function child(file, args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { cwd: config.repoRoot, env, stdio: "inherit", shell: false });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => proc.kill(signal));
    proc.once("error", reject);
    proc.once("exit", (code, signal) => signal ? reject(new Error(`native ${component} exited on ${signal}`)) : code === 0 ? resolve() : reject(new Error(`native ${component} exited ${code}`)));
  });
}

function readConfig(file) {
  if (!path.isAbsolute(String(file || ""))) throw new Error("native runtime config path must be absolute");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const required = ["nodePath", "port", "profileFile", "repoRoot", "stateRoot", "tunnelId", "tunnelPath", "version"];
  if (!value || Object.keys(value).sort().join(",") !== required.sort().join(",") || value.version !== 1) throw new Error("native runtime config is invalid");
  return value;
}
