#!/usr/bin/env node

import readline from "node:readline";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { S6GitHubBroker, dispatchS6BrokerRequest } from "./s6-github-broker.mjs";

const SIDECAR_IMAGE = "node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const managerRoot = path.resolve(args["manager-root"] || "");
const sessionId = String(args.session || "");
const volumeName = String(args.volume || "");
const proxyName = String(args["proxy-name"] || "");
if (!/^s6-[a-z0-9]+-[0-9a-f]{12}-transport$/.test(volumeName) || !/^s6-[a-z0-9]+-[0-9a-f]{12}-broker-proxy$/.test(proxyName)) throw new Error("S6 broker proxy resource identity is invalid");

const broker = new S6GitHubBroker({ managerRoot, bridgeRoot: repoRoot, sessionId });
const authState = { capability: null };
const proxyScript = path.join(repoRoot, "scripts", "s6-broker-channel-proxy.mjs");
const child = spawn("docker", [
  "run", "--rm", "-i", "--name", proxyName, "--platform", "linux/amd64", "--user", "10001:10001",
  "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "128m",
  "--network", "none", "--log-driver", "none", "--mount", `type=volume,src=${volumeName},dst=/transport`,
  "--mount", `type=bind,src=${proxyScript},dst=/opt/s6-broker-channel-proxy.mjs,readonly`,
  SIDECAR_IMAGE, "node", "/opt/s6-broker-channel-proxy.mjs",
], { cwd: repoRoot, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: managerRoot, LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });

let ready = false;
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  if (!ready && stderr.includes("S6_PROXY_READY")) {
    ready = true;
    process.stdout.write("S6_BROKER_READY\n");
  }
});

const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", async (line) => {
  let envelope;
  try { envelope = JSON.parse(line); } catch { return; }
  if (!Number.isSafeInteger(envelope?.id) || !envelope.request) return;
  let response;
  try { response = await dispatchS6BrokerRequest(broker, authState, envelope.request); }
  catch (error) { response = { error: String(error.message || "broker request failed").slice(0, 400) }; }
  child.stdin.write(`${JSON.stringify({ id: envelope.id, response })}\n`);
});

const close = () => {
  spawnSync("docker", ["stop", "-t", "2", proxyName], { stdio: "ignore", timeout: 5_000 });
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
child.on("exit", (code) => { if (!ready) process.stderr.write(`S6 broker proxy exited before readiness (${code ?? "unknown"})\n`); process.exit(code ?? 1); });

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const [key, inline] = item.slice(2).split("=", 2);
    out[key] = inline ?? values[++index];
  }
  return out;
}
