#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// This module is the single path-policy implementation used by both the
// reviewed local commit hook and the S6 publish broker. Keep decisions based
// on repository-relative names; never turn an untrusted name into a path
// before it has passed this classifier.
export const DENIED_DIRECTORY_NAMES = Object.freeze(new Set([
  ".git", "node_modules", ".ds_store", ".storage", ".venv", "__pycache__",
  "backups", "backup", "runtime", "logs", "log", "secrets", "credentials", "private",
]));

export const DENIED_FILE_PATTERNS = Object.freeze([
  /^\.env(?:\..*)?$/i,
  /^db\.env$/i,
  /^secrets?\.(?:ya?ml|json)$/i,
  /(?:^|[._-])(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)(?:$|[._-])/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
  /\.(?:db|sqlite|sqlite3|wal|shm|dump|bak|backup)$/i,
  /\.log$/i,
]);

const HIGH_RISK_GOVERNANCE_PATTERNS = Object.freeze([
  /^\.github\/workflows(?:\/|$)/i,
  /^\.githooks(?:\/|$)/i,
  /^scripts\/pre-commit-policy\.mjs$/i,
  /^\.gitmodules$/i,
]);

export function normalizeRepositoryName(name) {
  const value = String(name ?? "");
  if (!value || /[\0\r\n]/.test(value) || value.startsWith("/") || value.includes("\\")) return "";
  const normalized = value.split("/").filter(Boolean).join("/");
  if (normalized !== value || normalized.split("/").some((part) => part === "." || part === "..")) return "";
  return normalized;
}

export function classifyPolicyPath(name) {
  const normalized = normalizeRepositoryName(name);
  if (!normalized) return { allowed: false, reason: "invalid repository-relative path", path: String(name ?? "") };
  const parts = normalized.split("/").map((part) => part.toLowerCase());
  const base = parts.at(-1) || "";
  if (base === ".env.example") return { allowed: true, reason: "example placeholder", path: normalized };
  if (parts.slice(0, -1).some((part) => DENIED_DIRECTORY_NAMES.has(part))) {
    return { allowed: false, reason: "secret-sensitive or runtime directory", path: normalized };
  }
  if (DENIED_FILE_PATTERNS.some((pattern) => pattern.test(base))) {
    return { allowed: false, reason: "secret-sensitive or runtime filename", path: normalized };
  }
  return { allowed: true, reason: "allowed", path: normalized };
}

export function isDenied(name) {
  return !classifyPolicyPath(name).allowed;
}

export function isHighRiskGovernancePath(name) {
  const normalized = normalizeRepositoryName(name);
  return Boolean(normalized && HIGH_RISK_GOVERNANCE_PATTERNS.some((pattern) => pattern.test(normalized)));
}

export function classifyPublishPath(name) {
  const policy = classifyPolicyPath(name);
  if (!policy.allowed) return policy;
  if (isHighRiskGovernancePath(policy.path)) {
    return { allowed: false, reason: "S6 fail-closed governance or automation path", path: policy.path, highRisk: true };
  }
  return { ...policy, highRisk: false };
}

export function runPreCommitPolicy({ cwd = process.cwd(), output = process.stderr } = {}) {
  // The bridge invokes Git with --literal-pathspecs. Git propagates that
  // setting to hooks, but check-ignore does not accept that pathspec mode.
  delete process.env.GIT_LITERAL_PATHSPECS;
  const root = execFileSync("git", ["-c", "safe.directory=*", "rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  const configuredHookPath = execFileSync("git", ["-c", `safe.directory=${root}`, "config", "--local", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" }).trim();
  const expectedHookPath = process.env.BRIDGE_REVIEWED_HOOKS_PATH || ".githooks";
  if (configuredHookPath !== expectedHookPath) throw new Error(`pre-commit refused: core.hooksPath must be exactly ${expectedHookPath}`);

  const names = execFileSync("git", ["-c", `safe.directory=${root}`, "diff", "--cached", "--name-only", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const name of names) {
    const decision = classifyPolicyPath(name);
    if (!decision.allowed) throw new Error(`pre-commit refused ${decision.reason}: ${name}`);
    const ignored = spawnSync("git", ["-c", `safe.directory=${root}`, "check-ignore", "--no-index", "--quiet", "--", name], { cwd: root, encoding: "utf8" });
    if (ignored.status === 0) throw new Error(`pre-commit refused repository-ignored path: ${name}`);
    if (ignored.status !== 1) throw new Error(`pre-commit could not verify ignored state: ${name}${ignored.stderr ? ` (${ignored.stderr.trim()})` : ""}`);
    const absolute = path.join(root, name);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`pre-commit refused staged symlink: ${name}`);
    }
  }
  const check = execFileSync("git", ["-c", `safe.directory=${root}`, "diff", "--cached", "--check"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (check) output.write(check);
  const label = process.env.BRIDGE_GOVERNANCE_MODE === "s6" ? "S6" : "S1";
  output.write(`${label} pre-commit policy passed (${names.length} path${names.length === 1 ? "" : "s"})\n`);
  return { root, names };
}

if (path.basename(process.argv[1] || "") === "pre-commit-policy.mjs") {
  try {
    runPreCommitPolicy();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
