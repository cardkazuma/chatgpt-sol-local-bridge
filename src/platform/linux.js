import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../lib/exec.js";
import { splitArgs } from "../lib/text.js";
import { available, capturePath, runExternal, startCapture, stopCapture, unavailable } from "./common.js";

export const name = "Linux";

export function capabilities() {
  return {
    accessibility: available("xdotool"),
    inputEvent: available("xdotool"),
    vision: available("grim") || available("gnome-screenshot") || available("scrot") || available("import"),
    ocr: available("tesseract"),
    window: available("wmctrl") || available("xdotool"),
    clipboard: available("wl-copy") || available("xclip"),
    notification: available("notify-send"),
    fileDialog: available("zenity") || available("kdialog"),
    screenRecord: available("ffmpeg"),
    audio: available("ffmpeg") && (available("ffplay") || available("paplay") || available("aplay")),
    scheduler: available("systemctl"),
  };
}

export async function accessibility(action) {
  if (!available("xdotool")) return unavailable("accessibility", "Install xdotool (X11) or configure a desktop adapter for your compositor.");
  return runExternal("xdotool", splitArgs(action), { feature: "accessibility", timeoutMs: 30_000 });
}

export async function inputEvent(action) {
  if (!available("xdotool")) return unavailable("input_event", "Install xdotool; Wayland compositors may require ydotool and explicit permissions.");
  return runExternal("xdotool", splitArgs(action), { feature: "input_event", timeoutMs: 30_000 });
}

export async function vision({ mode = "screenshot" } = {}) {
  const output = capturePath("screen", "png");
  let shot;
  if (available("grim")) shot = await runExternal("grim", [output], { feature: "vision" });
  else if (available("gnome-screenshot")) shot = await runExternal("gnome-screenshot", ["-f", output], { feature: "vision" });
  else if (available("scrot")) shot = await runExternal("scrot", [output], { feature: "vision" });
  else if (available("import")) shot = await runExternal("import", ["-window", "root", output], { feature: "vision" });
  else return unavailable("vision", "Install grim (Wayland), gnome-screenshot/scrot (X11), or ImageMagick import.");
  if (!shot.ok || mode === "screenshot") return shot.ok ? { ...shot, stdout: output, artifactPath: output } : shot;
  if (!available("tesseract")) return unavailable("vision OCR", `Screenshot saved to ${output}; install tesseract for OCR.`);
  return runExternal("tesseract", [output, "stdout"], { feature: "vision OCR", timeoutMs: 60_000 });
}

export async function window(action) {
  if (available("wmctrl")) return runExternal("wmctrl", splitArgs(action), { feature: "window", timeoutMs: 30_000 });
  if (available("xdotool")) return runExternal("xdotool", splitArgs(action), { feature: "window", timeoutMs: 30_000 });
  return unavailable("window", "Install wmctrl or xdotool.");
}

export async function clipboard({ mode, text }) {
  if (available("wl-paste") && available("wl-copy")) {
    return mode === "read"
      ? runExternal("wl-paste", ["--no-newline"], { feature: "clipboard" })
      : runCommand(["wl-copy"], { shell: false, stdin: text, timeoutMs: 10_000 });
  }
  if (available("xclip")) {
    return mode === "read"
      ? runExternal("xclip", ["-selection", "clipboard", "-o"], { feature: "clipboard" })
      : runCommand(["xclip", "-selection", "clipboard"], { shell: false, stdin: text, timeoutMs: 10_000 });
  }
  return unavailable("clipboard", "Install wl-clipboard (Wayland) or xclip (X11).");
}

export async function notification({ title, body = "" }) {
  return runExternal("notify-send", [title, body], { feature: "notification" });
}

export async function fileDialog({ mode = "open", prompt = "Choose a file" } = {}) {
  if (available("zenity")) {
    return runExternal("zenity", ["--file-selection", ...(mode === "save" ? ["--save", "--confirm-overwrite"] : []), "--title", prompt], {
      feature: "file dialog", timeoutMs: 120_000,
    });
  }
  if (available("kdialog")) {
    return runExternal("kdialog", [mode === "save" ? "--getsavefilename" : "--getopenfilename", os.homedir(), "--title", prompt], {
      feature: "file dialog", timeoutMs: 120_000,
    });
  }
  return unavailable("file dialog", "Install zenity or kdialog.");
}

export async function screenRecord({ action, seconds = 8 }) {
  if (action === "stop") return stopCapture("screen-record");
  if (!available("ffmpeg")) return unavailable("screen_record", "Install ffmpeg.");
  const output = capturePath("screen", "mp4");
  const display = process.env.DISPLAY || ":0.0";
  const size = process.env.SCREEN_SIZE || "1920x1080";
  return startCapture("screen-record", [
    "ffmpeg", "-y", "-f", "x11grab", "-video_size", size, "-i", display,
    "-t", String(seconds), "-pix_fmt", "yuv420p", output,
  ], output);
}

export async function audio({ action, path: filePath, seconds = 5 }) {
  if (action === "play") {
    if (!filePath) return { ok: false, code: null, stdout: "", stderr: "path is required for play" };
    if (available("ffplay")) return runExternal("ffplay", ["-nodisp", "-autoexit", filePath], { feature: "audio playback", timeoutMs: 60_000 });
    if (available("paplay")) return runExternal("paplay", [filePath], { feature: "audio playback", timeoutMs: 60_000 });
    return runExternal("aplay", [filePath], { feature: "audio playback", timeoutMs: 60_000 });
  }
  const output = capturePath("mic", "wav");
  const result = await runExternal("ffmpeg", [
    "-y", "-f", "pulse", "-i", process.env.LINUX_AUDIO_DEVICE || "default",
    "-t", String(seconds), output,
  ], { feature: "audio recording", timeoutMs: (seconds + 10) * 1_000, maxStderr: 4_000 });
  return result.ok ? { ...result, stdout: output } : result;
}

export async function scheduler({ action, label, command, intervalSeconds = 3_600 }) {
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  if (action === "list") {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".timer")) : [];
    return { ok: true, code: 0, stdout: JSON.stringify({ backend: "systemd-user", files }, null, 2), stderr: "" };
  }
  if (!validLabel(label) || !command) return { ok: false, code: null, stdout: "", stderr: "label and command are required; label must use letters, digits, dots, underscores, or hyphens" };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unit = label.endsWith(".service") ? label.slice(0, -8) : label;
  const payload = Buffer.from(command).toString("base64");
  fs.writeFileSync(path.join(dir, `${unit}.service`), `[Unit]\nDescription=ChatGPT Sol Bridge scheduled task ${unit}\n\n[Service]\nType=oneshot\nExecStart=/bin/sh -lc 'printf %s ${payload} | base64 -d | /bin/sh'\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `${unit}.timer`), `[Unit]\nDescription=Timer for ${unit}\n\n[Timer]\nOnBootSec=${intervalSeconds}s\nOnUnitActiveSec=${intervalSeconds}s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, { mode: 0o600 });
  const reload = await runCommand(["systemctl", "--user", "daemon-reload"], { shell: false });
  if (!reload.ok) return reload;
  return runCommand(["systemctl", "--user", "enable", "--now", `${unit}.timer`], { shell: false });
}

export async function systemInfo() {
  return runCommand("uname -a; (command -v lscpu >/dev/null && lscpu || true); (command -v free >/dev/null && free -h || true); df -h /; uptime", { timeoutMs: 30_000 });
}

export async function healthInfo() {
  return runCommand("getconf _NPROCESSORS_ONLN; (command -v free >/dev/null && free -h || true); df -h /; uptime", { timeoutMs: 30_000 });
}

function validLabel(label) {
  return typeof label === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(label);
}
