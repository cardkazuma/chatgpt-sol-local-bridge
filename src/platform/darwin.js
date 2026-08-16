import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { interceptor, interceptorAvailable } from "../lib/interceptor.js";
import { runCommand } from "../lib/exec.js";
import { splitArgs } from "../lib/text.js";
import { available, capturePath, runExternal, startCapture, stopCapture, unavailable } from "./common.js";

export const name = "macOS";

export function capabilities() {
  return {
    interceptor: interceptorAvailable(),
    accessibility: interceptorAvailable(),
    inputEvent: interceptorAvailable(),
    vision: interceptorAvailable() || available("screencapture"),
    window: interceptorAvailable(),
    clipboard: interceptorAvailable() || (available("pbcopy") && available("pbpaste")),
    notification: interceptorAvailable() || available("osascript"),
    fileDialog: available("osascript"),
    screenRecord: available("ffmpeg"),
    audio: available("ffmpeg") && available("afplay"),
    scheduler: available("launchctl"),
  };
}

export async function accessibility(action) {
  if (!interceptorAvailable()) return unavailable("accessibility", "Install interceptor and grant Accessibility permission.");
  return interceptor(["macos", ...splitArgs(action)]);
}

export async function inputEvent(action) {
  if (!interceptorAvailable()) return unavailable("input_event", "Install interceptor and grant Accessibility permission.");
  return interceptor(["macos", ...splitArgs(action)]);
}

export async function vision({ app, mode = "screenshot" } = {}) {
  if (interceptorAvailable()) {
    const args = ["macos", ...(mode === "ocr" || mode === "text" ? ["vision", "text"] : ["screenshot", "--save"] )];
    if (app) args.push("--app", app);
    const result = await interceptor(args, { timeoutMs: 30_000 });
    const artifactPath = mode === "screenshot" ? findImagePath(result.stdout) : null;
    return artifactPath ? { ...result, artifactPath } : result;
  }
  const output = capturePath("screen", "png");
  const result = await runExternal("screencapture", ["-x", output], { feature: "screenshot", timeoutMs: 30_000 });
  if (!result.ok || mode === "screenshot") return result.ok ? { ...result, stdout: output, artifactPath: output } : result;
  if (!available("tesseract")) return unavailable("vision OCR", `Screenshot saved to ${output}; install tesseract or interceptor for OCR.`);
  return runExternal("tesseract", [output, "stdout"], { feature: "vision OCR", timeoutMs: 60_000 });
}

export async function window(action) {
  if (!interceptorAvailable()) return unavailable("window", "Install interceptor and grant Accessibility permission.");
  return interceptor(["macos", ...splitArgs(action)]);
}

export async function clipboard({ mode, text }) {
  if (interceptorAvailable()) {
    return interceptor(["macos", "clipboard", mode, ...(mode === "write" ? [text] : [])]);
  }
  if (mode === "read") return runExternal("pbpaste", [], { feature: "clipboard" });
  return runCommand(["pbcopy"], { shell: false, stdin: text, timeoutMs: 10_000 });
}

export async function notification({ title, body = "" }) {
  if (interceptorAvailable()) {
    return interceptor(["macos", "notifications", "post", "--title", title, "--body", body]);
  }
  const script = `display notification ${apple(body)} with title ${apple(title)}`;
  return runExternal("osascript", ["-e", script], { feature: "notification" });
}

export async function fileDialog({ mode = "open", prompt = "Choose a file" } = {}) {
  const script = mode === "save"
    ? `POSIX path of (choose file name with prompt ${apple(prompt)})`
    : `POSIX path of (choose file with prompt ${apple(prompt)})`;
  return runExternal("osascript", ["-e", script], { feature: "file dialog", timeoutMs: 120_000 });
}

export async function screenRecord({ action, seconds = 8 }) {
  if (action === "stop") return stopCapture("screen-record");
  if (!available("ffmpeg")) return unavailable("screen_record", "Install ffmpeg.");
  const output = capturePath("screen", "mp4");
  return startCapture("screen-record", [
    "ffmpeg", "-y", "-f", "avfoundation", "-i", process.env.MACOS_SCREEN_DEVICE || "1:none",
    "-t", String(seconds), "-pix_fmt", "yuv420p", output,
  ], output);
}

export async function audio({ action, path: filePath, seconds = 5 }) {
  if (action === "play") {
    if (!filePath) return { ok: false, code: null, stdout: "", stderr: "path is required for play" };
    return runExternal("afplay", [filePath], { feature: "audio playback", timeoutMs: 60_000 });
  }
  const output = capturePath("mic", "wav");
  const result = await runExternal("ffmpeg", [
    "-y", "-f", "avfoundation", "-i", process.env.MACOS_AUDIO_DEVICE || ":0",
    "-t", String(seconds), output,
  ], { feature: "audio recording", timeoutMs: (seconds + 10) * 1_000, maxStderr: 4_000 });
  return result.ok ? { ...result, stdout: output } : result;
}

export async function scheduler({ action, label, command, intervalSeconds = 3_600 }) {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  if (action === "list") {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".plist")) : [];
    return { ok: true, code: 0, stdout: JSON.stringify({ backend: "launchd", files }, null, 2), stderr: "" };
  }
  if (!validLabel(label) || !command) return { ok: false, code: null, stdout: "", stderr: "label and command are required; label must use letters, digits, dots, underscores, or hyphens" };
  fs.mkdirSync(dir, { recursive: true });
  const plistPath = path.join(dir, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>${escapeXml(command)}</string></array>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key><false/>
</dict></plist>
`;
  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  spawnSync("launchctl", ["unload", plistPath], { encoding: "utf8" });
  const loaded = spawnSync("launchctl", ["load", plistPath], { encoding: "utf8" });
  if (loaded.status !== 0) return { ok: false, code: loaded.status, stdout: loaded.stdout || "", stderr: loaded.stderr || "launchctl load failed" };
  return { ok: true, code: 0, stdout: `created ${plistPath}`, stderr: "" };
}

export async function systemInfo() {
  return runCommand("sw_vers; sysctl -n machdep.cpu.brand_string hw.memsize; system_profiler SPHardwareDataType -detailLevel mini", { timeoutMs: 30_000 });
}

export async function healthInfo() {
  return runCommand("sysctl -n hw.ncpu; vm_stat; df -h /; uptime", { timeoutMs: 30_000 });
}

function findImagePath(output) {
  for (const match of String(output || "").match(/\/[^\n"']+\.png/gi) || []) {
    const candidate = match.trim();
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function apple(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function validLabel(label) {
  return typeof label === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(label);
}
