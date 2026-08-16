import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "sol-policy-test-"));
process.env.BRIDGE_STATE_DIR = state;
process.env.DESTRUCTIVE_APPROVAL_MODE = "chat";
const policy = await import("../../src/lib/policy.js");

test.after(() => fs.rmSync(state, { recursive: true, force: true }));

test("detects destructive POSIX, Windows, git, SQL, and infrastructure commands", () => {
  for (const command of [
    "rm -rf build", "/bin/rm -rf build", "sh -c \"rm -rf build\"", "python -c \"import os; os.remove('x')\"", "dd if=/dev/zero of=x",
    "del /q file.txt", "Remove-Item foo -Recurse", "git reset --hard HEAD",
    "git clean -fd", "git restore file", "git tag -d old", "git stash clear", "git remote remove origin",
    "DROP TABLE users", "kubectl delete pod x",
  ]) assert.equal(policy.looksDestructive(command), true, command);
  for (const command of ["npm test", "git status", "write a summary", "echo hello"]) {
    assert.equal(policy.looksDestructive(command), false, command);
  }
});

test("structured Git classification catches ref deletion and discard forms", () => {
  for (const argv of [
    ["push", "origin", ":main"], ["push", "--delete", "origin", "main"],
    ["checkout", "HEAD", "--", "file"], ["switch", "--discard-changes", "main"],
  ]) assert.equal(policy.inspectGitDestructive(argv).destructive, true, argv.join(" "));
  assert.equal(policy.inspectGitDestructive(["status", "--short"]).destructive, false);
});

test("approval persistence retains the full exact bounded operation", () => {
  const command = `rm ${"x".repeat(12_000)}`;
  const item = policy.queueDestructive({ kind: "shell", command, cwd: "/tmp" });
  assert.equal(policy.takeDestructive(item.token, { userSaidYes: true }).item.command, command);
});

test("approval tokens are exact, expiring, and single use", () => {
  const item = policy.queueDestructive({ kind: "shell", command: "rm -f x", cwd: "/tmp" });
  assert.match(item.token, /^del_[A-Za-z0-9_-]+$/);
  assert.equal(policy.listPending().some((pending) => pending.token === item.token), true);
  assert.match(policy.denyDeleteMessage(item), /DELETE BLOCKED/);
  assert.match(policy.takeDestructive(item.token, { userSaidYes: false }).error, /must be true/);
  assert.equal(policy.takeDestructive(item.token, { userSaidYes: true }).item.command, "rm -f x");
  assert.match(policy.takeDestructive(item.token, { userSaidYes: true }).error, /unknown, expired, or already-used/);
});
