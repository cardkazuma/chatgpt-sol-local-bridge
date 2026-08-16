import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-audit-test-"));
process.env.BRIDGE_STATE_DIR = base;
const { auditEvent } = await import("../../src/lib/audit.js");
const { AUDIT_FILE } = await import("../../src/lib/config.js");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("audit events redact secrets and form a verifiable hash chain", () => {
  auditEvent("one", { token: "super-secret", value: "ok" });
  auditEvent("two", { authorization: "Bearer secret-value" });
  const rows = fs.readFileSync(AUDIT_FILE, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].token, "[REDACTED]");
  assert.equal(rows[1].authorization, "[REDACTED]");
  assert.equal(rows[1].previousHash, rows[0].hash);
  for (const [index, row] of rows.entries()) {
    const { hash, ...payload } = row;
    const previous = index === 0 ? "" : rows[index - 1].hash;
    const expected = crypto.createHash("sha256").update(`${previous}\n${JSON.stringify(payload)}`).digest("hex");
    assert.equal(hash, expected);
  }
});
