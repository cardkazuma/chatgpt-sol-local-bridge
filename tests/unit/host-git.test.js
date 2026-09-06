import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.BRIDGE_PROFILE = "host";
const { commitReviewedIndex } = await import("../../src/tools/git.js");

test("host structured commit uses the repository's configured hook and permits governed deletions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-git-hook-"));
  try {
    const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(git(["init", "-q", "-b", "main"]).status, 0);
    git(["config", "user.name", "Host Fixture"]); git(["config", "user.email", "host@example.invalid"]);
    fs.writeFileSync(path.join(root, "remove.txt"), "remove\n");
    git(["add", "remove.txt"]); git(["commit", "-qm", "baseline"]);
    const hooks = path.join(root, "repo-hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nprintf passed > hook-ran\n", { mode: 0o700 });
    git(["config", "core.hooksPath", "repo-hooks"]);
    fs.unlinkSync(path.join(root, "remove.txt"));
    git(["add", "--", "remove.txt"]);
    const result = await commitReviewedIndex({ root, message: "host deletion fixture", governanceMode: "host" });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(fs.readFileSync(path.join(root, "hook-ran"), "utf8"), "passed");
    assert.match(git(["show", "--name-status", "--format="]).stdout, /D\s+remove\.txt/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
