import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUDIT_FILE, MAX_CONCURRENT_TOOLS, ensureStateDirs } from "./config.js";
import { nowIso, redact } from "./text.js";

const MAX_AUDIT_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_AUDIT_FILES = 3;
let lastHash;
let activeTools = 0;

export function instrumentServer(server) {
  const original = server.registerTool.bind(server);
  server.registerTool = (name, definition, handler) => original(name, definition, async (args, extra) => {
    const requestId = `req_${crypto.randomBytes(8).toString("hex")}`;
    if (activeTools >= MAX_CONCURRENT_TOOLS) {
      auditEvent("tool.rejected_busy", { requestId, tool: name, activeTools });
      return { content: [{ type: "text", text: `bridge is busy (${activeTools}/${MAX_CONCURRENT_TOOLS} tool calls); retry shortly` }], isError: true };
    }
    activeTools += 1;
    const started = Date.now();
    auditEvent("tool.started", { requestId, tool: name, args: redact(args || {}) });
    try {
      const result = await handler(args, extra);
      auditEvent("tool.completed", {
        requestId,
        tool: name,
        durationMs: Date.now() - started,
        isError: Boolean(result?.isError),
        outputChars: outputLength(result),
      });
      return result;
    } catch (error) {
      auditEvent("tool.failed", {
        requestId,
        tool: name,
        durationMs: Date.now() - started,
        error: redact(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    } finally {
      activeTools -= 1;
    }
  });
  return server;
}

export function auditEvent(event, data = {}) {
  try {
    ensureStateDirs();
    rotateIfNeeded();
    if (lastHash === undefined) lastHash = readLastHash();
    const payload = { at: nowIso(), pid: process.pid, event, ...redact(data), previousHash: lastHash || null };
    const hash = crypto.createHash("sha256").update(`${lastHash || ""}\n${JSON.stringify(payload)}`).digest("hex");
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ ...payload, hash })}\n`, { encoding: "utf8", mode: 0o600 });
    lastHash = hash;
    return true;
  } catch (error) {
    process.stderr.write(`[audit] ${error.message}\n`);
    return false;
  }
}

function outputLength(result) {
  return (result?.content || []).reduce((total, item) => total + (typeof item?.text === "string" ? item.text.length : 0), 0);
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size < MAX_AUDIT_BYTES) return;
    const rotated = path.join(path.dirname(AUDIT_FILE), `bridge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jsonl`);
    fs.renameSync(AUDIT_FILE, rotated);
    const rotatedFiles = fs.readdirSync(path.dirname(AUDIT_FILE))
      .filter((name) => /^bridge-\d+-[0-9a-f]+\.jsonl$/.test(name))
      .map((name) => {
        const file = path.join(path.dirname(AUDIT_FILE), name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of rotatedFiles.slice(MAX_ROTATED_AUDIT_FILES)) fs.unlinkSync(item.file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function readLastHash() {
  try {
    const stat = fs.statSync(AUDIT_FILE);
    const bytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(AUDIT_FILE, "r");
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    fs.closeSync(fd);
    const line = buffer.toString("utf8").trim().split(/\r?\n/).at(-1);
    return line ? JSON.parse(line).hash || "" : "";
  } catch {
    return "";
  }
}
