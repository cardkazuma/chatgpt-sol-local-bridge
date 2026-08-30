import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAudit, auditSize, clearAudit } from "../../scripts/s5-audit.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s5-audit-test-"));

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("operator audit is redacted, rotated, and bounded", () => {
  for (let index = 0; index < 80; index += 1) {
    appendAudit(base, {
      operation: "workspace.operation",
      sessionId: "s5-test-0123456789abcdef",
      result: "ok",
      detail: {
        path: `/Users/cardkazuma/private-${index}`,
        reason: `Bearer sk-secret-${index}`,
      },
    }, { maxBytes: 1_024, rotations: 3 });
  }
  const files = fs.readdirSync(base).filter((name) => /^events(?:\.\d+)?\.jsonl$/.test(name)).sort();
  assert.deepEqual(files, ["events.1.jsonl", "events.2.jsonl", "events.3.jsonl", "events.jsonl"]);
  assert.equal(fs.existsSync(path.join(base, "events.4.jsonl")), false);
  assert.equal(auditSize(base, 3) <= 4 * 1_024, true);
  const content = files.map((file) => fs.readFileSync(path.join(base, file), "utf8")).join("");
  assert.equal(content.includes("sk-secret"), false);
  assert.equal(content.includes("/Users/cardkazuma"), false);
  assert.equal(content.includes("s5-test-0123456789abcdef"), true);
  clearAudit(base, 3);
  assert.equal(fs.readdirSync(base).length, 0);
});
