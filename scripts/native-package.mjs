#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { keychainStatus } from "./s5-credential.mjs";

export const NATIVE_TUNNEL_VERSION = "0.0.13+4b5267f823be0b046bb883aacb51603cfde3a0ea";
export const NATIVE_TUNNEL_SHA256 = "c5d1ab3ccf3aa402f631e2fac66c763fa0b1b82e6134e995c9a44bc6a06fb93c";
export const NATIVE_TUNNEL_ZIP_SHA256 = "c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c";
export const SERVER_LABEL = "com.cardkazuma.chatgpt-local-bridge.host.server";
export const TUNNEL_LABEL = "com.cardkazuma.chatgpt-local-bridge.host.tunnel";
export const NATIVE_DEVELOPER_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function verifyNativeArtifact({ binary, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "darwin" || !["x64", "x86_64"].includes(arch)) throw new Error("pinned native tunnel artifact requires Darwin x86_64");
  const resolved = path.resolve(String(binary || ""));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) throw new Error("native tunnel artifact must be an executable regular file");
  const help = spawnSync(resolved, ["run", "--help"], { encoding: "utf8", timeout: 15_000 });
  return verifyNativeArtifactEvidence({
    binary: resolved,
    bytes: fs.readFileSync(resolved),
    helpStatus: help.status,
    helpOutput: `${help.stdout || ""}\n${help.stderr || ""}`,
    platform,
    arch,
  });
}

export function verifyNativeArtifactEvidence({
  binary, bytes, helpStatus, helpOutput, platform, arch,
  expectedSha256 = NATIVE_TUNNEL_SHA256,
  expectedVersion = NATIVE_TUNNEL_VERSION,
} = {}) {
  if (platform !== "darwin" || !["x64", "x86_64"].includes(arch)) throw new Error("pinned native tunnel artifact requires Darwin x86_64");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) throw new Error("native tunnel artifact hash mismatch");
  const output = String(helpOutput || "");
  const version = output.match(/run version ([^\s]+)/)?.[1] || "";
  if (helpStatus !== 0 || version !== expectedVersion) throw new Error("native tunnel command/version compatibility failed");
  for (const flag of ["--control-plane.api-key", "--mcp.server-url", "--mcp.extra-headers", "--health.url-file"]) {
    if (!output.includes(flag)) throw new Error(`native tunnel missing required flag ${flag}`);
  }
  return { binary: path.resolve(String(binary || "")), sha256, version, platform: "darwin", arch: "x86_64" };
}

export function renderNativePackage({ outputDir, repoRoot, nodePath, tunnelPath, tunnelId, port = 8765 } = {}) {
  const root = path.resolve(String(outputDir || ""));
  const repo = path.resolve(String(repoRoot || ""));
  if (!path.isAbsolute(String(outputDir || "")) || !fs.existsSync(path.join(repo, "src", "server.js"))) throw new Error("native package requires explicit output and repository roots");
  if (!path.isAbsolute(String(nodePath || "")) || !path.isAbsolute(String(tunnelPath || ""))) throw new Error("native package binaries must use absolute paths");
  if (!/^tunnel_[A-Za-z0-9]+$/.test(String(tunnelId || ""))) throw new Error("native package tunnel identifier is invalid");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const runtimeFile = path.join(root, "runtime.json");
  const profileFile = path.join(root, "tunnel-profile.yaml");
  const config = { version: 1, repoRoot: repo, nodePath, tunnelPath, tunnelId, port, profileFile, stateRoot: path.join(root, "state") };
  writePrivate(runtimeFile, `${JSON.stringify(config, null, 2)}\n`);
  writePrivate(profileFile, [
    "config_version: 1", "control_plane:", '  base_url: "https://api.openai.com"', '  api_key: "env:CONTROL_PLANE_API_KEY"',
    "health:", '  listen_addr: "127.0.0.1:8080"', "admin_ui:", "  open_browser: false", "log:", "  level: info", "  format: json",
    "mcp:", "  server_urls:", "    - channel: main", `      url: "http://127.0.0.1:${port}/mcp"`, "  extra_headers:", '    Authorization: "env:BRIDGE_LOCAL_AUTH"',
    "  discovery_extra_headers:", '    Authorization: "env:BRIDGE_LOCAL_AUTH"', "",
  ].join("\n"));
  const serverPlist = path.join(root, `${SERVER_LABEL}.plist`);
  const tunnelPlist = path.join(root, `${TUNNEL_LABEL}.plist`);
  writePrivate(serverPlist, plist(SERVER_LABEL, nodePath, [path.join(repo, "scripts", "native-supervisor.mjs"), "server", runtimeFile], repo, root));
  writePrivate(tunnelPlist, plist(TUNNEL_LABEL, nodePath, [path.join(repo, "scripts", "native-supervisor.mjs"), "tunnel", runtimeFile], repo, root));
  return { installed: false, outputDir: root, files: [runtimeFile, profileFile, serverPlist, tunnelPlist] };
}

export async function boundedRecovery({ component, restart, maxAttempts = 5, windowMs = 600_000, delay = wait, now = Date.now } = {}) {
  if (!["server", "tunnel"].includes(component) || typeof restart !== "function") throw new Error("bounded recovery component/restart is invalid");
  const started = now();
  let last = { healthy: false, reason: "not attempted" };
  let attempts = 0;
  while (attempts < maxAttempts && now() - started <= windowMs) {
    attempts += 1;
    last = await restart(component);
    if (last?.healthy) return { state: "READY", component, attempts };
    if (attempts < maxAttempts) await delay(Math.min(120_000, 2 ** (attempts - 1) * 5_000));
  }
  return { state: "DEGRADED", component, attempts, reason: String(last?.reason || "recovery failed").slice(0, 500) };
}

export async function waitForNativeServerReady({
  probe, timeoutMs = 30_000, intervalMs = 100, delay = wait, now = Date.now,
} = {}) {
  if (typeof probe !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("native server readiness parameters are invalid");
  }
  const startedAt = now();
  let lastReason = "server unavailable";
  while (now() - startedAt <= timeoutMs) {
    try {
      const value = await probe();
      if (value?.ready === true && value.catalogVersion === "daily-use-v2") return value;
      lastReason = value?.reason || (value?.ready ? "catalog mismatch" : "server unavailable");
    } catch (error) {
      lastReason = String(error.message || error).slice(0, 300);
    }
    await delay(intervalMs);
  }
  throw new Error(`native server did not become daily-use ready: ${String(lastReason).slice(0, 300)}`);
}

export async function nativeStatus({ catalogProbe, tunnelProbe, keychainProbe = keychainStatus } = {}) {
  const serverValue = await catalogProbe();
  const tunnelValue = await tunnelProbe();
  const keychainValue = keychainProbe();
  const server = serverValue?.ready && serverValue.catalogVersion === "daily-use-v2"
    ? { state: "READY", catalogVersion: serverValue.catalogVersion }
    : { state: serverValue?.ready ? "CATALOG_STALE" : "OFFLINE", reason: serverValue?.reason || "server unavailable" };
  const tunnel = tunnelValue?.ready ? { state: "READY" } : { state: "OFFLINE", reason: tunnelValue?.reason || "tunnel unavailable" };
  const keychain = keychainValue?.available ? { state: "AVAILABLE" } : { state: "LOCKED_OR_UNAVAILABLE", reason: keychainValue?.reason || "Keychain unavailable" };
  return { ready: server.state === "READY" && tunnel.state === "READY" && keychain.state === "AVAILABLE", server, tunnel, keychain };
}

function plist(label, program, args, workingDirectory, outputRoot) {
  const values = [program, ...args].map((value) => `<string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${values}</array>\n<key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(NATIVE_DEVELOPER_PATH)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>120</integer>\n<key>ProcessType</key><string>Interactive</string>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(path.join(outputRoot, `${label}.out.log`))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(outputRoot, `${label}.err.log`))}</string>\n</dict></plist>\n`;
}

function writePrivate(target, content) {
  fs.writeFileSync(target, content, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.error("Use this module through the documented native-runtime command; it never installs LaunchAgents itself.");
  process.exitCode = 2;
}
