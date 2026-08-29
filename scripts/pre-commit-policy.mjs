#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The bridge invokes Git with --literal-pathspecs.  Git propagates that
// setting to hooks, but check-ignore does not accept that pathspec mode.
delete process.env.GIT_LITERAL_PATHSPECS;

const root = execFileSync("git", ["-c", "safe.directory=*", "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const hookPath = execFileSync("git", ["-c", `safe.directory=${root}`, "config", "--local", "--get", "core.hooksPath"], { encoding: "utf8" }).trim();
if (hookPath !== ".githooks") throw new Error("pre-commit refused: core.hooksPath must be exactly .githooks");

const names = execFileSync("git", ["-c", `safe.directory=${root}`, "diff", "--cached", "--name-only", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
for (const name of names) {
  if (isDenied(name)) throw new Error(`pre-commit refused secret-sensitive or runtime path: ${name}`);
  const ignored = spawnSync("git", ["-c", `safe.directory=${root}`, "check-ignore", "--no-index", "--quiet", "--", name], { encoding: "utf8" });
  if (ignored.status === 0) throw new Error(`pre-commit refused repository-ignored path: ${name}`);
  if (ignored.status !== 1) throw new Error(`pre-commit could not verify ignored state: ${name}${ignored.stderr ? ` (${ignored.stderr.trim()})` : ""}`);
  const absolute = path.join(root, name);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`pre-commit refused staged symlink: ${name}`);
  }
}
const check = execFileSync("git", ["-c", `safe.directory=${root}`, "diff", "--cached", "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (check) process.stdout.write(check);
process.stderr.write(`S1 pre-commit policy passed (${names.length} path${names.length === 1 ? "" : "s"})\n`);

function isDenied(name) {
  const parts = name.split(/[\\/]/).filter(Boolean).map((part) => part.toLowerCase());
  const base = parts.at(-1) || "";
  if (base === ".env.example") return false;
  const deniedDirs = new Set([".git", "node_modules", ".ds_store", ".storage", ".venv", "__pycache__", "backups", "backup", "runtime", "logs", "log", "secrets", "credentials", "private"]);
  if (parts.slice(0, -1).some((part) => deniedDirs.has(part))) return true;
  return /^\.env(?:\..*)?$/.test(base)
    || /^db\.env$/.test(base)
    || /^secrets?\.(?:ya?ml|json)$/.test(base)
    || /(?:^|[._-])(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)(?:$|[._-])/.test(base)
    || /\.(?:pem|key|p12|pfx|jks|db|sqlite|sqlite3|wal|shm|dump|bak|backup|log)$/.test(base);
}
