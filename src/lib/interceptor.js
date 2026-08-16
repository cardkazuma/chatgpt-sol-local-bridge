import { INTERCEPTOR_BIN } from "./config.js";
import { commandExists, runCommand } from "./exec.js";

export function interceptorAvailable() {
  return commandExists(INTERCEPTOR_BIN);
}

export async function interceptor(args, options = {}) {
  if (!interceptorAvailable()) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: `interceptor is not installed or not on PATH (INTERCEPTOR_BIN=${INTERCEPTOR_BIN})`,
      args,
    };
  }
  const result = await runCommand([INTERCEPTOR_BIN, ...args], {
    shell: false,
    timeoutMs: options.timeoutMs ?? 45_000,
    maxStdout: options.maxStdout ?? 20_000,
    maxStderr: 8_000,
    cwd: options.cwd,
    signal: options.signal,
  });
  return { ...result, args };
}
