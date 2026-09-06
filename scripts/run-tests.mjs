#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scope = process.argv[2] || "all";
if (!new Set(["all", "unit", "integration", "ci"]).has(scope)) {
  console.error(`unknown test scope: ${scope}`);
  process.exit(2);
}
const start = ["all", "ci"].includes(scope) ? path.join(repoRoot, "tests") : path.join(repoRoot, "tests", scope);
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(target);
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(target);
  }
}
collect(start);
if (scope === "ci") {
  const prerequisiteFixture = path.join(repoRoot, "tests", "unit", "s7b-review-fixes.test.js");
  const index = files.indexOf(prerequisiteFixture);
  if (index !== -1) files.splice(index, 1);
  console.error("CI prerequisite disposition: the accepted private work-coordinator wheel is unavailable to this repository; s7b-review-fixes.test.js remains mandatory in the documented local full-suite gate.");
}
files.sort();
if (files.length === 0) {
  console.error(`no tests found under ${start}`);
  process.exit(1);
}
// Keep process-heavy Git/runtime integration fixtures from starving bounded timer assertions.
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=4", "--test-reporter=spec", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
