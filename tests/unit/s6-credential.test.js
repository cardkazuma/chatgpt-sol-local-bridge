import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installS6KeychainItem, s6KeychainStatus, withS6GitHubTokenFile } from "../../scripts/s6-credential.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s6-credential-test-"));
const security = path.join(base, "security");
fs.writeFileSync(security, `#!/bin/sh
if [ "$1" = add-generic-password ]; then
  [ "$3" = -a ] && [ "$4" = homelab-contents-read-write ] && [ "$5" = -s ] && [ "$6" = com.cardkazuma.chatgpt-local-bridge.s6.github ] || exit 1
  exit 0
fi
[ "$1" = find-generic-password ] || exit 1
[ "$2" = -s ] && [ "$3" = com.cardkazuma.chatgpt-local-bridge.s6.github ] && [ "$4" = -a ] && [ "$5" = homelab-contents-read-write ] || exit 1
if [ "$6" = -w ]; then printf '%s\\n' 'offline-s6-fixture-token'; fi
exit 0
`, { mode: 0o700 });
fs.chmodSync(security, 0o700);

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("S6 credential custody uses its separate fixed Keychain item", () => {
  assert.deepEqual(s6KeychainStatus({ securityBin: security, platform: "darwin" }), {
    available: true,
    reason: "dedicated S6 GitHub Keychain item is present",
  });
  assert.deepEqual(installS6KeychainItem({ securityBin: security, platform: "darwin" }), {
    stored: true,
    service: "com.cardkazuma.chatgpt-local-bridge.s6.github",
    account: "homelab-contents-read-write",
  });
});

test("S6 token material is callback-scoped, mode 0600, and cleaned on success/failure", () => {
  const tempRoot = path.join(base, "tmp");
  let observed = "";
  withS6GitHubTokenFile({ tempRoot, securityBin: security, platform: "darwin" }, (tokenFile) => {
    observed = fs.readFileSync(tokenFile, "utf8");
    assert.equal(fs.statSync(tokenFile).mode & 0o077, 0);
    assert.equal(path.dirname(tokenFile).startsWith(tempRoot), true);
  });
  assert.equal(observed, "offline-s6-fixture-token\n");
  assert.equal(fs.readdirSync(tempRoot).length, 0);

  assert.throws(() => withS6GitHubTokenFile({ tempRoot, securityBin: security, platform: "darwin" }, () => {
    throw new Error("offline callback failure");
  }), /offline callback failure/);
  assert.equal(fs.readdirSync(tempRoot).length, 0);
});
