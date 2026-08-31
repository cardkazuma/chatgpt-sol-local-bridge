import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  S6_GIT_CREDENTIAL_HELPER,
  s6CredentialHelperStatus,
  withS6GitCredentialHelper,
} from "../../scripts/s6-credential.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s6-credential-test-"));
const helper = path.join(base, "git-credential-osxkeychain");
const codesign = path.join(base, "codesign");
fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
fs.writeFileSync(codesign, `#!/bin/sh
printf '%s\\n' 'Identifier=com.apple.git-credential-osxkeychain' >&2
printf '%s\\n' 'TeamIdentifier=59GAB85EFG' >&2
exit 0
`, { mode: 0o700 });
fs.chmodSync(helper, 0o700);
fs.chmodSync(codesign, 0o700);

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("S6 credential custody validates the fixed Apple helper identity", () => {
  assert.equal(S6_GIT_CREDENTIAL_HELPER, "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain");
  assert.deepEqual(s6CredentialHelperStatus({ helperBin: helper, codesignBin: codesign, platform: "darwin", expectedUid: process.getuid() }), {
    available: true,
    mechanism: "Git credential helper delegation",
    helper: "git-credential-osxkeychain",
    reason: "existing Mac developer GitHub authentication is available through the fixed Apple helper",
  });
  assert.equal(s6CredentialHelperStatus({ helperBin: helper, codesignBin: codesign, platform: "linux", expectedUid: process.getuid() }).available, false);
});

test("S6 delegates only the helper executable identity and never creates credential material", () => {
  const before = fs.readdirSync(base).sort();
  const observed = withS6GitCredentialHelper({ helperBin: helper, codesignBin: codesign, platform: "darwin", expectedUid: process.getuid() }, ({ helperBin }) => helperBin);
  assert.equal(observed, helper);
  assert.deepEqual(fs.readdirSync(base).sort(), before);
});
