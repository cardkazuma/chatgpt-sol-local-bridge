import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runHC01GateCCollector, HC01_GATE_C_FAILURE } from "../../src/tools/hc01-gate-c-evidence.js";

const SOURCE_KEYS = [
  "canonical_git", "provider_catalog_revision", "provider_identity", "entitlement_observation", "host_binding",
  "runtime_snapshot", "enforcement_attestation", "economics_observation", "live_runtime", "state_store", "checkpoint",
];
const digest = (letter) => `sha256:${letter.repeat(64)}`;

function receipt(overrides = {}) {
  return {
    schema_version: "gate-c-readonly-owner-evidence-receipt/v1",
    adapter: "hc01-gate-c-readonly-owner-evidence/v1",
    status: "CARD_WINDOW_REQUIRED",
    release: { repository: "cardkazuma/ai-project-execution", subject: "a".repeat(40) },
    observed_at: "2026-09-20T00:30:00Z",
    source_keys: SOURCE_KEYS,
    source_owner_proof_digests: Object.fromEntries(SOURCE_KEYS.map((key, index) => [key, digest(["b", "c", "d", "e", "f"][index % 5])])),
    state_status: "ABSENT_EXPECTED",
    readiness: { schema_version: "authority-closure-readiness/v1", scope: "gate_c_hc01", state: "CARD_WINDOW_REQUIRED", next_action: "receive_explicit_card_gate_c_request_window", downstream_state: "MISSING_OWNER", missing_owner_keys: [], dependency_keys: ["card_window"], subject_digests: [], evidence_digests: [] },
    host_binding: { owner_reference: "host-binding-owner:current", reference_id: "host-binding:current", snapshot_digest: digest("a"), attested: true, owner_proof_digest: digest("b"), observed_at: "2026-09-20T00:00:00Z", valid_until: "2026-09-20T01:00:00Z" },
    ...overrides,
  };
}

function fixture() {
  const root = fs.mkdtempSync("/private/tmp/hc01-bridge-");
  const entrypoint = path.join(root, "dist", "controller", "hc01_owner_evidence_cli.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true, mode: 0o700 });
  fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n", { mode: 0o700 });
  const config = path.join(root, "controller.json");
  fs.writeFileSync(config, "{}\n", { mode: 0o600 });
  return { root, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the fixed collector uses only the reviewed executable, arguments, and scrubbed environment", async () => {
  const item = fixture();
  const calls = [];
  try {
    const result = await runHC01GateCCollector({
      collectorRoot: item.root, controllerConfig: item.config, execFileImpl: (executable, args, options, callback) => {
        calls.push({ executable, args, options });
        callback(null, Buffer.from(`${JSON.stringify(receipt())}\n`), Buffer.alloc(0));
      },
    });
    assert.equal(result.status, "CARD_WINDOW_REQUIRED");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, process.execPath);
    assert.deepEqual(calls[0].args, [path.join(item.root, "dist", "controller", "hc01_owner_evidence_cli.js"), "--config", item.config]);
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(calls[0].options.env, { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
  } finally { item.cleanup(); }
});
test("malformed, private, stderr-bearing, and caller-shaped output fail closed without returning child material", async () => {
  const item = fixture();
  try {
    await assert.rejects(() => runHC01GateCCollector({
      collectorRoot: item.root, controllerConfig: item.config, execFileImpl: (_executable, _args, _options, callback) => callback(null, Buffer.from(JSON.stringify({ ...receipt(), private_bytes: "PRIVATE_BINDING_BYTES" })), Buffer.alloc(0)),
    }), new RegExp(HC01_GATE_C_FAILURE));
    await assert.rejects(() => runHC01GateCCollector({
      collectorRoot: item.root, controllerConfig: item.config, execFileImpl: (_executable, _args, _options, callback) => callback(null, Buffer.from(JSON.stringify(receipt())), Buffer.from("private child stderr")),
    }), new RegExp(HC01_GATE_C_FAILURE));
    await assert.rejects(() => runHC01GateCCollector({
      collectorRoot: item.root, controllerConfig: item.config, execFileImpl: (_executable, _args, _options, callback) => callback(null, Buffer.from("not-json"), Buffer.alloc(0)),
    }), new RegExp(HC01_GATE_C_FAILURE));
  } finally { item.cleanup(); }
});

test("ready receipts require every owner proof, agreed physical state, opaque attestation, and a Card window", async () => {
  const item = fixture();
  const ready = receipt({
    status: "FREEZE_READY",
    card_window: { valid_from: "2026-09-20T00:00:00Z", expiry: "2026-09-20T01:00:00Z" },
    q: { schema_version: "authority-closure-freeze-q/v2", request_digest: digest("c"), q_digest: digest("d") },
    closure_freeze_digest: digest("e"),
  });
  const cases = [
    { ...ready, source_owner_proof_digests: { ...ready.source_owner_proof_digests, checkpoint: undefined } },
    { ...ready, state_status: "ABSENT" },
    { ...ready, host_binding: { ...ready.host_binding, attested: false } },
    { ...ready, card_window: undefined },
  ];
  try {
    for (const candidate of cases) {
      await assert.rejects(() => runHC01GateCCollector({
        collectorRoot: item.root, controllerConfig: item.config,   execFileImpl: (_executable, _args, _options, callback) => callback(null, Buffer.from(JSON.stringify(candidate)), Buffer.alloc(0)),
      }), new RegExp(HC01_GATE_C_FAILURE));
    }
  } finally { item.cleanup(); }
});


test("successful and card-window receipts cannot use an unavailable release subject", async () => {
  const item = fixture();
  const candidates = [
    receipt({ release: { repository: "cardkazuma/ai-project-execution", subject: "unavailable" } }),
    receipt({
      status: "FREEZE_READY",
      release: { repository: "cardkazuma/ai-project-execution", subject: "unavailable" },
      card_window: { valid_from: "2026-09-20T00:00:00Z", expiry: "2026-09-20T01:00:00Z" },
      q: { schema_version: "authority-closure-freeze-q/v2", request_digest: digest("c"), q_digest: digest("d") },
      closure_freeze_digest: digest("e"),
    }),
  ];
  try {
    for (const candidate of candidates) {
      await assert.rejects(() => runHC01GateCCollector({
        collectorRoot: item.root, controllerConfig: item.config,
        execFileImpl: (_executable, _args, _options, callback) => callback(null, Buffer.from(JSON.stringify(candidate)), Buffer.alloc(0)),
      }), new RegExp(HC01_GATE_C_FAILURE));
    }
  } finally { item.cleanup(); }
});
