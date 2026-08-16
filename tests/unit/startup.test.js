import test from "node:test";
import assert from "node:assert/strict";
import { waitForJsonReady } from "../../src/lib/startup.js";

test("startup readiness retries until the bridge reports ready", async () => {
  let attempts = 0;
  const body = await waitForJsonReady("http://127.0.0.1:8765/readyz", {
    timeoutMs: 100,
    intervalMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection refused");
      return { ok: true, status: 200, json: async () => ({ ready: true, toolCount: 44 }) };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(body.toolCount, 44);
});

test("startup readiness fails clearly after its deadline", async () => {
  await assert.rejects(() => waitForJsonReady("http://127.0.0.1:8765/readyz", {
    timeoutMs: 10,
    intervalMs: 1,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ ready: false }) }),
  }), /timed out waiting.*HTTP 503/);
});
