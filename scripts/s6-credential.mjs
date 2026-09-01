import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The Apple osxkeychain helper is deliberately not selected: its real S6
// isolated smoke returned no usable credential. S6 instead pins the already
// authenticated GitHub CLI and lends Git only a broker-owned protocol wrapper.
export const S6_GH_COMMAND = "/usr/local/bin/gh";
export const S6_GH_REALPATH = "/usr/local/Cellar/gh/2.96.0/bin/gh";
export const S6_GH_VERSION = "2.96.0";
export const S6_GH_SHA256 = "b5f377d33f5e837a324c38f8763a118e2bb56800baa7ea1b84a352ee9e292614";
const S6_DEVELOPER_HOME = os.userInfo().homedir;
export const S6_GH_CONFIG_DIR = path.join(S6_DEVELOPER_HOME, ".config", "gh");
export const S6_SECURITY_BIN = "/usr/bin/security";

export function s6CredentialHelperStatus({
  ghCommand = S6_GH_COMMAND,
  expectedRealpath = S6_GH_REALPATH,
  expectedSha256 = S6_GH_SHA256,
  expectedVersion = S6_GH_VERSION,
  ghConfigDir = S6_GH_CONFIG_DIR,
  platform = process.platform,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : -1,
  expectedHome = S6_DEVELOPER_HOME,
} = {}) {
  if (platform !== "darwin") return unavailable("GitHub CLI keyring delegation requires macOS");
  if (![ghCommand, expectedRealpath, ghConfigDir, expectedHome].every((value) => path.isAbsolute(value))) return unavailable("trusted GitHub CLI identity is invalid");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) return unavailable("trusted GitHub CLI identity is invalid");
  try {
    const commandStat = fs.lstatSync(ghCommand);
    if (!commandStat.isSymbolicLink() || fs.realpathSync(ghCommand) !== expectedRealpath) return unavailable("trusted GitHub CLI command or symlink target is invalid");
    const targetStat = fs.lstatSync(expectedRealpath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || (targetStat.mode & 0o111) === 0 || targetStat.uid !== expectedUid) return unavailable("trusted GitHub CLI target ownership or mode is invalid");
    if (sha256(expectedRealpath) !== expectedSha256) return unavailable("trusted GitHub CLI hash is invalid");
    validateGhConfig(ghConfigDir, expectedHome, expectedUid);
  } catch (error) {
    return unavailable(error.message.startsWith("trusted ") ? error.message : "trusted GitHub CLI or config is unavailable");
  }
  const version = spawnSync(expectedRealpath, ["--version"], fixedInspectionOptions());
  if (version.status !== 0 || !String(version.stdout || "").startsWith(`gh version ${expectedVersion} `)) return unavailable("trusted GitHub CLI version is invalid");
  return {
    available: true,
    mechanism: "GitHub CLI Git credential helper delegation",
    helper: "gh auth git-credential",
    reason: "existing Mac developer GitHub authentication is available through the exact reviewed GitHub CLI helper",
  };
}

/**
 * Revalidate the executable/config identity, prepare a manager-only keychain
 * search list, and lend Git only the absolute wrapper path. Helper stdout is
 * connected directly to Git; it never passes through this application.
 */
export function withS6GitCredentialHelper(options = {}, callback) {
  if (typeof callback !== "function") throw new Error("S6 Git credential delegation callback is required");
  if (!options.managerRoot || !path.isAbsolute(options.managerRoot)) throw new Error("S6 credential manager root is invalid");
  const status = s6CredentialHelperStatus(options);
  if (!status.available) throw new Error(status.reason);

  const managerRoot = path.resolve(options.managerRoot);
  const helperRoot = path.join(managerRoot, "credential-helper");
  const managerHome = path.join(helperRoot, "home");
  const managerTmp = path.join(helperRoot, "tmp");
  const helperBin = path.join(helperRoot, "git-credential-s6-gh");
  for (const directory of [helperRoot, managerHome, managerTmp, path.join(managerHome, "Library", "Preferences")]) ensurePrivateDirectory(directory);

  const securityBin = options.securityBin || S6_SECURITY_BIN;
  validateSecurityBinary(securityBin, options.securityExpectedUid ?? 0);
  const keychain = readDefaultKeychain(securityBin, options.expectedHome || S6_DEVELOPER_HOME);
  configureManagerKeychainSearchList(securityBin, managerHome, keychain);

  const source = credentialWrapperSource({
    ghRealpath: options.expectedRealpath || S6_GH_REALPATH,
    ghConfigDir: options.ghConfigDir || S6_GH_CONFIG_DIR,
    managerHome,
    managerTmp,
  });
  if (!fs.existsSync(helperBin)) {
    fs.writeFileSync(helperBin, source, { encoding: "utf8", mode: 0o500 });
    fs.chmodSync(helperBin, 0o500);
  }
  validateWrapper(helperBin, source);
  return callback({ helperBin, managerHome });
}

export function s6CredentialProbe(options = {}) {
  return s6CredentialHelperStatus(options);
}

function validateGhConfig(configDir, expectedHome, expectedUid) {
  if (path.resolve(configDir) !== path.join(path.resolve(expectedHome), ".config", "gh")) throw new Error("trusted GitHub CLI config location is invalid");
  const directory = fs.lstatSync(configDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== expectedUid || (directory.mode & 0o022) !== 0) throw new Error("trusted GitHub CLI config ownership or mode is invalid");
  const entries = fs.readdirSync(configDir).sort();
  if (entries.join("\n") !== "config.yml\nhosts.yml") throw new Error("trusted GitHub CLI config surface is not narrow");
  for (const name of entries) {
    const stat = fs.lstatSync(path.join(configDir, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o077) !== 0) throw new Error("trusted GitHub CLI config file ownership or mode is invalid");
  }
}

function validateSecurityBinary(securityBin, expectedUid) {
  if (!path.isAbsolute(securityBin)) throw new Error("trusted macOS security path is invalid");
  const stat = fs.lstatSync(securityBin);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) throw new Error("trusted macOS security identity is invalid");
}

function readDefaultKeychain(securityBin, expectedHome) {
  const result = spawnSync(securityBin, ["default-keychain", "-d", "user"], {
    ...fixedInspectionOptions(),
    env: { HOME: expectedHome, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0) throw new Error("existing developer keychain is unavailable");
  const keychain = String(result.stdout || "").trim().replace(/^"|"$/g, "");
  const expectedRoot = path.join(path.resolve(expectedHome), "Library", "Keychains");
  if (!path.isAbsolute(keychain) || !isWithin(keychain, expectedRoot)) throw new Error("existing developer keychain location is invalid");
  const stat = fs.lstatSync(keychain);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== (typeof process.getuid === "function" ? process.getuid() : stat.uid)) throw new Error("existing developer keychain identity is invalid");
  return keychain;
}

function configureManagerKeychainSearchList(securityBin, managerHome, keychain) {
  const result = spawnSync(securityBin, ["list-keychains", "-d", "user", "-s", keychain], {
    ...fixedInspectionOptions(),
    env: { HOME: managerHome, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0) throw new Error("isolated S6 keychain search list could not be configured");
}

function credentialWrapperSource({ ghRealpath, ghConfigDir, managerHome, managerTmp }) {
  return `#!/bin/sh
set -eu
operation=\${1-}
case "$operation" in
  store|erase)
    while IFS= read -r _line; do :; done
    exit 0
    ;;
  get) ;;
  *) exit 64 ;;
esac
protocol=
host=
invalid=0
while IFS= read -r line; do
  case "$line" in
    protocol=https) protocol=https ;;
    host=github.com) host=github.com ;;
    '') ;;
    *) invalid=1 ;;
  esac
done
if [ "$protocol" != https ] || [ "$host" != github.com ] || [ "$invalid" -ne 0 ]; then exit 65; fi
printf '%s\\n' 'protocol=https' 'host=github.com' '' | /usr/bin/env -i HOME=${shellQuote(managerHome)} TMPDIR=${shellQuote(managerTmp)} PATH=/usr/bin:/bin LANG=C LC_ALL=C GH_HOST=github.com GH_CONFIG_DIR=${shellQuote(ghConfigDir)} GH_PROMPT_DISABLED=1 ${shellQuote(ghRealpath)} auth git-credential get
`;
}

function validateWrapper(helperBin, expectedSource) {
  const stat = fs.lstatSync(helperBin);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== (typeof process.getuid === "function" ? process.getuid() : stat.uid) || (stat.mode & 0o777) !== 0o500 || fs.readFileSync(helperBin, "utf8") !== expectedSource) {
    throw new Error("S6 credential wrapper identity is invalid");
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== (typeof process.getuid === "function" ? process.getuid() : stat.uid)) throw new Error("S6 credential directory is invalid");
}

function fixedInspectionOptions() {
  return { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true };
}

function unavailable(reason) { return { available: false, reason }; }
function sha256(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
