import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogVersionForProfile, parseEnabledTools, toolCatalogForProfile } from "../tool-contract.js";
import { normalizeHost } from "./net.js";

const HOME = os.homedir();
export const BRIDGE_PROFILE = readEnum("BRIDGE_PROFILE", "legacy", ["legacy", "host"]);
const DEFAULT_STATE_DIR = BRIDGE_PROFILE === "host"
  ? path.join(HOME, ".chatgpt-sol-local-bridge", "host-v1")
  : path.join(HOME, ".chatgpt-sol-local-bridge");

export const APP_NAME = "chatgpt-sol-local-bridge";
export const APP_VERSION = "1.0.0-s1";
export const STATE_DIR = path.resolve(expandHome(process.env.BRIDGE_STATE_DIR || DEFAULT_STATE_DIR));
export const STATE_FILE = path.join(STATE_DIR, "state.json");
export const LOG_DIR = path.join(STATE_DIR, "logs");
export const PROC_DIR = path.join(STATE_DIR, "processes");
export const HOST_WORKSPACE_INDEX_FILE = path.join(STATE_DIR, "workspaces.json");
export const HOST_WORKTREE_ROOT = path.resolve(expandHome(process.env.HOST_WORKTREE_ROOT || path.join(STATE_DIR, "worktrees")));
export const CAPTURE_DIR = path.join(STATE_DIR, "captures");
export const AUDIT_DIR = path.join(STATE_DIR, "audit");
export const AUDIT_FILE = path.join(AUDIT_DIR, "bridge.jsonl");
export const PENDING_FILE = path.join(STATE_DIR, "pending-destructive.json");
export const SCRATCH_DIR = path.resolve(expandHome(process.env.BRIDGE_SCRATCH_DIR || path.join(HOME, ".chatgpt-sol-local-bridge-scratch")));

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = readInteger("PORT", 8765, { min: 1, max: 65_535 });
export const MCP_UNIX_SOCKET_PATH = process.env.MCP_UNIX_SOCKET_PATH || "";
export const MCP_TOKEN = process.env.MCP_TOKEN || "";
export const BODY_LIMIT = process.env.BODY_LIMIT || "2mb";
export const COMMAND_TIMEOUT_MS = readInteger("COMMAND_TIMEOUT_MS", 120_000, { min: 1_000, max: 900_000 });
export const MAX_STDOUT_CHARS = readInteger("MAX_STDOUT_CHARS", 24_000, { min: 1_000, max: 1_000_000 });
export const MAX_STDERR_CHARS = readInteger("MAX_STDERR_CHARS", 12_000, { min: 1_000, max: 500_000 });
export const MAX_FETCH_BYTES = readInteger("MAX_FETCH_BYTES", 1_000_000, { min: 1_024, max: 10_000_000 });
export const MAX_OFFICE_FILE_BYTES = readInteger("MAX_OFFICE_FILE_BYTES", 10_000_000, { min: 100_000, max: 100_000_000 });
export const MAX_CONCURRENT_TOOLS = readInteger("MAX_CONCURRENT_TOOLS", 8, { min: 1, max: 64 });
export const MAX_PROCESS_LOG_BYTES = readInteger("MAX_PROCESS_LOG_BYTES", 10_000_000, { min: 100_000, max: 1_000_000_000 });
export const PROCESS_RETENTION_DAYS = readInteger("PROCESS_RETENTION_DAYS", 14, { min: 1, max: 365 });
export const MAX_PROCESS_RECORDS = readInteger("MAX_PROCESS_RECORDS", 500, { min: 10, max: 10_000 });
export const CODEX_BIN = process.env.CODEX_BIN || "codex";
export const INTERCEPTOR_BIN = process.env.INTERCEPTOR_BIN || "interceptor";
export const DESTRUCTIVE_AUDIT_FAIL_CLOSED = readBoolean("DESTRUCTIVE_AUDIT_FAIL_CLOSED", true);
export const DESTRUCTIVE_TOKEN_TTL_MS = readInteger("DESTRUCTIVE_TOKEN_TTL_MS", 600_000, { min: 60_000, max: 86_400_000 });
export const DESTRUCTIVE_APPROVAL_MODE = readEnum("DESTRUCTIVE_APPROVAL_MODE", "deny", ["deny", "chat", "external"]);
export const HARDENED_CONTAINER = readBoolean("BRIDGE_HARDENED", false);
export const APPROVAL_VERIFIER_COMMAND = process.env.APPROVAL_VERIFIER_COMMAND || "";
export const APPROVAL_VERIFIER_SHA256 = process.env.APPROVAL_VERIFIER_SHA256 || "";
export const ALLOW_PRIVATE_NETWORK = readBoolean("ALLOW_PRIVATE_NETWORK", false);
export const ALLOW_CROSS_ORIGIN_REDIRECTS = readBoolean("ALLOW_CROSS_ORIGIN_REDIRECTS", false);
export const ALLOW_TOOL_ROOT_REGISTRATION = readBoolean("ALLOW_TOOL_ROOT_REGISTRATION", false);
export const INCLUDE_COMMON_WORKSPACE_ROOTS = readBoolean("INCLUDE_COMMON_WORKSPACE_ROOTS", false);
export const INCLUDE_SCRATCH_ROOT = readBoolean("INCLUDE_SCRATCH_ROOT", true);
export const WEB_FETCH_ALLOW_HOSTS = splitList(process.env.WEB_FETCH_ALLOW_HOSTS || "");
export const TOOL_ENV_INHERIT_SECRETS = readBoolean("TOOL_ENV_INHERIT_SECRETS", false);
export const TOOL_ENV_ALLOWLIST = new Set(splitRawList(process.env.TOOL_ENV_ALLOWLIST || ""));
export const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE ? path.resolve(expandHome(process.env.DEFAULT_WORKSPACE)) : "";
export const TOOL_CATALOG_VERSION = catalogVersionForProfile(BRIDGE_PROFILE);
export const PROFILE_TOOL_CATALOG = toolCatalogForProfile(BRIDGE_PROFILE);
export const ENABLED_TOOLS = parseEnabledTools(process.env.ENABLED_TOOLS, BRIDGE_PROFILE);
export const ENABLED_TOOL_NAMES = Object.freeze(PROFILE_TOOL_CATALOG.map(({ name }) => name).filter((name) => ENABLED_TOOLS.has(name)));

if (HARDENED_CONTAINER && DESTRUCTIVE_APPROVAL_MODE !== "deny") {
  throw new Error("BRIDGE_HARDENED requires DESTRUCTIVE_APPROVAL_MODE=deny");
}
if (HARDENED_CONTAINER && (ALLOW_TOOL_ROOT_REGISTRATION || INCLUDE_COMMON_WORKSPACE_ROOTS || INCLUDE_SCRATCH_ROOT || TOOL_ENV_INHERIT_SECRETS || ALLOW_PRIVATE_NETWORK)) {
  throw new Error("BRIDGE_HARDENED rejects root expansion, scratch roots, inherited secrets, and private-network access");
}

export function builtInRoots(platform = process.platform) {
  if (!INCLUDE_COMMON_WORKSPACE_ROOTS) return [];
  const common = [
    path.join(HOME, "Desktop"),
    path.join(HOME, "Documents"),
    path.join(HOME, "Downloads"),
    path.join(HOME, "Developer"),
    path.join(HOME, "dev"),
    path.join(HOME, "src"),
    path.join(HOME, "projects"),
    path.join(HOME, "code"),
    path.join(HOME, "workspace"),
    path.join(HOME, "workspaces"),
    path.join(HOME, "ghq"),
  ];
  if (platform === "win32") {
    for (const envName of ["USERPROFILE", "OneDrive", "OneDriveCommercial"]) {
      if (process.env[envName]) common.push(process.env[envName]);
    }
  }
  return common.map((item) => path.resolve(item));
}

export function extraRoots() {
  return splitPathList(process.env.WORKSPACE_ROOTS || "").map((item) => path.resolve(expandHome(item)));
}

export function configuredDenyPaths() {
  const platformDefaults = process.platform === "win32"
    ? [
        process.env.WINDIR,
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.ProgramData,
        path.join(HOME, ".ssh"),
        path.join(HOME, ".aws"),
        path.join(HOME, ".kube"),
        path.join(process.env.APPDATA || HOME, "Microsoft", "Credentials"),
      ]
    : [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/private/etc",
        "/private/var/db",
        "/Library/Apple",
        path.join(HOME, "Library", "Keychains"),
        path.join(HOME, ".ssh"),
        path.join(HOME, ".aws"),
        path.join(HOME, ".kube"),
        path.join(HOME, ".config", "gcloud"),
      ];
  return [...platformDefaults, ...splitPathList(process.env.BRIDGE_DENY_PATHS || "")]
    .filter(Boolean)
    .map((item) => path.resolve(expandHome(item)));
}

export function ensureStateDirs() {
  for (const dir of [STATE_DIR, LOG_DIR, PROC_DIR, CAPTURE_DIR, AUDIT_DIR, SCRATCH_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function defaultState() {
  return {
    version: 1,
    currentWorkspace: DEFAULT_WORKSPACE,
    extraRoots: [],
  };
}

export function loadState() {
  ensureStateDirs();
  if (!fs.existsSync(STATE_FILE)) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return defaultState();
  }
}

export function saveState(next) {
  ensureStateDirs();
  atomicWriteJson(STATE_FILE, { ...defaultState(), ...next });
}

export function configuredWorkspaceRoots() {
  const state = loadState();
  return [...new Set([
    ...builtInRoots(),
    ...extraRoots(),
    ...(HARDENED_CONTAINER ? [] : (state.extraRoots || []).map((item) => path.resolve(item))),
  ])].filter(isDirectory);
}

export function workspaceRoots() {
  ensureStateDirs();
  return [...new Set([
    ...configuredWorkspaceRoots(),
    ...(INCLUDE_SCRATCH_ROOT ? [SCRATCH_DIR] : []),
  ])].filter(isDirectory);
}

export function validateRuntimeConfig(effectiveHost = HOST) {
  if (!isLoopbackHost(effectiveHost)) {
    throw new Error(`Refusing HOST=${effectiveHost}; this bridge is intentionally loopback-only. Put an independently authenticated TLS proxy in front only after a separate security review.`);
  }
  validateUnixSocketPath(MCP_UNIX_SOCKET_PATH);
}

export function validateUnixSocketPath(socketPath) {
  if (!socketPath) return;
  if (!path.isAbsolute(socketPath) || socketPath.includes("\0")) {
    throw new Error("MCP_UNIX_SOCKET_PATH must be an absolute Unix socket path");
  }
  if (path.posix.normalize(socketPath) !== socketPath) {
    throw new Error("MCP_UNIX_SOCKET_PATH must be normalized and must not contain traversal components");
  }
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error("MCP_UNIX_SOCKET_PATH is too long for a Unix domain socket");
  }
  if (HARDENED_CONTAINER && !(socketPath === "/transport" || socketPath.startsWith("/transport/"))) {
    throw new Error("BRIDGE_HARDENED requires MCP_UNIX_SOCKET_PATH under /transport");
  }
}

export function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(normalizeHost(host).toLowerCase());
}

export function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function expandHome(input) {
  if (!input) return input;
  if (input === "~") return HOME;
  if (String(input).startsWith("~/") || String(input).startsWith("~\\")) {
    return path.join(HOME, String(input).slice(2));
  }
  return input;
}

function splitPathList(value) {
  if (!value) return [];
  return value
    .split(new RegExp(`[${escapeRegExp(path.delimiter)}\\n]`))
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitList(value) {
  return splitRawList(value).map((item) => item.toLowerCase());
}

function splitRawList(value) {
  return String(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function readInteger(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function readEnum(name, fallback, allowed) {
  const value = process.env[name] || fallback;
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
