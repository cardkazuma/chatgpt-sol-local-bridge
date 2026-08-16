#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { httpUrl } from "../src/lib/net.js";
import { waitForJsonReady } from "../src/lib/startup.js";

export async function main() {
  const profile = process.env.TUNNEL_PROFILE || "sol-local-bridge";
  const binary = process.argv[2] || process.env.TUNNEL_CLIENT_BIN || "tunnel-client";
  const readyUrl = httpUrl(process.env.HOST || "127.0.0.1", process.env.PORT || "8765", "/readyz");
  const timeoutMs = Number(process.env.TUNNEL_MCP_STARTUP_TIMEOUT_MS || 120_000);
  const startup = new AbortController();
  let child;
  let stopping = false;
  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    startup.abort(new Error(`received ${signal}`));
    child?.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));

  console.error(`waiting for MCP bridge readiness at ${readyUrl}`);
  try {
    await waitForJsonReady(readyUrl, { timeoutMs, signal: startup.signal });
  } catch (error) {
    if (stopping) return;
    throw error;
  }
  if (stopping) return;

  child = spawn(binary, ["run", "--profile", profile], { stdio: "inherit", shell: false, windowsHide: true });
  child.on("error", (error) => {
    console.error(`tunnel-client failed: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal && process.platform !== "win32") process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`tunnel startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
