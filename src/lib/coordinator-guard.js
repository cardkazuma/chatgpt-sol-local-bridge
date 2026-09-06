import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isWithin, currentWorkspace } from "./paths.js";
import { s6BrokerConfigured, s6BrokerCoordinateMutation, s6BrokerObserveResource } from "./s6-broker-client.js";
import { BRIDGE_PROFILE } from "./config.js";
import { activeHostWorkspace } from "./host-workspaces.js";

const COVERED_ROUTES = new Set(["write_file", "edit_file", "apply_patch"]);
const hostObservations = new Map();

/**
 * Narrow S7-B structured-mutation seam. S1/S5 deliberately do not claim
 * coordinator coverage; an S6 invocation must have a registered broker and a
 * granting coordinator result before filesystem mutation.
 */
export async function coordinatorBeforeMutation({ operation, targetPath, observedContentSha256 = undefined } = {}) {
  if (!COVERED_ROUTES.has(operation)) throw new Error("coordinator route is not covered by this adapter");
  if (BRIDGE_PROFILE === "host") return hostBeforeMutation({ operation, targetPath, observedContentSha256 });
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
  if (BRIDGE_PROFILE === "host") {
    const workspace = activeHostWorkspace();
    if (!workspace) throw new Error("host observation requires explicit workspace context");
    const { canonicalTarget } = coordinatorTarget(targetPath);
    hostObservations.set(hostObservationKey(workspace.id, canonicalTarget), { contentSha256, head: hostHead(workspace.worktreePath) });
    return { allowed: true, checked: true, reasonCode: "HOST_OBSERVATION_RECORDED", result: null };
  }
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
  if (BRIDGE_PROFILE === "host") {
    const expected = result?.freshness?.current;
    if (!expected) throw new Error("host freshness evidence is missing at the write boundary");
    const actual = hostSnapshot(targetPath);
    if (actual.head !== expected.head || actual.contentSha256 !== expected.contentSha256) throw new Error("host freshness changed at write boundary: REFRESH");
    return true;
  }
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

function hostBeforeMutation({ targetPath, observedContentSha256 }) {
  const workspace = activeHostWorkspace();
  if (!workspace) throw new Error("host mutation requires explicit workspace context");
  const { canonicalTarget } = coordinatorTarget(targetPath);
  const current = hostSnapshot(canonicalTarget);
  const saved = hostObservations.get(hostObservationKey(workspace.id, canonicalTarget));
  if (!saved) {
    if (current.contentSha256 !== null || observedContentSha256 !== null) throw new Error("STALE_OBSERVATION: reread the file before mutation (REFRESH)");
  } else if (saved.contentSha256 !== current.contentSha256 || saved.head !== current.head) {
    throw new Error("STALE_OBSERVATION: file content or Git HEAD moved; reread before mutation (REFRESH)");
  }
  if (observedContentSha256 !== undefined && observedContentSha256 !== current.contentSha256) throw new Error("STALE_OBSERVATION: request bytes changed before mutation (REFRESH)");
  return { allowed: true, checked: true, reasonCode: "HOST_FRESH", result: { decision: "ALLOW", freshness: { current } } };
}

function hostSnapshot(targetPath) {
  const workspace = activeHostWorkspace();
  const resolved = path.resolve(targetPath);
  let contentSha256 = null;
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("host freshness target is not a regular file");
    contentSha256 = sha256(fs.readFileSync(resolved));
  }
  return { contentSha256, head: hostHead(workspace.worktreePath) };
}

function hostHead(root) {
  const repository = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  if (repository.status !== 0) return null;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !/^[a-f0-9]{40,64}$/.test(result.stdout.trim())) throw new Error("host Git HEAD observation is unavailable");
  return result.stdout.trim();
}

function hostObservationKey(workspaceId, targetPath) {
  return `${workspaceId}:${path.resolve(targetPath)}`;
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
