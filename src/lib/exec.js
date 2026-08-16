import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  COMMAND_TIMEOUT_MS,
  LOG_DIR,
  MAX_PROCESS_LOG_BYTES,
  MAX_PROCESS_RECORDS,
  MAX_STDERR_CHARS,
  MAX_STDOUT_CHARS,
  PROCESS_RETENTION_DAYS,
  PROC_DIR,
  TOOL_ENV_ALLOWLIST,
  TOOL_ENV_INHERIT_SECRETS,
  atomicWriteJson,
  ensureStateDirs,
} from "./config.js";
import { currentWorkspace } from "./paths.js";
import { clip, nowIso } from "./text.js";

export function runCommand(command, options = {}) {
  const cwd = options.cwd || currentWorkspace() || process.cwd();
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const shell = options.shell ?? typeof command === "string";
  const env = toolEnvironment(options.env);
  const argv = normalizeCommand(command);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(argv.file, argv.args, {
      cwd,
      env,
      shell,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const identity = getProcessIdentity(child.pid);
    const stdout = boundedCollector(options.maxStdout ?? MAX_STDOUT_CHARS);
    const stderr = boundedCollector(options.maxStderr ?? MAX_STDERR_CHARS);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        ok: result.code === 0 && !timedOut && !cancelled,
        code: result.code ?? null,
        signal: result.signal ?? null,
        timedOut,
        cancelled,
        stdout: stdout.value(),
        stderr: stderr.value(),
        cwd,
        command: displayCommand(command),
      });
    };

    const abort = async () => {
      cancelled = true;
      await terminateProcessTree(child.pid, { forceAfterMs: 500, expectedIdentity: identity });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child.pid, { forceAfterMs: 2_000, expectedIdentity: identity });
    }, timeoutMs);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(`\n${error.message}`);
      finish({ code: null, signal: null });
    });
    child.on("close", (code, signal) => finish({ code, signal }));

    if (options.stdin != null) {
      child.stdin.end(options.stdin);
    }
  });
}

export function startProcess(command, options = {}) {
  ensureStateDirs();
  const id = `p_${Date.now().toString(36)}_${cryptoRandom(6)}`;
  const cwd = options.cwd || currentWorkspace() || process.cwd();
  const stdoutPath = path.join(LOG_DIR, `${id}.out.log`);
  const stderrPath = path.join(LOG_DIR, `${id}.err.log`);
  const metaPath = path.join(PROC_DIR, `${id}.json`);
  const outFd = fs.openSync(stdoutPath, "a", 0o600);
  const errFd = fs.openSync(stderrPath, "a", 0o600);
  const argv = normalizeCommand(command);
  let child;
  try {
    child = spawn(argv.file, argv.args, {
      cwd,
      env: toolEnvironment(options.env),
      shell: options.shell ?? typeof command === "string",
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
    });
    if (!child.pid) throw new Error("process did not return a pid");
    child.unref();
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const meta = {
    id,
    pid: child.pid,
    command: displayCommand(command),
    cwd,
    startedAt: nowIso(),
    platform: process.platform,
    identity: getProcessIdentity(child.pid),
    stdoutPath,
    stderrPath,
  };
  atomicWriteJson(metaPath, meta);
  return meta;
}

export function listProcesses() {
  ensureStateDirs();
  const records = fs.readdirSync(PROC_DIR)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const metaPath = path.join(PROC_DIR, name);
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (!/^p_[A-Za-z0-9_]+$/.test(meta.id) || !Number.isInteger(meta.pid)) return [];
        const expectedOut = path.join(LOG_DIR, `${meta.id}.out.log`);
        const expectedErr = path.join(LOG_DIR, `${meta.id}.err.log`);
        if (path.resolve(meta.stdoutPath) !== expectedOut || path.resolve(meta.stderrPath) !== expectedErr) return [];
        capLogFile(expectedOut);
        capLogFile(expectedErr);
        return [{ ...meta, running: isSameProcess(meta), _metaPath: metaPath }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const cutoff = Date.now() - PROCESS_RETENTION_DAYS * 86_400_000;
  const kept = [];
  for (const [index, record] of records.entries()) {
    const expired = Date.parse(record.startedAt) < cutoff || index >= MAX_PROCESS_RECORDS;
    if (expired && !record.running) {
      for (const target of [record._metaPath, record.stdoutPath, record.stderrPath]) {
        try { fs.unlinkSync(target); } catch {}
      }
    } else {
      const publicRecord = { ...record };
      delete publicRecord._metaPath;
      kept.push(publicRecord);
    }
  }
  return kept;
}

export function isPidRunning(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopProcess(id) {
  const match = listProcesses().find((item) => item.id === id);
  if (!match) throw new Error(`unknown bridge-managed process ${id}`);
  if (isPidRunning(match.pid) && !isSameProcess(match)) {
    throw new Error(`PID ${match.pid} was reused; refusing to stop an unrelated process`);
  }
  if (isSameProcess(match)) await terminateProcessTree(match.pid, { expectedIdentity: match.identity });
  return { ...match, running: isSameProcess(match), signal: "TERM" };
}

export async function terminateProcessTree(pid, { forceAfterMs = 2_000, expectedIdentity = "" } = {}) {
  if (!pid || !isPidRunning(pid)) return;
  if (expectedIdentity && getProcessIdentity(pid) !== expectedIdentity) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T"], { windowsHide: true, encoding: "utf8" });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
  await delay(Math.min(forceAfterMs, 2_000));
  if (!isPidRunning(pid)) return;
  if (expectedIdentity && getProcessIdentity(pid) !== expectedIdentity) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

export function isSameProcess(meta) {
  if (!meta?.identity || !isPidRunning(meta.pid)) return false;
  return getProcessIdentity(meta.pid) === meta.identity;
}

function capLogFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_PROCESS_LOG_BYTES) return;
    const keepBytes = Math.floor(MAX_PROCESS_LOG_BYTES / 2);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(keepBytes);
    fs.readSync(fd, buffer, 0, keepBytes, stat.size - keepBytes);
    fs.closeSync(fd);
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from("[older bridge log output truncated]\n"), buffer]), { mode: 0o600 });
  } catch {}
}

export function tailFile(filePath, lines = 80, maxBytes = 256_000) {
  if (!fs.existsSync(filePath)) return "";
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const bytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    return buffer.toString("utf8").split(/\r?\n/).slice(-lines).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

export function commandExists(command) {
  const probe = process.platform === "win32"
    ? spawnSync("where.exe", [command], { windowsHide: true, encoding: "utf8" })
    : spawnSync("/bin/sh", ["-lc", `command -v -- ${shellQuote(command)}`], { encoding: "utf8" });
  return probe.status === 0;
}

function getProcessIdentity(pid) {
  try {
    if (process.platform === "win32") {
      const script = `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const binary = commandExists("pwsh") ? "pwsh" : "powershell.exe";
      const result = spawnSync(binary, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : "";
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

export function toolEnvironment(overrides = {}) {
  const env = { ...process.env, ...(overrides || {}) };
  if (TOOL_ENV_INHERIT_SECRETS) return env;
  for (const key of Object.keys(env)) {
    if (TOOL_ENV_ALLOWLIST.has(key)) continue;
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:$|_)/i.test(key)
      || ["MCP_TOKEN", "CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(key)) {
      delete env[key];
    }
  }
  return env;
}

function normalizeCommand(command) {
  if (Array.isArray(command)) {
    if (!command.length) throw new Error("command array is empty");
    return { file: command[0], args: command.slice(1) };
  }
  if (!String(command).trim()) throw new Error("command is empty");
  return { file: String(command), args: [] };
}

function displayCommand(command) {
  return Array.isArray(command) ? command.map(shellQuote).join(" ") : String(command);
}

function boundedCollector(maxChars) {
  let text = "";
  let omitted = 0;
  return {
    push(chunk) {
      text += chunk.toString();
      const hardLimit = maxChars * 2;
      if (text.length > hardLimit) {
        omitted += text.length - maxChars;
        text = text.slice(-maxChars);
      }
    },
    value() {
      const result = clip(text, maxChars, { tail: omitted > 0 });
      return omitted > 0 ? `${result}\n… ${omitted} earlier chars discarded while streaming` : result;
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function cryptoRandom(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
