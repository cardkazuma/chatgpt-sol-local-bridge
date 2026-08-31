import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// S6 delegates authentication to the same Apple credential helper used by
// normal developer Git on this Mac. It never asks the helper for a credential
// itself: only the fixed broker-owned Git subprocess may invoke this exact
// helper through Git's credential protocol.
export const S6_GIT_CREDENTIAL_HELPER = "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain";
export const S6_CODESIGN_BIN = "/usr/bin/codesign";
export const S6_HELPER_IDENTIFIER = "com.apple.git-credential-osxkeychain";
export const S6_HELPER_TEAM_IDENTIFIER = "59GAB85EFG";

export function s6CredentialHelperStatus({
  helperBin = S6_GIT_CREDENTIAL_HELPER,
  codesignBin = S6_CODESIGN_BIN,
  platform = process.platform,
  expectedUid = 0,
} = {}) {
  if (platform !== "darwin") return { available: false, reason: "Apple osxkeychain credential delegation requires macOS" };
  if (!path.isAbsolute(helperBin) || !path.isAbsolute(codesignBin)) return { available: false, reason: "trusted credential helper identity is invalid" };
  let stat;
  try { stat = fs.lstatSync(helperBin); } catch { return { available: false, reason: "trusted Apple Git credential helper is unavailable" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 || stat.uid !== expectedUid) {
    return { available: false, reason: "trusted Apple Git credential helper ownership or mode is invalid" };
  }
  const signature = spawnSync(codesignBin, ["-dv", "--verbose=2", helperBin], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    windowsHide: true,
  });
  const detail = `${signature.stdout || ""}\n${signature.stderr || ""}`;
  if (signature.status !== 0 || !detail.includes(`Identifier=${S6_HELPER_IDENTIFIER}`) || !detail.includes(`TeamIdentifier=${S6_HELPER_TEAM_IDENTIFIER}`)) {
    return { available: false, reason: "trusted Apple Git credential helper signature is invalid" };
  }
  return {
    available: true,
    mechanism: "Git credential helper delegation",
    helper: "git-credential-osxkeychain",
    reason: "existing Mac developer GitHub authentication is available through the fixed Apple helper",
  };
}

/**
 * Validate the exact trusted helper and lend only its executable identity to a
 * fixed Git invocation. No credential value enters this process or callback.
 */
export function withS6GitCredentialHelper(options, callback) {
  if (typeof callback !== "function") throw new Error("S6 Git credential delegation callback is required");
  const status = s6CredentialHelperStatus(options);
  if (!status.available) throw new Error(status.reason);
  return callback({ helperBin: options?.helperBin || S6_GIT_CREDENTIAL_HELPER });
}

export function s6CredentialProbe(options = {}) {
  return s6CredentialHelperStatus(options);
}
