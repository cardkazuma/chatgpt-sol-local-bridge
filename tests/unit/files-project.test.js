import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchDeletesFile } from "../../src/tools/files.js";
import { detectCommand } from "../../src/tools/project.js";

test("patch deletion detection distinguishes edits from deletions", () => {
  assert.equal(patchDeletesFile("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n"), false);
  assert.equal(patchDeletesFile("diff --git a/a b/a\ndeleted file mode 100644\n--- a/a\n+++ /dev/null\n"), true);
});

test("project command detection respects package manager and scripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-project-test-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "vite build" } }));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9'\n");
    const testCommand = detectCommand(dir, "test");
    assert.match(testCommand, /(?:pnpm|npm) run test/);
    assert.equal(detectCommand(dir, "lint"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
