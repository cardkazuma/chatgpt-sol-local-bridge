import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTarget, isPrivateAddress } from "../../src/lib/web-fetch.js";

test("private and metadata network ranges are blocked", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "64:ff9b::7f00:1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("bracketed IPv6 loopback URLs are normalized and rejected", async () => {
  await assert.rejects(() => assertSafeTarget(new URL("http://[::1]/")), /private\/special address/);
});
