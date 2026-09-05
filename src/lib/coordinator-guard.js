import fs from "node:fs";
import path from "node:path";
import { isWithin, currentWorkspace } from "./paths.js";
import { s6BrokerConfigured, s6BrokerCoordinateMutation } from "./s6-broker-client.js";

const COVERED_ROUTES = new Set(["write_file", "edit_file", "apply_patch"]);

/**
 * Narrow S7-B structured-mutation seam. S1/S5 deliberately do not claim
 * coordinator coverage; an S6 invocation must have a registered broker and a
 * granting coordinator result before filesystem mutation.
 */
export async function coordinatorBeforeMutation({ operation, targetPath } = {}) {
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
  const result = await s6BrokerCoordinateMutation(operation, relative);
  if (!result || !["ALLOW", "WARN"].includes(result.decision)) {
    throw new Error(`coordinator denied ${operation}: ${result?.reason_code || "COORDINATOR_PROCESS_UNAVAILABLE"}`);
  }
  return { allowed: true, checked: true, reasonCode: result.reason_code, result };
}

export function coordinatorRouteCovered(operation) {
  return COVERED_ROUTES.has(operation);
}
