import fs from "node:fs";
import path from "node:path";
import { atomicJson, privateDirectory } from "./registry.js";

export class RecoveryBudget {
  constructor(root) {
    this.file = path.join(privateDirectory(root), "recovery.json");
    if (fs.existsSync(this.file)) {
      const st = fs.lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error("unsafe recovery state");
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (this.state.version !== 1 || !Array.isArray(this.state.attempts)) throw new Error("corrupt recovery state");
    } else this.state = { version: 1, phase: "STARTING", attempts: [], nextAttempt: 0, events: {}, component: null };
  }
  save() { atomicJson(this.file, this.state); }
  status() { return structuredClone(this.state); }
  attempt(now = Date.now()) {
    if (this.state.phase === "DEGRADED") return { allowed: false, reason: "explicit recovery or new system/network event required" };
    this.state.attempts = this.state.attempts.filter((at) => now - at < 600_000);
    if (this.state.attempts.length >= 5) { this.degraded("restart_budget"); return { allowed: false, reason: "restart budget exhausted" }; }
    if (now < this.state.nextAttempt) return { allowed: false, reason: "backoff", nextAttempt: this.state.nextAttempt };
    this.state.attempts.push(now);
    this.state.nextAttempt = now + Math.min(80_000, 5000 * 2 ** (this.state.attempts.length - 1));
    this.state.phase = "RECOVERING";
    this.save();
    return { allowed: true };
  }
  ready() { this.state.phase = "READY"; this.state.component = null; this.save(); }
  degraded(component) { this.state.phase = "DEGRADED"; this.state.component = component; this.save(); }
  event(kind, identity, now = Date.now()) {
    if (!["network", "wake", "boot", "explicit"].includes(kind) || typeof identity !== "string" || !identity) throw new Error("invalid recovery event");
    if (this.state.events[kind] === identity) return false;
    this.state.events[kind] = identity;
    this.state.phase = "RECOVERING"; this.state.attempts = []; this.state.nextAttempt = now; this.state.component = null;
    this.save(); return true;
  }
}
