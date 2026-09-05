import { fork } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";

export function redactOutput(value) {
  return String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "<private-key-redacted>")
    .replace(/(?:Bearer\s+|\b(?:sk-|gh[pousr]_))[A-Za-z0-9_.-]+/gi, "<credential-redacted>")
    .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://<redacted>@");
}

/** IPC child wrapper owns the process handle. On controller death, disconnect
 * terminates that exact child; no persisted PID is ever used as kill authority. */
export class OwnedProcess {
  constructor(config) { this.config = config; this.id = crypto.randomUUID(); this.state = "created"; this.output = ""; }
  async start() {
    if (this.state !== "created") throw new Error("owned process already started");
    this.wrapper = fork(new URL("../../scripts/s7-owned-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    this.state = "starting";
    this.wrapper.on("message", (value) => {
      if (value.type === "started") { this.pid = value.pid; this.state = "running"; }
      if (value.type === "output") this.output = (this.output + value.text).slice(-64 * 1024);
      if (value.type === "exit" || value.type === "failed") this.state = "stopped";
    });
    this.wrapper.on("exit", () => { this.state = "stopped"; });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.stop(); reject(new Error("owned process startup timeout")); }, 5000);
      this.wrapper.once("message", (value) => { clearTimeout(timer); if (value.type === "started") resolve(); else reject(new Error("owned process startup failed")); });
      this.wrapper.once("error", () => { clearTimeout(timer); reject(new Error("owned process wrapper failed")); });
    });
    this.wrapper.send({ ...this.config, env: this.config.env || process.env });
    await ready;
    return this.status();
  }
  status() { return { id: this.id, state: this.state, pid: this.pid || null }; }
  logs() { return redactOutput(this.output); }
  async stop() {
    if (!this.wrapper || this.state === "stopped") return;
    const exited = once(this.wrapper, "exit");
    if (this.wrapper.connected) this.wrapper.send({ action: "stop" });
    else this.wrapper.kill("SIGTERM");
    await exited;
    this.state = "stopped";
  }
}
