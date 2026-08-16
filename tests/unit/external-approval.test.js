import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sol-external-approval-"));
const verifier = path.join(base, "verifier.sh");
const marker = path.join(os.homedir(), `.sol-approval-marker-${process.pid}`);
fs.writeFileSync(verifier, `#!/bin/sh\n[ "$1" = verify ] && [ -f '${marker}' ]\n`, { mode: 0o755 });
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.DESTRUCTIVE_APPROVAL_MODE = "external";
process.env.APPROVAL_VERIFIER_COMMAND = verifier;
process.env.APPROVAL_VERIFIER_SHA256 = crypto.createHash("sha256").update(fs.readFileSync(verifier)).digest("hex");
const policy = await import("../../src/lib/policy.js");

test.after(() => {
  fs.rmSync(marker, { force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

test("external approval mode requires a separately granted verifier result", { skip: process.platform === "win32" }, () => {
  const item = policy.queueDestructive({ kind: "shell", command: "rm x", cwd: "/tmp" });
  assert.match(policy.takeDestructive(item.token, { userSaidYes: true }).error, /denied approval/);
  fs.writeFileSync(marker, "human-approved", { mode: 0o600 });
  assert.equal(policy.takeDestructive(item.token, { userSaidYes: true }).item.token, item.token);
});
