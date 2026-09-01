import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  S6_GH_COMMAND,
  S6_GH_REALPATH,
  S6_GH_VERSION,
  s6CredentialHelperStatus,
  withS6GitCredentialHelper,
} from "../../scripts/s6-credential.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s6-gh-credential-test-"));
const cellar = path.join(base, "Cellar", "gh", "2.96.0", "bin");
const bin = path.join(base, "bin");
const ghTarget = path.join(cellar, "gh");
const ghCommand = path.join(bin, "gh");
const ghConfigDir = path.join(base, ".config", "gh");
const managerRoot = path.join(base, "chatgpt-local-bridge-s6-manager");
const keychain = path.join(base, "Library", "Keychains", "login.keychain-db");
const securityBin = path.join(base, "security");
const ghMarker = path.join(base, "gh-invocation.txt");

fs.mkdirSync(cellar, { recursive: true, mode: 0o755 });
fs.mkdirSync(bin, { recursive: true, mode: 0o755 });
fs.mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(keychain), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(ghConfigDir, "config.yml"), "git_protocol: https\n", { mode: 0o600 });
fs.writeFileSync(path.join(ghConfigDir, "hosts.yml"), "github.com: {}\n", { mode: 0o600 });
fs.writeFileSync(keychain, "synthetic encrypted keychain\n", { mode: 0o600 });
writeExecutable(ghTarget, `#!/bin/sh
set -eu
if [ "\${1-}" = --version ]; then
  printf '%s\n' 'gh version 2.96.0 (synthetic)'
  exit 0
fi
printf '%s\n' "args=$*" "host=\${GH_HOST-}" "config=\${GH_CONFIG_DIR-}" "home=\${HOME-}" "prompt=\${GH_PROMPT_DISABLED-}" "gh_token=\${GH_TOKEN+present}" "github_token=\${GITHUB_TOKEN+present}" > '${ghMarker}'
if [ "\${1-} \${2-} \${3-}" != 'auth git-credential get' ]; then exit 92; fi
printf '%s\n' 'protocol=https' 'host=github.com' 'username=synthetic-user' 'password=ghp_synthetic_secret' ''
`);
fs.symlinkSync(ghTarget, ghCommand);
const ghRealpath = fs.realpathSync(ghTarget);
writeExecutable(securityBin, `#!/bin/sh
set -eu
if [ "\${1-} \${2-} \${3-}" = 'default-keychain -d user' ]; then
  printf '"%s"\n' '${keychain}'
  exit 0
fi
if [ "\${1-} \${2-} \${3-} \${4-} \${5-}" = 'list-keychains -d user -s ${keychain}' ]; then
  mkdir -p "$HOME/Library/Preferences"
  printf '%s\n' configured > "$HOME/Library/Preferences/keychain-search-list"
  exit 0
fi
exit 93
`);

const identity = {
  ghCommand,
  expectedRealpath: ghRealpath,
  expectedSha256: sha256(ghTarget),
  expectedVersion: "2.96.0",
  ghConfigDir,
  securityBin,
  platform: "darwin",
  expectedUid: process.getuid(),
  securityExpectedUid: process.getuid(),
  expectedHome: base,
};

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("S6 selects exact GitHub CLI credential delegation and keeps Apple helper rejected", () => {
  assert.equal(S6_GH_COMMAND, "/usr/local/bin/gh");
  assert.equal(S6_GH_REALPATH, "/usr/local/Cellar/gh/2.96.0/bin/gh");
  assert.equal(S6_GH_VERSION, "2.96.0");
  assert.doesNotMatch(S6_GH_COMMAND, /osxkeychain/);
  assert.deepEqual(s6CredentialHelperStatus(identity), {
    available: true,
    mechanism: "GitHub CLI Git credential helper delegation",
    helper: "gh auth git-credential",
    reason: "existing Mac developer GitHub authentication is available through the exact reviewed GitHub CLI helper",
  });
});

test("S6 rejects arbitrary gh paths, targets, hashes, config, and non-macOS use", () => {
  assert.equal(s6CredentialHelperStatus({ ...identity, ghCommand: ghTarget }).available, false, "the reviewed symlink command identity is required");
  assert.equal(s6CredentialHelperStatus({ ...identity, expectedRealpath: path.join(base, "other-gh") }).available, false);
  assert.equal(s6CredentialHelperStatus({ ...identity, expectedSha256: "0".repeat(64) }).available, false);
  assert.equal(s6CredentialHelperStatus({ ...identity, ghConfigDir: path.join(base, "missing-config") }).available, false);
  assert.equal(s6CredentialHelperStatus({ ...identity, platform: "linux" }).available, false);
});

test("S6 creates an outside-workspace read-only wrapper and revalidates exact identity every round", () => {
  let delegated;
  withS6GitCredentialHelper({ ...identity, managerRoot }, (value) => { delegated = value; });
  assert.equal(delegated.helperBin.startsWith(`${managerRoot}${path.sep}`), true);
  assert.equal(delegated.helperBin.includes(`${path.sep}sessions${path.sep}`), false);
  const wrapper = fs.lstatSync(delegated.helperBin);
  assert.equal(wrapper.isFile(), true);
  assert.equal(wrapper.isSymbolicLink(), false);
  assert.equal(wrapper.mode & 0o222, 0, "workspace must not be able to write the helper wrapper");
  assert.equal(fs.existsSync(path.join(delegated.managerHome, "Library", "Preferences", "keychain-search-list")), true);

  fs.chmodSync(delegated.helperBin, 0o700);
  assert.throws(() => withS6GitCredentialHelper({ ...identity, managerRoot }, () => {}), /wrapper identity is invalid/);
});

test("S6 wrapper delegates only get, strips inherited GH credentials, and fixes gh environment", () => {
  fs.rmSync(managerRoot, { recursive: true, force: true });
  let delegated;
  withS6GitCredentialHelper({ ...identity, managerRoot }, (value) => { delegated = value; });

  fs.rmSync(ghMarker, { force: true });
  const get = spawnSync(delegated.helperBin, ["get"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "forbidden", GITHUB_TOKEN: "forbidden", GH_HOST: "evil.example" },
  });
  assert.equal(get.status, 0, get.stderr);
  assert.match(get.stdout, /password=ghp_synthetic_secret/);
  const marker = fs.readFileSync(ghMarker, "utf8");
  assert.match(marker, /^args=auth git-credential get$/m);
  assert.match(marker, /^host=github\.com$/m);
  assert.match(marker, new RegExp(`^config=${escapeRegex(ghConfigDir)}$`, "m"));
  assert.match(marker, new RegExp(`^home=${escapeRegex(delegated.managerHome)}$`, "m"));
  assert.match(marker, /^prompt=1$/m);
  assert.match(marker, /^gh_token=$/m);
  assert.match(marker, /^github_token=$/m);

  for (const operation of ["store", "erase"]) {
    fs.rmSync(ghMarker, { force: true });
    const result = spawnSync(delegated.helperBin, [operation], {
      input: "protocol=https\nhost=github.com\nusername=synthetic-user\npassword=ghp_must_not_mutate\n\n",
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(ghMarker), false, `${operation} must not invoke gh`);
  }
});

test("S6 wrapper rejects authority changes before gh helper execution", () => {
  let delegated;
  withS6GitCredentialHelper({ ...identity, managerRoot }, (value) => { delegated = value; });
  for (const request of [
    "protocol=http\nhost=github.com\n\n",
    "protocol=https\nhost=evil.example\n\n",
    "protocol=https\nhost=github.com\npassword=caller-secret\n\n",
  ]) {
    fs.rmSync(ghMarker, { force: true });
    const result = spawnSync(delegated.helperBin, ["get"], { input: request, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(ghMarker), false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /caller-secret/);
  }
});

function writeExecutable(target, content) {
  fs.writeFileSync(target, content, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
}

function sha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
