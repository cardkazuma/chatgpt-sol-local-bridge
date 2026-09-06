import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// This identity is intentionally fixed.  There is no generic "get secret"
// command: the only read path is the tunnel-client env-file callback below.
export const KEYCHAIN_SERVICE = "com.cardkazuma.chatgpt-local-bridge.runtime";
export const KEYCHAIN_ACCOUNT = "tunnel-client";
export const KEYCHAIN_LABEL = "ChatGPT Local Bridge runtime key";
export const SECURITY_BIN = "/usr/bin/security";

export function keychainStatus({ securityBin = SECURITY_BIN, platform = process.platform } = {}) {
  if (platform !== "darwin") return { available: false, reason: "macOS Keychain is required on this host" };
  const result = spawnSecurity(securityBin, [
    "find-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
  ], { stdio: "ignore" });
  return result.status === 0
    ? { available: true, reason: "dedicated Keychain item is present" }
    : { available: false, reason: "dedicated Keychain item is not available" };
}

/** Probe whether the fixed item is usable without ever returning or capturing its value. */
export function keychainUsabilityStatus({ securityBin = SECURITY_BIN, platform = process.platform } = {}) {
  const present = keychainStatus({ securityBin, platform });
  if (!present.available) return { available: false, present: false, reason: present.reason };
  const result = spawnSecurity(securityBin, [
    "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
  ], { stdio: "ignore" });
  return result.status === 0
    ? { available: true, present: true, reason: "dedicated Keychain item is readable without changing access controls" }
    : { available: false, present: true, reason: "dedicated Keychain item is locked or access-controlled" };
}

/**
 * Store the existing operator-supplied key in the dedicated item.  `-w` is
 * deliberately the final security argument so macOS prompts on the TTY
 * instead of receiving the value in argv, shell history, or this process.
 */
export function installKeychainItem({ securityBin = SECURITY_BIN, platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("S5 credential custody requires macOS Keychain");
  const result = spawnSecurity(securityBin, [
    "add-generic-password",
    "-U",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", KEYCHAIN_SERVICE,
    "-l", KEYCHAIN_LABEL,
    "-D", "application password",
    "-j", "S5 tunnel-client credential; consumed only by the local runtime controller",
    "-T", "",
    "-w",
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Keychain item was not stored");
  return { stored: true, service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT };
}

/**
 * Read exactly one fixed Keychain item and hand a temporary env-file path to a
 * tunnel-only callback.  The secret itself is never returned to the caller,
 * written to an audit record, or accepted as a command-line argument.
 */
export async function withTunnelClientEnvFile({ tempRoot, securityBin = SECURITY_BIN, platform = process.platform }, callback) {
  if (typeof callback !== "function") throw new Error("tunnel credential callback is required");
  const status = keychainStatus({ securityBin, platform });
  if (!status.available) throw new Error("dedicated Keychain runtime item is unavailable");
  const result = spawnSecurity(securityBin, [
    "find-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
    "-w",
  // Preserve the foreground controller's terminal for Keychain access-control
  // confirmation. stdout remains private and is never inherited, because it
  // contains the runtime key when the read succeeds.
  ], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error("dedicated Keychain runtime item could not be read");
  let secret = String(result.stdout || "").replace(/\r?\n$/, "");
  if (!secret || /[\r\n\0]/.test(secret)) throw new Error("dedicated Keychain item returned an invalid value");

  const root = path.resolve(tempRoot || os.tmpdir());
  ensurePrivateDirectory(root);
  const credentialDir = fs.mkdtempSync(path.join(root, "tunnel-credential-"));
  fs.chmodSync(credentialDir, 0o700);
  const envFile = path.join(credentialDir, "tunnel.env");
  fs.writeFileSync(envFile, `CONTROL_PLANE_API_KEY=${secret}\n`, { mode: 0o600, encoding: "utf8" });
  fs.chmodSync(envFile, 0o600);
  secret = "";
  try {
    return await callback(envFile);
  } finally {
    fs.rmSync(credentialDir, { recursive: true, force: true });
  }
}

export function credentialProbe({ securityBin = SECURITY_BIN, platform = process.platform } = {}) {
  return keychainStatus({ securityBin, platform });
}

function spawnSecurity(securityBin, args, options) {
  if (!path.isAbsolute(securityBin)) throw new Error("security binary must be an absolute path");
  return spawnSync(securityBin, args, { ...options, windowsHide: true, timeout: 15_000 });
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("credential temp root must be a real directory");
  fs.chmodSync(directory, 0o700);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("credential temp root owner mismatch");
}
