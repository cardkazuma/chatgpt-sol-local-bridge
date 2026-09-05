import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecoveryBudget } from "../../src/s7/recovery.js";

test("five failed restart attempts exhaust budget across controller restart; time alone never clears degraded", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7c-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let recovery = new RecoveryBudget(root);
  for (const now of [0, 5000, 15000, 35000, 75000]) assert.equal(recovery.attempt(now).allowed, true);
  recovery = new RecoveryBudget(root);
  assert.equal(recovery.attempt(100_000).allowed, false);
  assert.equal(recovery.attempt(24 * 3600_000).allowed, false);
  recovery.event("network", "new-fingerprint", 24 * 3600_000);
  assert.equal(recovery.attempt(24 * 3600_000).allowed, true);
  recovery.event("network", "new-fingerprint", 24 * 3600_000);
  assert.equal(recovery.status().attempts.length, 1);
});

test("recovery backoff refuses eager retry and reports missing components truthfully", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7c-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recovery = new RecoveryBudget(root);
  assert.equal(recovery.attempt(0).allowed, true);
  assert.equal(recovery.attempt(1).allowed, false);
  assert.equal(recovery.attempt(5000).allowed, true);
  recovery.degraded("coordinator");
  assert.equal(recovery.status().component, "coordinator");
  assert.equal(recovery.attempt(600_000).allowed, false);
  recovery.event("explicit", "request-1", 600_000);
  assert.equal(recovery.attempt(600_000).allowed, true);
});
