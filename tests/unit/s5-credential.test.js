import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installKeychainItem, withTunnelClientEnvFile, keychainStatus } from "../../scripts/s5-credential.mjs";
import { appendLine } from "../../scripts/s5-runtime.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s5-credential-test-"));
const security = path.join(base, "security");
fs.writeFileSync(security, "#!/bin/sh\nif [ \"$1\" = add-generic-password ]; then [ \"$3\" = -a ] && [ \"$4\" = tunnel-client ] && [ \"$5\" = -s ] && [ \"$6\" = com.cardkazuma.chatgpt-local-bridge.runtime ] || exit 1; exit 0; fi\n[ \"$1\" = find-generic-password ] || exit 1\n[ \"$2\" = -s ] && [ \"$3\" = com.cardkazuma.chatgpt-local-bridge.runtime ] && [ \"$4\" = -a ] && [ \"$5\" = tunnel-client ] || exit 1\nif [ \"$6\" = -w ]; then printf '%s\\n' 'change-me-s5-fixture'; fi\nexit 0\n", { mode: 0o700 });
fs.chmodSync(security, 0o700);

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("credential custody reads one fixed item and exposes it only to the tunnel callback", async () => {
  assert.deepEqual(keychainStatus({ securityBin: security, platform: "darwin" }), {
    available: true,
    reason: "dedicated Keychain item is present",
  });
  const tempRoot = path.join(base, "tmp");
  let observed;
  await withTunnelClientEnvFile({ tempRoot, securityBin: security, platform: "darwin" }, async (envFile) => {
    observed = fs.readFileSync(envFile, "utf8");
    const stat = fs.statSync(envFile);
    assert.equal(stat.mode & 0o077, 0);
    assert.equal(path.dirname(envFile).startsWith(tempRoot), true);
  });
  assert.equal(observed, "CONTROL_PLANE_API_KEY=change-me-s5-fixture\n");
  assert.equal(fs.readdirSync(tempRoot).length, 0);
});

test("credential installation uses the dedicated item identity", () => {
  assert.deepEqual(installKeychainItem({ securityBin: security, platform: "darwin" }), {
    stored: true,
    service: "com.cardkazuma.chatgpt-local-bridge.runtime",
    account: "tunnel-client",
  });
});

test("tunnel env assignment accepts opaque Docker-safe values without shell grammar", () => {
  const envFile = path.join(base, "opaque.env");
  const values = [
    "Alpha123",
    "alpha-beta",
    "alpha_beta",
    "Bearer fixture-token",
    "left=right==tail",
    "opaque!$&*+,./:;<>?@[\\]^`{|}~\"'z",
    " leading and trailing ",
    "x".repeat(4_096),
  ];
  for (const value of values) {
    fs.writeFileSync(envFile, "", { mode: 0o600 });
    appendLine(envFile, "S5_RELAY_AUTH_HEADER", value);
    assert.equal(fs.readFileSync(envFile, "utf8"), `S5_RELAY_AUTH_HEADER=${value}\n`);
  }

  const shellLiteral = "literal$HOME;$(id)&&`uname`|*?[]{}<>";
  fs.writeFileSync(envFile, "", { mode: 0o600 });
  appendLine(envFile, "S5_RELAY_AUTH_HEADER", shellLiteral);
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.S5_RELAY_AUTH_HEADER)"], {
    env: { ...process.env, S5_RELAY_AUTH_HEADER: shellLiteral },
    encoding: "utf8",
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, shellLiteral);
  assert.equal(fs.readFileSync(envFile, "utf8"), `S5_RELAY_AUTH_HEADER=${shellLiteral}\n`);
});

test("tunnel env assignment rejects invalid names and line-injection characters without echoing values", () => {
  const envFile = path.join(base, "invalid.env");
  const invalidNames = ["BAD-NAME", "s5_relay_auth_header", "1S5_RELAY_AUTH_HEADER", "S5_RELAY_AUTH_HEADER=extra"];
  for (const name of invalidNames) {
    assert.throws(
      () => appendLine(envFile, name, "synthetic-value"),
      (error) => error.message === "credential env assignment is invalid",
    );
  }
  const marker = "SYNTHETIC_VALUE_MUST_NOT_LEAK";
  for (const value of ["line\n" + marker, "line\r" + marker, "line" + String.fromCharCode(0) + marker, ""]) {
    assert.throws(
      () => appendLine(envFile, "S5_RELAY_AUTH_HEADER", value),
      (error) => error.message === "credential env assignment is invalid" && !error.message.includes(marker),
    );
  }
});

test("temporary credential material is removed when the tunnel callback fails", async () => {
  const tempRoot = path.join(base, "failed-callback-tmp");
  await assert.rejects(
    () => withTunnelClientEnvFile({ tempRoot, securityBin: security, platform: "darwin" }, async () => {
      throw new Error("synthetic callback failure");
    }),
    /synthetic callback failure/,
  );
  assert.equal(fs.readdirSync(tempRoot).length, 0);
});
