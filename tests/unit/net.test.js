import test from "node:test";
import assert from "node:assert/strict";
import { hostForUrl, httpUrl, normalizeHost } from "../../src/lib/net.js";

test("formats IPv4, hostnames, and IPv6 literals in URLs", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(normalizeHost("[::1]"), "::1");
  assert.equal(httpUrl("::1", 8765, "/mcp"), "http://[::1]:8765/mcp");
});
