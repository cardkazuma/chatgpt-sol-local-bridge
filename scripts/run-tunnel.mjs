#!/usr/bin/env node
import { spawn } from "node:child_process";

const profile = process.env.TUNNEL_PROFILE || "sol-local-bridge";
const binary = process.argv[2] || process.env.TUNNEL_CLIENT_BIN || "tunnel-client";
const child = spawn(binary, ["run", "--profile", profile], { stdio: "inherit", shell: false, windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`tunnel-client failed: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
