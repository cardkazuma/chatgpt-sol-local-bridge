import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// S6 deliberately has a different Keychain identity from the S5 OpenAI
// tunnel credential. This module exposes only fixed-purpose status, install,
// and scoped callback operations; it has no generic secret-dump API.
export const S6_KEYCHAIN_SERVICE = "com.cardkazuma.chatgpt-local-bridge.s6.github";
export const S6_KEYCHAIN_ACCOUNT = "homelab-contents-read-write";
export const S6_KEYCHAIN_LABEL = "ChatGPT Local Bridge S6 GitHub homelab credential";
export const S6_SECURITY_BIN = "/usr/bin/security";

export function s6KeychainStatus({ securityBin = S6_SECURITY_BIN, platform = process.platform } = {}) {
  if (platform !== "darwin") return { available: false, reason: "macOS Keychain is required for the S6 GitHub plane" };
  const result = spawnSecurity(securityBin, [
    "find-generic-password", "-s", S6_KEYCHAIN_SERVICE, "-a", S6_KEYCHAIN_ACCOUNT,
  ], { stdio: "ignore" });
  return result.status === 0
    ? { available: true, reason: "dedicated S6 GitHub Keychain item is present" }
    : { available: false, reason: "dedicated S6 GitHub Keychain item is not available" };
}

/**
 * Provisioning is intentionally operator-controlled and never called by S6
 * startup or offline tests. `-w` is the final argument so the value is entered
 * by the Keychain/security TTY path, not argv, shell history, or config.
 */
export function installS6KeychainItem({ securityBin = S6_SECURITY_BIN, platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("S6 GitHub credential custody requires macOS Keychain");
  const result = spawnSecurity(securityBin, [
    "add-generic-password", "-U", "-a", S6_KEYCHAIN_ACCOUNT, "-s", S6_KEYCHAIN_SERVICE,
    "-l", S6_KEYCHAIN_LABEL, "-D", "application password",
    "-j", "S6 GitHub Contents read/write; consumed only by the fixed homelab broker",
    "-T", "", "-w",
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("S6 GitHub Keychain item was not stored");
  return { stored: true, service: S6_KEYCHAIN_SERVICE, account: S6_KEYCHAIN_ACCOUNT };
}

/**
 * Read the one fixed Keychain item only long enough to run the broker's fixed
 * Git transfer. The callback receives a 0600 token file path, never the token
 * value. The directory and file are removed deterministically.
 */
export function withS6GitHubTokenFile({ tempRoot, securityBin = S6_SECURITY_BIN, platform = process.platform }, callback) {
  if (typeof callback !== "function") throw new Error("S6 GitHub credential callback is required");
  const status = s6KeychainStatus({ securityBin, platform });
  if (!status.available) throw new Error("dedicated S6 GitHub Keychain item is unavailable");
  const result = spawnSecurity(securityBin, [
    "find-generic-password", "-s", S6_KEYCHAIN_SERVICE, "-a", S6_KEYCHAIN_ACCOUNT, "-w",
  ], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error("dedicated S6 GitHub Keychain item could not be read");
  let secret = String(result.stdout || "").replace(/\r?\n$/, "");
  if (!secret || /[\r\n\0]/.test(secret)) throw new Error("dedicated S6 GitHub Keychain item returned an invalid value");

  const root = path.resolve(tempRoot || os.tmpdir());
  ensurePrivateDirectory(root);
  const credentialDir = fs.mkdtempSync(path.join(root, "s6-github-credential-"));
  fs.chmodSync(credentialDir, 0o700);
  const tokenFile = path.join(credentialDir, "token");
  fs.writeFileSync(tokenFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  secret = "";
  try {
    return callback(tokenFile);
  } finally {
    fs.rmSync(credentialDir, { recursive: true, force: true });
  }
}

export function s6CredentialProbe(options = {}) {
  return s6KeychainStatus(options);
}

function spawnSecurity(securityBin, args, options) {
  if (!path.isAbsolute(securityBin)) throw new Error("security binary must be an absolute path");
  return spawnSync(securityBin, args, { ...options, windowsHide: true, timeout: 15_000 });
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("S6 credential temp root must be a real directory");
  fs.chmodSync(directory, 0o700);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("S6 credential temp root owner mismatch");
}
