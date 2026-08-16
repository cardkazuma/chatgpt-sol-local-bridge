#!/usr/bin/env node
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import dotenv from "dotenv";

const separator = process.argv.indexOf("--");
if (separator < 3 || separator === process.argv.length - 1) {
  console.error("Usage: node scripts/run-with-env.mjs /path/to/runtime.env [--exclude=KEY,...] -- command [args...]");
  process.exit(2);
}
const envFile = process.argv[2];
const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
const excludes = process.argv.slice(3, separator).flatMap((option) => option.startsWith("--exclude=") ? option.slice(10).split(",") : []);
verifySecretFile(envFile);
const parsed = dotenv.parse(fs.readFileSync(envFile));
const childEnv = { ...process.env, ...parsed };
for (const key of excludes) delete childEnv[key];
const child = spawn(command, args, {
  env: childEnv,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`failed to start ${command}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

function verifySecretFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular, non-symlink file`);
  if (typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) throw new Error(`${filePath} must be owned by the current user`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${filePath} must be mode 0600 (not readable by group/others)`);
  } else if (process.platform === "win32") {
    verifyWindowsAcl(filePath);
  }
}

function verifyWindowsAcl(filePath) {
  const literal = `'${String(filePath).replace(/'/g, "''")}'`;
  const script = `$p=${literal}; $acl=Get-Acl -LiteralPath $p; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value; if($owner -ne $me){exit 2}; $broad=@('S-1-1-0','S-1-5-11','S-1-5-32-545'); foreach($ace in $acl.Access){try{$sid=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{continue}; if($ace.AccessControlType -eq 'Allow' -and $broad -contains $sid){exit 3}}; exit 0`;
  const binary = process.env.ComSpec ? "powershell.exe" : "pwsh";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(binary, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${filePath} owner/ACL is too broad for a secret file`);
}
