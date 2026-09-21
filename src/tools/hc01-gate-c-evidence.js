import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import {
  BRIDGE_PROFILE,
  HC01_GATE_C_COLLECTOR_ROOT,
  HC01_GATE_C_CONTROLLER_CONFIG,
} from "../lib/config.js";
import { registerEnabledTool } from "../lib/tool-registry.js";
import { fail, json } from "../lib/text.js";

export const HC01_GATE_C_TOOL_NAME = "collect_hc01_gate_c_readonly_evidence";
export const HC01_GATE_C_FAILURE = "HC01_GATE_C_READONLY_EVIDENCE_REFUSED";
const SOURCE_KEYS = Object.freeze([
  "canonical_git", "provider_catalog_revision", "provider_identity", "entitlement_observation", "host_binding",
  "runtime_snapshot", "enforcement_attestation", "economics_observation", "live_runtime", "state_store", "checkpoint",
]);
const SOURCE_PROOF_KEYS = new Set([...SOURCE_KEYS, "initial_profile_registry_seed", "profile_registry_revision"]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SUBJECT = /^[a-f0-9]{40}$/;
const PRIVATE_MATERIAL = /-----BEGIN|bearer\s|authorization|password|credential|private[_ -]?key|private[_ -]?binding|secret|token|api[_ -]?key|\/private\/|\/Users\/|\/home\//i;
const FIXED_COLLECTOR_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });

function refusal() {
  return new Error(HC01_GATE_C_FAILURE);
}
function exactKeys(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw refusal();
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) throw refusal();
  return value;
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) throw refusal();
  return value;
}

function privateDirectory(value) {
  const target = absolutePath(value);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target || (stat.mode & 0o022) !== 0) throw refusal();
  return target;
}

function privateConfig(value) {
  const target = absolutePath(value);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target || (stat.mode & 0o777) !== 0o600) throw refusal();
  return target;
}

function collectorEntrypoint(root) {
  const entrypoint = path.join(privateDirectory(root), "dist", "controller", "hc01_owner_evidence_cli.js");
  const stat = fs.lstatSync(entrypoint);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(entrypoint) !== entrypoint || (stat.mode & 0o022) !== 0) throw refusal();
  return entrypoint;
}

function decodeUtf8(value) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw refusal(); }
}

function noPrivateMaterial(value) {
  if (typeof value === "string") {
    if (PRIVATE_MATERIAL.test(value)) throw refusal();
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(noPrivateMaterial);
    return;
  }
  if (value && typeof value === "object") Object.values(value).forEach(noPrivateMaterial);
}

function digest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw refusal();
  return value;
}

function validateReadiness(value) {
  const readiness = exactKeys(value, ["schema_version", "scope", "state", "next_action", "downstream_state"], ["missing_owner_keys", "dependency_keys", "subject_digests", "evidence_digests"]);
  for (const key of ["schema_version", "scope", "state", "next_action", "downstream_state"]) if (typeof readiness[key] !== "string") throw refusal();
  for (const key of ["missing_owner_keys", "dependency_keys"]) if (readiness[key] !== undefined && (!Array.isArray(readiness[key]) || readiness[key].some((item) => typeof item !== "string"))) throw refusal();
  for (const key of ["subject_digests", "evidence_digests"]) if (readiness[key] !== undefined && (!Array.isArray(readiness[key]) || readiness[key].some((item) => { digest(item); return false; }))) throw refusal();
  return readiness;
}

function validateReceipt(value) {
  const receipt = exactKeys(value, ["schema_version", "adapter", "status", "release"], ["code", "observed_at", "source_keys", "source_owner_proof_digests", "state_status", "readiness", "host_binding", "card_window", "q", "closure_freeze_digest"]);
  if (receipt.schema_version !== "gate-c-readonly-owner-evidence-receipt/v1" || receipt.adapter !== "hc01-gate-c-readonly-owner-evidence/v1") throw refusal();
  if (!["REFUSED", "CARD_WINDOW_REQUIRED", "FREEZE_READY"].includes(receipt.status)) throw refusal();
  const release = exactKeys(receipt.release, ["repository", "subject"]);
  if (release.repository !== "cardkazuma/ai-project-execution" || typeof release.subject !== "string"
    || (release.subject !== "unavailable" && !SUBJECT.test(release.subject))) throw refusal();
  if (receipt.status === "REFUSED") {
    if (receipt.code !== HC01_GATE_C_FAILURE) throw refusal();
    if (receipt.observed_at !== undefined || receipt.source_keys !== undefined || receipt.source_owner_proof_digests !== undefined || receipt.host_binding !== undefined || receipt.q !== undefined || receipt.closure_freeze_digest !== undefined) throw refusal();
    if (receipt.state_status !== undefined && typeof receipt.state_status !== "string") throw refusal();
    if (receipt.readiness !== undefined) validateReadiness(receipt.readiness);
    noPrivateMaterial(receipt);
    return receipt;
  }
  if (!SUBJECT.test(release.subject) || typeof receipt.observed_at !== "string" || !Array.isArray(receipt.source_keys) || receipt.source_keys.length !== SOURCE_KEYS.length || receipt.source_keys.some((key, index) => key !== SOURCE_KEYS[index])) throw refusal();
  if (!(["ABSENT_EXPECTED", "PRESENT_RECONCILED"].includes(receipt.state_status))) throw refusal();
  const proofMap = exactKeys(receipt.source_owner_proof_digests, SOURCE_KEYS, ["initial_profile_registry_seed", "profile_registry_revision"]);
  for (const [key, value] of Object.entries(proofMap)) { if (!SOURCE_PROOF_KEYS.has(key)) throw refusal(); digest(value); }
  validateReadiness(receipt.readiness);
  const host = exactKeys(receipt.host_binding, ["owner_reference", "reference_id", "snapshot_digest", "attested", "owner_proof_digest", "observed_at", "valid_until"]);
  if (typeof host.owner_reference !== "string" || typeof host.reference_id !== "string" || host.attested !== true || typeof host.observed_at !== "string" || typeof host.valid_until !== "string") throw refusal();
  digest(host.snapshot_digest); digest(host.owner_proof_digest);
  if (receipt.card_window !== undefined) {
    const window = exactKeys(receipt.card_window, ["valid_from", "expiry"]);
    if (typeof window.valid_from !== "string" || typeof window.expiry !== "string") throw refusal();
  }
  if (receipt.status === "CARD_WINDOW_REQUIRED" && receipt.q !== undefined) throw refusal();
  if (receipt.status === "FREEZE_READY") {
    if (receipt.card_window === undefined) throw refusal();
    const q = exactKeys(receipt.q, ["schema_version", "request_digest", "q_digest"]);
    if (q.schema_version !== "authority-closure-freeze-q/v2") throw refusal();
    digest(q.request_digest); digest(q.q_digest); digest(receipt.closure_freeze_digest);
  }
  noPrivateMaterial(receipt);
  return receipt;
}

function emptyInput(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
}

export function runHC01GateCCollector({
  collectorRoot = HC01_GATE_C_COLLECTOR_ROOT,
  controllerConfig = HC01_GATE_C_CONTROLLER_CONFIG,
  execFileImpl = execFile,
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      const root = collectorEntrypoint(collectorRoot);
      const config = privateConfig(controllerConfig);
      const args = Object.freeze([root, "--config", config]);
      execFileImpl(process.execPath, args, {
        cwd: path.dirname(path.dirname(path.dirname(root))),
        env: FIXED_COLLECTOR_ENV,
        shell: false,
        timeout: 120_000,
        maxBuffer: 1_000_000,
        encoding: "buffer",
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error || stderr?.length) return reject(refusal());
        try {
          const text = decodeUtf8(stdout);
          if (Buffer.byteLength(text, "utf8") > 1_000_000) throw refusal();
          const receipt = JSON.parse(text);
          return resolve(validateReceipt(receipt));
        } catch { return reject(refusal()); }
      });
    } catch { reject(refusal()); }
  });
}

export function collectHC01GateCReadOnlyEvidence() {
  return runHC01GateCCollector();
}

export function registerHC01GateCEvidence(server) {
  return registerEnabledTool(server, HC01_GATE_C_TOOL_NAME, {
    title: "Collect HC01 Gate-C read-only evidence",
    description: "Collect the reviewed HC01 Gate-C owner-evidence receipt from the fixed local collector. This tool accepts no workspace or authority inputs.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (args = {}) => {
    if (BRIDGE_PROFILE !== "host" || !emptyInput(args)) return fail(HC01_GATE_C_FAILURE);
    try {
      const receipt = await collectHC01GateCReadOnlyEvidence();
      if (receipt.status === "REFUSED") return fail(HC01_GATE_C_FAILURE);
      return json(receipt);
    } catch { return fail(HC01_GATE_C_FAILURE); }
  });
}
