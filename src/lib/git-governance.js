import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./exec.js";

export const REVIEWED_HOOK_SOURCE = "#!/bin/sh\nset -eu\nexec node scripts/pre-commit-policy.mjs\n";
export const S6_REVIEWED_HOOK_SOURCE = "#!/bin/sh\nset -eu\nexec node \"${BRIDGE_REVIEWED_POLICY_PATH:?bridge policy path missing}\"\n";
// Filled from the reviewed, committed policy helper.  A changed helper is a
// governance change and must be reviewed before structured commits resume.
export const REVIEWED_POLICY_SHA256 = "d7419e4c1e838d33d6864269b80fcd23fa1b846795ade767a1b692964ba20d8e";

export function reviewedHooksPath() {
  return process.env.BRIDGE_REVIEWED_HOOKS_PATH || ".githooks";
}

export async function assertReviewedHooks(repoRoot, signal, { mode = process.env.BRIDGE_GOVERNANCE_MODE || "s5" } = {}) {
  if (!["s5", "s6"].includes(mode)) throw new Error("unknown reviewed governance mode");
  const s6 = mode === "s6";
  const hookPath = s6
    ? (process.env.BRIDGE_REVIEWED_HOOK_PATH || "/bridge-governance/hooks/pre-commit")
    : path.join(repoRoot, ".githooks", "pre-commit");
  const policyPath = s6
    ? (process.env.BRIDGE_REVIEWED_POLICY_PATH || "/bridge-governance/pre-commit-policy.mjs")
    : path.join(repoRoot, "scripts", "pre-commit-policy.mjs");
  const hookStat = fs.lstatSync(hookPath);
  if (!hookStat.isFile() || hookStat.isSymbolicLink() || (hookStat.mode & 0o111) === 0) {
    throw new Error("reviewed executable pre-commit hook is required");
  }
  const expectedHook = s6 ? S6_REVIEWED_HOOK_SOURCE : REVIEWED_HOOK_SOURCE;
  if (fs.readFileSync(hookPath, "utf8") !== expectedHook) {
    throw new Error(`reviewed ${mode} pre-commit hook does not match the approved hook`);
  }
  const policyStat = fs.lstatSync(policyPath);
  if (!policyStat.isFile() || policyStat.isSymbolicLink()) throw new Error("reviewed pre-commit policy helper is required");
  const policyHash = crypto.createHash("sha256").update(fs.readFileSync(policyPath)).digest("hex");
  if (policyHash !== REVIEWED_POLICY_SHA256) throw new Error("pre-commit policy helper hash is not the reviewed bridge version");
  const configured = await runCommand(["git", "-c", `safe.directory=${repoRoot}`, "config", "--local", "--get", "core.hooksPath"], { cwd: repoRoot, shell: false, signal });
  if (!configured.ok || configured.stdout.trim() !== reviewedHooksPath()) throw new Error(`core.hooksPath must be exactly ${reviewedHooksPath()}`);
}
