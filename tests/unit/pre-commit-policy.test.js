import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertGovernedGitPath, runPreCommitPolicy } from "../../scripts/pre-commit-policy.mjs";

const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("pre-commit allows a modified HEAD-tracked regular file matched by a broad ignore", () => {
  const root = fixture({ "docs/project-resolver.json": "baseline\n" });
  fs.writeFileSync(path.join(root, "docs/project-resolver.json"), "modified\n");
  git(root, ["add", "--", "docs/project-resolver.json"]);

  const output = capture();
  const result = runPreCommitPolicy({ cwd: root, output });

  assert.deepEqual(result.names, ["docs/project-resolver.json"]);
  assert.match(output.value, /pre-commit policy passed \(1 path\)/);
});

test("governance recognizes an unchanged HEAD-tracked regular file as a narrow ignore exemption", () => {
  const root = fixture({ "docs/project-resolver.json": "baseline\n" });

  assert.deepEqual(assertGovernedGitPath({ root, name: "docs/project-resolver.json" }), {
    allowed: true,
    reason: "allowed",
    path: "docs/project-resolver.json",
    ignored: true,
    pretracked: true,
  });
});

test("pre-commit rejects an ignored new regular file force-added to the index", () => {
  const root = fixture();
  write(root, "docs/force-added.json", "new\n");
  git(root, ["add", "-f", "--", "docs/force-added.json"]);

  assert.throws(() => runPreCommitPolicy({ cwd: root, output: capture() }), /repository-ignored path: docs\/force-added\.json/);
});

test("pre-commit rejects an ignored rename destination absent from HEAD", () => {
  const root = fixture({ "docs/z-source.json": "source\n" });
  git(root, ["mv", "-f", "--", "docs/z-source.json", "docs/a-destination.json"]);

  assert.throws(() => runPreCommitPolicy({ cwd: root, output: capture() }), /repository-ignored path: docs\/a-destination\.json/);
});

test("pre-commit rejects a HEAD-tracked ignored sensitive filename", () => {
  const root = fixture({ "docs/.env": "fixture-only\n" });
  fs.writeFileSync(path.join(root, "docs/.env"), "changed-fixture-only\n");
  git(root, ["add", "--", "docs/.env"]);

  assert.throws(() => runPreCommitPolicy({ cwd: root, output: capture() }), /secret-sensitive or runtime filename: docs\/\.env/);
});

test("pre-commit rejects a HEAD-tracked ignored symlink", { skip: process.platform === "win32" }, () => {
  const root = fixture({ "targets/one.txt": "one\n", "targets/two.txt": "two\n" }, { symlink: ["docs/link.txt", "../targets/one.txt"] });
  fs.unlinkSync(path.join(root, "docs/link.txt"));
  fs.symlinkSync("../targets/two.txt", path.join(root, "docs/link.txt"));
  git(root, ["add", "--", "docs/link.txt"]);

  assert.throws(() => runPreCommitPolicy({ cwd: root, output: capture() }), /ordinary regular file|staged symlink/);
});

test("pre-commit leaves normal tracked non-ignored files unchanged", () => {
  const root = fixture({ "README.md": "baseline\n" });
  fs.writeFileSync(path.join(root, "README.md"), "modified\n");
  git(root, ["add", "--", "README.md"]);

  const result = runPreCommitPolicy({ cwd: root, output: capture() });
  assert.deepEqual(result.names, ["README.md"]);
});

function fixture(files = {}, { symlink = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-tracked-ignore-policy-"));
  roots.push(root);
  write(root, ".gitignore", "/*/*\n");
  write(root, "README.md", files["README.md"] || "fixture\n");
  for (const [name, content] of Object.entries(files)) {
    if (name !== "README.md") write(root, name, content);
  }
  if (symlink) {
    const [name, target] = symlink;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.symlinkSync(target, path.join(root, name));
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Policy Fixture"]);
  git(root, ["config", "user.email", "policy-fixture@example.invalid"]);
  git(root, ["config", "core.hooksPath", ".githooks"]);
  git(root, ["add", "--", ".gitignore", "README.md"]);
  const forced = [...Object.keys(files).filter((name) => name !== "README.md"), ...(symlink ? [symlink[0]] : [])];
  if (forced.length) git(root, ["add", "-f", "--", ...forced]);
  git(root, ["commit", "--no-verify", "-qm", "fixture baseline"]);
  return root;
}

function write(root, name, content) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function capture() {
  return {
    value: "",
    write(chunk) { this.value += String(chunk); },
  };
}
