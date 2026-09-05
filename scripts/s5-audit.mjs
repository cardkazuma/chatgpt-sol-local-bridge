import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUDIT_FILE_NAME = "events.jsonl";
export const AUDIT_MAX_BYTES = 256 * 1024;
export const AUDIT_ROTATIONS = 3;

export function auditPaths(root, rotations = AUDIT_ROTATIONS) {
  const directory = path.resolve(root);
  return {
    directory,
    current: path.join(directory, AUDIT_FILE_NAME),
    rotated: Array.from({ length: rotations }, (_, index) => path.join(directory, `events.${index + 1}.jsonl`)),
  };
}

export function appendAudit(root, { operation, sessionId = null, result, detail = {} } = {}, {
  maxBytes = AUDIT_MAX_BYTES,
  rotations = AUDIT_ROTATIONS,
  now = new Date(),
} = {}) {
  if (!/^[a-z][a-z0-9_.-]+$/.test(String(operation || ""))) throw new Error("audit operation class is invalid");
  if (!/^(?:ok|failed|blocked|not-running|recovered)$/.test(String(result || ""))) throw new Error("audit result is invalid");
  const paths = auditPaths(root, rotations);
  ensureDirectory(paths.directory);
  const row = {
    timestamp: new Date(now).toISOString(),
    operation: String(operation),
    workspaceSession: sanitizeSession(sessionId),
    result: String(result),
    detail: sanitizeDetail(detail),
  };
  const line = `${JSON.stringify(row)}\n`;
  rotateForAppend(paths, Buffer.byteLength(line), maxBytes, rotations);
  fs.appendFileSync(paths.current, line, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(paths.current, 0o600);
  return row;
}

export function auditSize(root, rotations = AUDIT_ROTATIONS) {
  const paths = auditPaths(root, rotations);
  const files = [paths.current, ...Array.from({ length: rotations }, (_, index) => path.join(paths.directory, `events.${index + 1}.jsonl`))];
  return files.reduce((total, file) => {
    try { return total + fs.statSync(file).size; } catch { return total; }
  }, 0);
}

export function clearAudit(root, rotations = AUDIT_ROTATIONS) {
  const paths = auditPaths(root, rotations);
  for (const file of [paths.current, ...paths.rotated]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function rotateForAppend(paths, incomingBytes, maxBytes, rotations) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024) throw new Error("audit maxBytes is invalid");
  if (!Number.isInteger(rotations) || rotations < 1 || rotations > 16) throw new Error("audit rotations are invalid");
  let currentSize = 0;
  try { currentSize = fs.statSync(paths.current).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (currentSize + incomingBytes <= maxBytes) return;
  for (let index = rotations; index >= 1; index -= 1) {
    const source = index === 1 ? paths.current : path.join(paths.directory, `events.${index - 1}.jsonl`);
    const target = path.join(paths.directory, `events.${index}.jsonl`);
    if (!fs.existsSync(source)) continue;
    if (index === rotations && fs.existsSync(target)) fs.unlinkSync(target);
    fs.renameSync(source, target);
    fs.chmodSync(target, 0o600);
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("audit directory must be a real directory");
  fs.chmodSync(directory, 0o700);
}

function sanitizeSession(value) {
  if (value == null) return null;
  return /^(?:s5|s6)-[a-z0-9]+-[0-9a-f]{16}$/.test(String(value)) ? String(value) : "[REDACTED]";
}

function sanitizeDetail(value, key = "") {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/(?:path|source|workspace|cwd|command|args|token|secret|key|password|credential|profile|url|header)/i.test(key)) return "[REDACTED]";
    const redacted = value
      .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/(?:CONTROL_PLANE_API_KEY|OPENAI_API_KEY|S3_RELAY_TOKEN|S5_RELAY_AUTH_HEADER)=\S+/g, "$1=<redacted>")
      .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>")
      .replace(/(?:^|[\s=(])\/(?:Users|Volumes|private\/tmp|tmp|var\/folders|volume1\/docker)(?:[^\s)]+)?/g, "$1<redacted-path>")
      .replace(new RegExp(escapeRegExp(os.homedir()) + "[^\\s)]*", "g"), "<redacted-path>");
    return redacted.length > 160 ? `${redacted.slice(0, 160)}…` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitizeDetail(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 32).map(([childKey, childValue]) => [childKey, sanitizeDetail(childValue, childKey)]));
  }
  return "[REDACTED]";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
