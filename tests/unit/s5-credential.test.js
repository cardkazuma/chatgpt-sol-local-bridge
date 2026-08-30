import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installKeychainItem, withTunnelClientEnvFile, keychainStatus } from "../../scripts/s5-credential.mjs";

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
