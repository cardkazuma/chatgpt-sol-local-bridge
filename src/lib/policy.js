import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APPROVAL_VERIFIER_COMMAND,
  APPROVAL_VERIFIER_SHA256,
  DESTRUCTIVE_APPROVAL_MODE,
  DESTRUCTIVE_AUDIT_FAIL_CLOSED,
  DESTRUCTIVE_TOKEN_TTL_MS,
  PENDING_FILE,
  atomicWriteJson,
  ensureStateDirs,
} from "./config.js";
import { auditEvent } from "./audit.js";
import { clip } from "./text.js";

export const DESTRUCTIVE_PATTERNS = [
  { id: "rm", re: /(^|[;&|()]|\s)(?:(?:\/[A-Za-z0-9._+-]+)+\/)?rm(?:\s|$)/i },
  { id: "rmdir", re: /(^|[;&|()]|\s)(?:rmdir|unlink|shred|srm|trash)(?:\s|$)/i },
  { id: "find-delete", re: /\bfind\b[^\n]*\s-delete\b/i },
  { id: "truncate", re: /\btruncate\b|:\s*>\s*\S+|\bClear-Content\b/i },
  { id: "windows-delete", re: /(^|[&|()]|\s)(?:del|erase|rd)(?:\s+\/[a-z]+)*\s+/i },
  { id: "powershell-delete", re: /\b(?:Remove-Item|Clear-RecycleBin)\b/i },
  { id: "disk-destructive", re: /\b(?:mkfs(?:\.\w+)?|diskpart\s+clean|format\s+[a-z]:|dd\s+(?:if|of)=)/i },
  { id: "interpreter-delete", re: /\b(?:os\.(?:remove|unlink)|shutil\.rmtree|pathlib\.Path\([^)]*\)\.(?:unlink|rmdir)|fs\.(?:rm|unlink|rmdir)(?:Sync)?|File\.(?:delete|unlink))\b/i },
  { id: "git-clean", re: /\bgit\s+(?:-[^\s]+\s+)*clean\b/i },
  { id: "git-reset-hard", re: /\bgit\s+(?:-[^\s]+\s+)*reset\b[^\n]*--hard\b/i },
  { id: "git-checkout-files", re: /\bgit\s+(?:-[^\s]+\s+)*checkout\b[^\n]*\s--(?:\s|$)/i },
  { id: "git-switch-discard", re: /\bgit\s+(?:-[^\s]+\s+)*switch\b[^\n]*(?:--discard-changes|--force|-f)(?:\s|$)/i },
  { id: "git-restore", re: /\bgit\s+(?:-[^\s]+\s+)*restore\b/i },
  { id: "git-branch-delete", re: /\bgit\s+(?:-[^\s]+\s+)*branch\s+(?:-[dD]|--delete|--force-delete)\b/i },
  { id: "git-tag-delete", re: /\bgit\s+(?:-[^\s]+\s+)*tag\s+(?:-d|--delete)\b/i },
  { id: "git-ref-delete", re: /\bgit\s+(?:-[^\s]+\s+)*(?:update-ref\s+(?:-d|--delete)|remote\s+(?:remove|rm)|stash\s+(?:drop|clear)|worktree\s+(?:remove|prune)|reflog\s+(?:delete|expire)|notes\s+(?:remove|prune))\b/i },
  { id: "git-force-push", re: /\bgit\s+(?:-[^\s]+\s+)*push\b[^\n]*(?:--force(?:-with-lease)?|-f|--delete|\s:[^\s]+)(?:\s|$)/i },
  { id: "filesystem-api-delete", re: /\b(?:unlinkSync|rmSync|rmdirSync|deleteFile|deleteDirectory)\b/i },
  { id: "sql-delete", re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i },
  { id: "container-prune", re: /\b(?:docker|podman)\s+(?:system|image|container|volume)\s+prune\b/i },
  { id: "kubernetes-delete", re: /\bkubectl\s+delete\b/i },
  { id: "empty-trash", re: /\b(?:EmptyTrash|empty.?trash)\b/i },
];

export function inspectDestructive(command) {
  const text = String(command || "").trim();
  const scanText = text.replace(/["'`]/g, " ");
  const matches = text ? DESTRUCTIVE_PATTERNS.filter(({ re }) => re.test(text) || re.test(scanText)).map(({ id }) => id) : [];
  return { destructive: matches.length > 0, matches, command: text };
}

export function looksDestructive(command) {
  return inspectDestructive(command).destructive;
}

export function inspectGitDestructive(argv) {
  const args = argv.map((value) => String(value).toLowerCase());
  const commandIndex = args.findIndex((value) => !value.startsWith("-"));
  if (commandIndex < 0) return { destructive: false, matches: [] };
  const command = args[commandIndex];
  const rest = args.slice(commandIndex + 1);
  const has = (...flags) => rest.some((value) => flags.includes(value));
  const matches = [];
  if (command === "rm" || command === "clean") matches.push(`git-${command}`);
  if (command === "reset" && has("--hard")) matches.push("git-reset-hard");
  if (command === "restore") matches.push("git-restore");
  if (command === "checkout" && (has("--", "-f", "--force"))) matches.push("git-checkout-discard");
  if (command === "switch" && has("--discard-changes", "-f", "--force")) matches.push("git-switch-discard");
  if (command === "branch" && has("-d", "-D", "--delete", "--force-delete")) matches.push("git-branch-delete");
  if (command === "tag" && has("-d", "--delete")) matches.push("git-tag-delete");
  if (command === "push" && (has("-f", "--force", "--force-with-lease", "--delete") || rest.some((value) => /^:[^:]+/.test(value)))) matches.push("git-push-delete-or-force");
  if (command === "remote" && ["remove", "rm"].includes(rest[0])) matches.push("git-remote-delete");
  if (command === "stash" && ["drop", "clear"].includes(rest[0])) matches.push("git-stash-delete");
  if (command === "worktree" && ["remove", "prune"].includes(rest[0])) matches.push("git-worktree-delete");
  if (command === "update-ref" && has("-d", "--delete")) matches.push("git-ref-delete");
  if (command === "reflog" && ["delete", "expire"].includes(rest[0])) matches.push("git-reflog-delete");
  if (command === "notes" && ["remove", "prune"].includes(rest[0])) matches.push("git-notes-delete");
  return { destructive: matches.length > 0, matches };
}

export function queueDestructive(action) {
  ensureStateDirs();
  const pending = loadJson(PENDING_FILE);
  purgeExpired(pending);
  const token = `del_${crypto.randomBytes(16).toString("base64url")}`;
  const now = Date.now();
  const normalized = normalizeAction(action);
  pending[token] = {
    ...normalized,
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DESTRUCTIVE_TOKEN_TTL_MS).toISOString(),
    fingerprint: fingerprint(normalized),
    approvalMode: DESTRUCTIVE_APPROVAL_MODE,
  };
  const audited = auditEvent("destructive.preview", {
    approvalToken: token,
    fingerprint: pending[token].fingerprint,
    kind: pending[token].kind,
    cwd: pending[token].cwd,
    path: pending[token].path,
    preview: preview(pending[token]),
  });
  if (!audited && DESTRUCTIVE_AUDIT_FAIL_CLOSED) throw new Error("destructive action blocked because audit persistence failed");
  atomicWriteJson(PENDING_FILE, pending);
  return pending[token];
}

export function listPending() {
  ensureStateDirs();
  const pending = loadJson(PENDING_FILE);
  const changed = purgeExpired(pending);
  if (changed) atomicWriteJson(PENDING_FILE, pending);
  return Object.values(pending).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function takeDestructive(token, { userSaidYes = false } = {}) {
  const pending = loadJson(PENDING_FILE);
  const changed = purgeExpired(pending);
  const item = pending[token];
  if (!item) {
    if (changed) atomicWriteJson(PENDING_FILE, pending);
    return { error: "unknown, expired, or already-used destructive token" };
  }
  if (!userSaidYes) return { error: "userSaidYes must be true; never self-approve destructive work" };
  if (DESTRUCTIVE_APPROVAL_MODE === "deny") return { error: "destructive execution is disabled; configure chat or external approval mode intentionally" };
  if (DESTRUCTIVE_APPROVAL_MODE === "external") {
    const verification = verifyExternalApproval(token, item.fingerprint);
    if (!verification.ok) return { error: verification.error };
  }
  const audited = auditEvent("destructive.approved", {
    approvalToken: token,
    fingerprint: item.fingerprint,
    kind: item.kind,
    approvalMode: DESTRUCTIVE_APPROVAL_MODE,
    cwd: item.cwd,
    path: item.path,
  });
  if (!audited && DESTRUCTIVE_AUDIT_FAIL_CLOSED) return { error: "destructive action blocked because audit persistence failed" };
  delete pending[token];
  atomicWriteJson(PENDING_FILE, pending);
  return { item };
}

export function denyDeleteMessage(item) {
  return [
    "DELETE BLOCKED — no destructive command was executed.",
    `Token: ${item.token}`,
    `Expires: ${item.expiresAt}`,
    `Preview: ${preview(item)}`,
    DESTRUCTIVE_APPROVAL_MODE === "deny"
      ? "Destructive execution is disabled by configuration; this preview cannot be executed."
      : "Show this preview to the human. Only after an explicit yes, call confirm_destructive with this exact token and userSaidYes=true.",
    DESTRUCTIVE_APPROVAL_MODE === "external" ? "The configured external verifier must also report this token/fingerprint as human-approved." : "",
  ].filter(Boolean).join("\n");
}

function normalizeAction(action) {
  const out = { ...action };
  for (const key of ["command", "action", "summary", "cwd", "path"]) {
    if (out[key] != null) out[key] = String(out[key]);
  }
  if (out.diff != null) out.diff = String(out.diff);
  return out;
}

function preview(item) {
  const display = {
    kind: item.kind,
    summary: item.summary,
    cwd: item.cwd,
    path: item.path,
    command: item.command ? clip(item.command, 4_000) : undefined,
    action: item.action ? clip(item.action, 4_000) : undefined,
    tool: item.tool,
    request: item.request ? {
      method: item.request.method || "GET",
      url: item.request.url,
      bodySha256: item.request.body == null ? undefined : crypto.createHash("sha256").update(String(item.request.body)).digest("hex"),
      headerNames: Object.keys(item.request.headers || {}).sort(),
    } : undefined,
    diffSha256: item.diff == null ? undefined : crypto.createHash("sha256").update(item.diff).digest("hex"),
    diffPreview: item.diff == null ? item.diffPreview : clip(item.diff, 4_000),
    fingerprint: item.fingerprint,
  };
  return clip(JSON.stringify(display, null, 2), 8_000);
}

function fingerprint(value) {
  const stable = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return crypto.createHash("sha256").update(stable).digest("hex");
}

function purgeExpired(map) {
  let changed = false;
  const now = Date.now();
  for (const [token, item] of Object.entries(map)) {
    if (!item.expiresAt || Date.parse(item.expiresAt) <= now) {
      delete map[token];
      changed = true;
    }
  }
  return changed;
}

function verifyExternalApproval(token, fingerprintValue) {
  if (!APPROVAL_VERIFIER_COMMAND) return { ok: false, error: "APPROVAL_VERIFIER_COMMAND is required for external approval mode" };
  if (!path.isAbsolute(APPROVAL_VERIFIER_COMMAND)) return { ok: false, error: "APPROVAL_VERIFIER_COMMAND must be an absolute executable path" };
  if (!/^[a-f0-9]{64}$/i.test(APPROVAL_VERIFIER_SHA256)) return { ok: false, error: "APPROVAL_VERIFIER_SHA256 must pin the verifier executable" };
  try {
    const stat = fs.lstatSync(APPROVAL_VERIFIER_COMMAND);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: "external verifier must be a regular non-symlink executable" };
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(APPROVAL_VERIFIER_COMMAND)).digest("hex");
    if (actualHash !== APPROVAL_VERIFIER_SHA256.toLowerCase()) return { ok: false, error: "external verifier hash mismatch" };
  } catch (error) {
    return { ok: false, error: `external verifier validation failed: ${error.message}` };
  }
  const result = spawnSync(APPROVAL_VERIFIER_COMMAND, ["verify", token, fingerprintValue], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", USERPROFILE: process.env.USERPROFILE || "" },
  });
  return result.status === 0
    ? { ok: true }
    : { ok: false, error: clip(result.stderr || result.stdout || "external verifier denied approval", 2_000) };
}

function loadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
