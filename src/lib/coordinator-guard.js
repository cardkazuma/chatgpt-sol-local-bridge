import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isWithin, currentWorkspace } from "./paths.js";
import { s6BrokerConfigured, s6BrokerCoordinateMutation, s6BrokerObserveResource } from "./s6-broker-client.js";

const COVERED_ROUTES = new Set(["write_file", "edit_file", "apply_patch"]);

/**
 * Narrow S7-B structured-mutation seam. S1/S5 deliberately do not claim
 * coordinator coverage; an S6 invocation must have a registered broker and a
 * granting coordinator result before filesystem mutation.
 */
export async function coordinatorBeforeMutation({ operation, targetPath, observedContentSha256 = undefined } = {}) {
  if (!COVERED_ROUTES.has(operation)) throw new Error("coordinator route is not covered by this adapter");
  if (process.env.BRIDGE_GOVERNANCE_MODE !== "s6") {
    return { allowed: true, checked: false, reasonCode: "S7B_NOT_AN_S6_MUTATION", result: null };
  }
  if (!s6BrokerConfigured()) throw new Error("S7-B coordinator channel is not registered");
  const configuredRoot = path.resolve(process.env.DEFAULT_WORKSPACE || currentWorkspace() || process.cwd());
  const root = fs.existsSync(configuredRoot) ? fs.realpathSync.native(configuredRoot) : configuredRoot;
  const resolved = path.resolve(String(targetPath || ""));
  const canonicalTarget = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
  if (!isWithin(canonicalTarget, root) || canonicalTarget === root) throw new Error("coordinator target is outside the current workspace");
  const relative = path.relative(root, canonicalTarget).split(path.sep).join("/");
  if (!relative || relative === "." || relative.includes("\0") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("coordinator target is not a normalized repository-relative file");
  }
  if (observedContentSha256 !== undefined && observedContentSha256 !== null && !/^[0-9a-f]{64}$/.test(observedContentSha256)) {
    throw new Error("coordinator observed content version is invalid");
  }
  const result = await s6BrokerCoordinateMutation(operation, relative, observedContentSha256);
  if (!result || !["ALLOW", "WARN"].includes(result.decision)) {
    throw new Error(`coordinator denied ${operation}: ${result?.reason_code || "COORDINATOR_PROCESS_UNAVAILABLE"}`);
  }
  return { allowed: true, checked: true, reasonCode: result.reason_code, result };
}

/** Record the exact complete-file bytes returned by read_file as coordinator evidence. */
export async function coordinatorObserveRead({ targetPath, contentSha256 } = {}) {
  if (process.env.BRIDGE_GOVERNANCE_MODE !== "s6") {
    return { allowed: true, checked: false, reasonCode: "S7B_NOT_AN_S6_OBSERVATION", result: null };
  }
  if (!s6BrokerConfigured()) throw new Error("S7-B coordinator channel is not registered");
  const { relative } = coordinatorTarget(targetPath);
  if (contentSha256 !== null && !/^[0-9a-f]{64}$/.test(String(contentSha256 || ""))) {
    throw new Error("coordinator observed content version is invalid");
  }
  const result = await s6BrokerObserveResource(relative, contentSha256);
  if (!result || !["ALLOW", "WARN"].includes(result.decision)) {
    throw new Error(`coordinator observation denied: ${result?.reason_code || "COORDINATOR_PROCESS_UNAVAILABLE"}`);
  }
  return { allowed: true, checked: true, reasonCode: result.reason_code, result };
}

/** Re-check the content version immediately before the supported writer runs. */
export function assertCoordinatorWriteBoundary({ targetPath, result } = {}) {
  if (process.env.BRIDGE_GOVERNANCE_MODE !== "s6") return true;
  const expected = result?.freshness?.current?.worktree_content_version;
  if (!expected || typeof expected !== "object") throw new Error("coordinator freshness evidence is missing at the write boundary");
  const { canonicalTarget } = coordinatorTarget(targetPath);
  let actual = { state: "absent" };
  if (fs.existsSync(canonicalTarget)) {
    const stat = fs.lstatSync(canonicalTarget);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("coordinator target changed to a non-regular file at the write boundary");
    actual = { state: "present", algorithm: "sha256", hex: sha256(fs.readFileSync(canonicalTarget)) };
  }
  if (!sameContentVersion(actual, expected)) throw new Error(`coordinator freshness changed at write boundary: REFRESH (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`);
  return true;
}

function coordinatorTarget(targetPath) {
  const configuredRoot = path.resolve(process.env.DEFAULT_WORKSPACE || currentWorkspace() || process.cwd());
  const root = fs.existsSync(configuredRoot) ? fs.realpathSync.native(configuredRoot) : configuredRoot;
  const resolved = path.resolve(String(targetPath || ""));
  const canonicalTarget = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
  if (!isWithin(canonicalTarget, root) || canonicalTarget === root) throw new Error("coordinator target is outside the current workspace");
  const relative = path.relative(root, canonicalTarget).split(path.sep).join("/");
  if (!relative || relative === "." || relative.includes("\0") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("coordinator target is not a normalized repository-relative file");
  }
  return { root, resolved, canonicalTarget, relative };
}

export function coordinatorRouteCovered(operation) {
  return COVERED_ROUTES.has(operation);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameContentVersion(actual, expected) {
  if (actual?.state !== expected?.state) return false;
  if (actual?.state === "absent") return true;
  return actual?.algorithm === expected?.algorithm && actual?.hex === expected?.hex;
}
