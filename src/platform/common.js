import fs from "node:fs";
import path from "node:path";
import { CAPTURE_DIR, atomicWriteJson, ensureStateDirs } from "../lib/config.js";
import { commandExists, listProcesses, runCommand, startProcess, stopProcess, tailFile } from "../lib/exec.js";

export function available(command) {
  return commandExists(command);
}

export function unavailable(feature, requirements) {
  return {
    ok: false,
    code: null,
    stdout: "",
    stderr: `${feature} is unavailable on ${process.platform}. ${requirements}`,
    unavailable: true,
  };
}

export async function runExternal(command, args = [], options = {}) {
  if (!commandExists(command)) return unavailable(options.feature || command, `Install ${command} or configure the documented backend override.`);
  return runCommand([command, ...args.map(String)], { shell: false, ...options });
}

export function capturePath(prefix, extension) {
  ensureStateDirs();
  return path.join(CAPTURE_DIR, `${prefix}-${Date.now()}.${extension}`);
}

export async function startCapture(name, command, output) {
  ensureStateDirs();
  const flag = path.join(CAPTURE_DIR, `${name}.json`);
  if (fs.existsSync(flag)) {
    try {
      const prior = JSON.parse(fs.readFileSync(flag, "utf8"));
      if (listProcesses().some((item) => item.id === prior.id && item.running)) {
        return { ok: false, code: null, stdout: "", stderr: `${name} is already running as ${prior.id}` };
      }
    } catch {}
  }
  const meta = startProcess(command, { cwd: CAPTURE_DIR, shell: false });
  atomicWriteJson(flag, { id: meta.id, output, startedAt: meta.startedAt });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const running = listProcesses().find((item) => item.id === meta.id)?.running;
  if (!running && !fs.existsSync(output)) {
    try { fs.unlinkSync(flag); } catch {}
    return { ok: false, code: null, stdout: tailFile(meta.stdoutPath), stderr: tailFile(meta.stderrPath) || `${name} failed to start` };
  }
  return { ok: true, code: 0, stdout: JSON.stringify({ id: meta.id, output, startedAt: meta.startedAt, running }), stderr: "", captureId: meta.id, artifactPath: output };
}

export async function stopCapture(name) {
  const flag = path.join(CAPTURE_DIR, `${name}.json`);
  if (!fs.existsSync(flag)) return { ok: true, code: 0, stdout: `${name} is not running`, stderr: "" };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(flag, "utf8")); }
  catch { return { ok: false, code: null, stdout: "", stderr: `invalid ${name} capture metadata` }; }
  const processMeta = listProcesses().find((item) => item.id === meta.id);
  const result = processMeta?.running ? await stopProcess(meta.id) : processMeta || { id: meta.id, running: false };
  try { fs.unlinkSync(flag); } catch {}
  return { ok: true, code: 0, stdout: JSON.stringify({ ...result, output: meta.output }), stderr: "", artifactPath: meta.output };
}

export function powershellEncoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export async function runPowerShell(script, options = {}) {
  const binary = commandExists("pwsh") ? "pwsh" : commandExists("powershell.exe") ? "powershell.exe" : null;
  if (!binary) return unavailable(options.feature || "PowerShell", "Install PowerShell 7 (pwsh) or use Windows PowerShell.");
  return runCommand([binary, "-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncoded(script)], {
    shell: false,
    ...options,
  });
}

export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
