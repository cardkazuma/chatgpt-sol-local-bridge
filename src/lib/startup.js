import { setTimeout as sleep } from "node:timers/promises";

export async function waitForJsonReady(url, {
  timeoutMs = 120_000,
  intervalMs = 250,
  requestTimeoutMs = 2_000,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error("startup wait aborted");
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("readiness request timed out")), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ready === true) return body;
      lastError = `HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}`;
    } catch (error) {
      lastError = error.message;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining), undefined, { signal });
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}
