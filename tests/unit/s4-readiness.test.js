import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTunnelControlPlaneHealthReport,
  parseTunnelReadinessResponse,
} from "../../scripts/s4-readiness.mjs";

test("S4 tunnel readiness accepts the v0.0.13 plain-text ready contract", () => {
  assert.deepEqual(parseTunnelReadinessResponse(200, "ready\n"), {
    ready: true,
    status: 200,
    body: "ready",
    diagnostic: "HTTP 200: ready",
  });
});

for (const body of [
  "oauth discovery pending",
  "oauth discovery failed: protected resource metadata unavailable",
  "mcp probe failed: initialize returned HTTP 502",
]) {
  test(`S4 tunnel readiness preserves a 503 diagnostic: ${body}`, () => {
    assert.deepEqual(parseTunnelReadinessResponse(503, body), {
      ready: false,
      status: 503,
      body,
      diagnostic: `HTTP 503: ${JSON.stringify(body)}`,
    });
  });
}

test("S4 tunnel readiness rejects an unexpected successful response visibly", () => {
  assert.throws(
    () => parseTunnelReadinessResponse(200, '{"ready":true}'),
    /unexpected tunnel-client \/readyz response: HTTP 200.*ready/,
  );
});

test("S4 tunnel readiness sanitizes credential-shaped diagnostic content", () => {
  const result = parseTunnelReadinessResponse(503, "oauth discovery failed: Bearer sk-example-secret");
  assert.equal(result.body, "oauth discovery failed: Bearer <redacted>");
  assert.equal(result.diagnostic.includes("example-secret"), false);
});

test("S4 control-plane health treats a not-yet-observed poll as retryable", () => {
  const result = parseTunnelControlPlaneHealthReport(2, {
    result: "fail",
    healthz: { ok: true, status: 200, body: "live" },
    readyz: { ok: true, status: 200, body: "ready" },
    control_plane_poll: { ok: false, error: "no successful control-plane poll observed" },
  });
  assert.equal(result.ready, false);
  assert.match(result.diagnostic, /healthz=ok\/200\/live/);
  assert.match(result.diagnostic, /control-plane-poll=fail\/no successful control-plane poll observed/);
});

test("S4 control-plane health accepts the complete successful assertion", () => {
  const result = parseTunnelControlPlaneHealthReport(0, {
    result: "ok",
    healthz: { ok: true, status: 200, body: "live" },
    readyz: { ok: true, status: 200, body: "ready" },
    control_plane_poll: { ok: true, value: 1 },
  });
  assert.equal(result.ready, true);
  assert.match(result.diagnostic, /control-plane-poll=ok\/1/);
});
