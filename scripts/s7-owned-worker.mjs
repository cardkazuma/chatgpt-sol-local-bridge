import { spawn } from "node:child_process";
let child;
let stopping = false;
const send = (value) => { if (process.connected) process.send(value); };
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child || child.exitCode !== null || child.signalCode !== null) { process.exit(0); return; }
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (config) => {
  if (config?.action === "stop") { stop(); return; }
  if (child || stopping) return;
  child = spawn(config.executable, config.args, { cwd: config.cwd, env: config.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  child.once("spawn", () => send({ type: "started", pid: child.pid }));
  child.once("error", () => { send({ type: "failed" }); process.exit(1); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => send({ type: "output", text: data.toString("utf8") }));
  child.once("exit", (code, signal) => { send({ type: "exit", code, signal }); process.exit(code || 0); });
});
