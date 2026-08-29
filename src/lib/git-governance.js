import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./exec.js";

export const REVIEWED_HOOK_SOURCE = "#!/bin/sh\nset -eu\nexec node scripts/pre-commit-policy.mjs\n";
// Filled from the reviewed, committed policy helper.  A changed helper is a
// governance change and must be reviewed before structured commits resume.
export const REVIEWED_POLICY_SHA256 = "e051fa3873aff3299b30590a3d6c54a901cbff31dbeafcd625e9c69cf6a42b2f";

export async function assertReviewedHooks(repoRoot, signal) {
  const hookPath = path.join(repoRoot, ".githooks", "pre-commit");
  const policyPath = path.join(repoRoot, "scripts", "pre-commit-policy.mjs");
  const hookStat = fs.lstatSync(hookPath);
  if (!hookStat.isFile() || hookStat.isSymbolicLink() || (hookStat.mode & 0o111) === 0) {
    throw new Error("reviewed executable .githooks/pre-commit is required");
  }
  if (fs.readFileSync(hookPath, "utf8") !== REVIEWED_HOOK_SOURCE) {
    throw new Error(".githooks/pre-commit does not match the reviewed S1 hook");
  }
  const policyStat = fs.lstatSync(policyPath);
  if (!policyStat.isFile() || policyStat.isSymbolicLink()) throw new Error("reviewed pre-commit policy helper is required");
  const policyHash = crypto.createHash("sha256").update(fs.readFileSync(policyPath)).digest("hex");
  if (policyHash !== REVIEWED_POLICY_SHA256) throw new Error("pre-commit policy helper hash is not the reviewed S1 version");
  const configured = await runCommand(["git", "-c", `safe.directory=${repoRoot}`, "config", "--local", "--get", "core.hooksPath"], { cwd: repoRoot, shell: false, signal });
  if (!configured.ok || configured.stdout.trim() !== ".githooks") throw new Error("core.hooksPath must be exactly .githooks");
}
