#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s1-proof-"));
const workspace = path.join(base, "workspace");
const outsideDir = path.join(base, "outside");
const fakeHome = path.join(base, "host-home-sentinel");
const containerName = `bridge-s1-proof-${process.pid}`;
const outside = path.join(outsideDir, "outside-secret.txt");
const outsideWrite = path.join(outsideDir, "outside-write.txt");
let containerOutput = "";
let inspect = null;

try {
  prepareFixture();
  const env = {
    ...process.env,
    BRIDGE_WORKSPACE: workspace,
    BRIDGE_GIT_CONFIG: path.join(workspace, ".git", "config"),
    BRIDGE_GITHOOKS: path.join(workspace, ".githooks"),
    BRIDGE_POLICY_FILE: path.join(workspace, "scripts", "pre-commit-policy.mjs"),
    S1_HOST_OUTSIDE_PATH: outside,
    S1_HOST_OUTSIDE_WRITE: outsideWrite,
    S1_HOST_HOME_SENTINEL: fakeHome,
    S1_NORMAL_HOME: os.homedir(),
  };
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROFILES", "DOCKER_AUTH_CONFIG"]) delete env[name];
  const configResult = runDocker(["compose", "-f", "compose.yaml", "config", "-q"], env);
  assert(!configResult.output.trim(), `Compose validation emitted warnings or output:\n${configResult.output}`);
  runDocker(["compose", "-f", "compose.yaml", "build", "bridge"], env);
  const result = spawnDocker([
    "compose", "-f", "compose.yaml", "run", "--no-deps", "--name", containerName,
    "--env", `S1_HOST_OUTSIDE_PATH=${outside}`,
    "--env", `S1_HOST_OUTSIDE_WRITE=${outsideWrite}`,
    "--env", `S1_HOST_HOME_SENTINEL=${fakeHome}`,
    "--env", `S1_NORMAL_HOME=${os.homedir()}`,
    "bridge", "node", "/opt/bridge/scripts/s1-container-proof.mjs",
  ], env);
  containerOutput = result.output;
  inspect = dockerInspect(containerName);
  assert(result.status === 0, `container proof failed (exit ${result.status})\n${containerOutput.slice(-16_000)}`);
  assertHostSentinels();
  assertContainerConfig(inspect);
  const proof = parseLastJson(containerOutput);
  assert(proof && proof.failed === 0, `container proof did not report all checks passing: ${JSON.stringify(proof)}\n${containerOutput.slice(-16_000)}`);
  console.log(JSON.stringify({
    proof: "s1-host-and-container",
    containerExit: inspect.State.ExitCode,
    image: inspect.Config.Image,
    runtime: summarizeRuntime(inspect),
    hostSentinelsUnchanged: true,
    checks: proof,
  }, null, 2));
} finally {
  runDockerQuiet(["rm", "-f", containerName]);
  fs.rmSync(base, { recursive: true, force: true });
}

function prepareFixture() {
  fs.mkdirSync(workspace, { recursive: true, mode: 0o777 });
  fs.mkdirSync(outsideDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true, mode: 0o777 });
  fs.mkdirSync(path.join(fakeHome, ".config", "gh"), { recursive: true, mode: 0o777 });
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true, mode: 0o777 });
  fs.writeFileSync(outside, "outside-secret\n", { mode: 0o666 });
  fs.writeFileSync(path.join(fakeHome, ".ssh", "id_ed25519"), "fake-private-key\n", { mode: 0o666 });
  fs.writeFileSync(path.join(fakeHome, ".config", "gh", "hosts.yml"), "fake-github-credential\n", { mode: 0o666 });
  fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"), "fake-codex-credential\n", { mode: 0o666 });
  fs.writeFileSync(path.join(workspace, ".gitignore"), [".env", "db.env", "ignored.txt", "*.log", "backups/", "*.db"].join("\n") + "\n");
  fs.writeFileSync(path.join(workspace, "README.md"), "disposable fixture\n");
  fs.writeFileSync(path.join(workspace, ".env"), "DISPOSABLE_SECRET=do-not-read\n");
  fs.writeFileSync(path.join(workspace, "db.env"), "DB_PASSWORD=do-not-read\n");
  fs.writeFileSync(path.join(workspace, "secrets.yaml"), "token: do-not-read\n");
  fs.mkdirSync(path.join(workspace, ".storage"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".storage", "token"), "do-not-read\n");
  fs.writeFileSync(path.join(workspace, "fixture.log"), "DISPOSABLE_SECRET=credential-bearing log\n");
  fs.writeFileSync(path.join(workspace, "ignored.txt"), "ignored DISPOSABLE_SECRET\n");
  fs.mkdirSync(path.join(workspace, "backups"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "backups", "secret.txt"), "backup DISPOSABLE_SECRET\n");
  fs.writeFileSync(path.join(workspace, "runtime.db"), "database artifact\n");
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    name: "s1-disposable-fixture",
    version: "1.0.0",
    scripts: {
      test: "node -e \"require('fs').existsSync('allowed.txt') || process.exit(1)\"",
      lint: "node -e \"console.log('lint ok')\"",
      typecheck: "node -e \"console.log('typecheck ok')\"",
      build: "node -e \"require('fs').writeFileSync('build-output.txt','built\\n')\"",
    },
  }, null, 2) + "\n");
  fs.mkdirSync(path.join(workspace, ".githooks"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(repo, ".githooks", "pre-commit"), path.join(workspace, ".githooks", "pre-commit"));
  fs.copyFileSync(path.join(repo, "scripts", "pre-commit-policy.mjs"), path.join(workspace, "scripts", "pre-commit-policy.mjs"));
  fs.chmodSync(path.join(workspace, ".githooks", "pre-commit"), 0o755);
  fs.symlinkSync("/etc/passwd", path.join(workspace, "escape-system"));
  chmodTree(workspace);
  runGit(["init", "-q", "-b", "main"]);
  runGit(["config", "user.name", "S1 Fixture"]);
  runGit(["config", "user.email", "s1-fixture@example.invalid"]);
  runGit(["config", "core.hooksPath", ".githooks"]);
  runGit(["add", ".gitignore", "README.md", "package.json", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs"]);
  runGit(["commit", "-qm", "fixture baseline"]);
  chmodTree(workspace);
  fs.chmodSync(path.join(workspace, ".githooks", "pre-commit"), 0o755);
  fs.symlinkSync(outside, path.join(workspace, "escape-host"));
}

function chmodTree(target) {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      fs.chmodSync(full, 0o777);
      chmodTree(full);
    } else if (!entry.isSymbolicLink()) {
      fs.chmodSync(full, 0o666);
    }
  }
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  assert(result.status === 0, `fixture git failed: ${result.stderr || result.stdout}`);
}

function runDocker(args, env) {
  const result = spawnDocker(args, env);
  assert(result.status === 0, `Docker command failed: ${args.join(" ")}\n${result.output.slice(-16_000)}`);
  return result;
}

function spawnDocker(args, env) {
  const result = spawnSync("docker", args, { cwd: repo, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return {
    ...result,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function runDockerQuiet(args) {
  spawnSync("docker", args, { cwd: repo, encoding: "utf8", stdio: "ignore" });
}

function dockerInspect(name) {
  const result = spawnSync("docker", ["inspect", name], { cwd: repo, encoding: "utf8" });
  assert(result.status === 0, `docker inspect failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout)[0];
}

function assertHostSentinels() {
  assert(fs.readFileSync(outside, "utf8") === "outside-secret\n", "outside sentinel changed");
  assert(!fs.existsSync(outsideWrite), "outside write target was created");
  assert(fs.readFileSync(path.join(fakeHome, ".ssh", "id_ed25519"), "utf8") === "fake-private-key\n", "SSH sentinel changed");
  assert(fs.readFileSync(path.join(fakeHome, ".config", "gh", "hosts.yml"), "utf8") === "fake-github-credential\n", "GitHub sentinel changed");
  assert(fs.readFileSync(path.join(fakeHome, ".codex", "config.toml"), "utf8") === "fake-codex-credential\n", "Codex sentinel changed");
  assert(fs.readFileSync(path.join(workspace, ".githooks", "pre-commit"), "utf8") === fs.readFileSync(path.join(repo, ".githooks", "pre-commit"), "utf8"), "hook mount changed");
  assert(fs.readFileSync(path.join(workspace, ".git", "config"), "utf8").includes("hooksPath = .githooks"), "Git config changed");
  assert(fs.readFileSync(path.join(workspace, "scripts", "pre-commit-policy.mjs"), "utf8") === fs.readFileSync(path.join(repo, "scripts", "pre-commit-policy.mjs"), "utf8"), "policy mount changed");
}

function assertContainerConfig(value) {
  assert(value.State.ExitCode === 0, `container exit code was ${value.State.ExitCode}`);
  assert(value.Config.User === "10001:10001", "container user was not pinned non-root");
  assert(value.HostConfig.ReadonlyRootfs === true, "container rootfs was not read-only");
  assert(value.HostConfig.Privileged === false, "container was privileged");
  assert(value.HostConfig.NetworkMode === "none", `network mode was ${value.HostConfig.NetworkMode}`);
  assert(value.HostConfig.NanoCpus === 1_000_000_000, "CPU bound was not 1 CPU");
  assert(value.HostConfig.Memory === 512 * 1024 * 1024, "memory bound was not 512 MiB");
  assert(value.HostConfig.PidsLimit === 128, "PID bound was not 128");
  assert((value.HostConfig.CapDrop || []).includes("ALL"), "all Linux capabilities were not dropped");
  assert((value.HostConfig.SecurityOpt || []).some((item) => item === "no-new-privileges:true"), "no-new-privileges was not configured");
  assert(!value.HostConfig.PidMode || value.HostConfig.PidMode !== "host", "host PID namespace was shared");
  assert(!value.HostConfig.IpcMode || value.HostConfig.IpcMode !== "host", "host IPC namespace was shared");
  assert(!(value.HostConfig.Devices || []).length, "host devices were passed through");
  const mounts = value.Mounts || [];
  const binds = mounts.filter((mount) => mount.Type === "bind");
  assert(binds.length === 4, `expected exactly four disposable-workspace bind mounts, found ${binds.length}`);
  assert(binds.every((mount) => mount.Source.startsWith(base) && mount.RW === (mount.Destination === "/workspace/repo")), "a host mount escaped the disposable fixture or was writable unexpectedly");
  assert(!(value.Config.Env || []).some((item) => /^(?:MCP_TOKEN|CONTROL_PLANE_API_KEY|GITHUB_TOKEN|GH_TOKEN|CODEX_|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_|NPM_TOKEN|SSH_AUTH_SOCK|TUNNEL_)=/i.test(item)), "credential material was in container environment");
  const networks = Object.keys(value.NetworkSettings?.Networks || {});
  assert(networks.every((name) => name === "none"), `container had a non-none Docker network attachment: ${networks.join(", ")}`);
}

function summarizeRuntime(value) {
  return {
    user: value.Config.User,
    readonlyRootfs: value.HostConfig.ReadonlyRootfs,
    networkMode: value.HostConfig.NetworkMode,
    capDrop: value.HostConfig.CapDrop,
    securityOpt: value.HostConfig.SecurityOpt,
    nanoCpus: value.HostConfig.NanoCpus,
    memoryBytes: value.HostConfig.Memory,
    pidsLimit: value.HostConfig.PidsLimit,
    bindMountTargets: (value.Mounts || []).filter((mount) => mount.Type === "bind").map((mount) => ({ target: mount.Destination, readOnly: !mount.RW })),
  };
}

function parseLastJson(output) {
  const start = output.lastIndexOf('{\n  "proof"');
  if (start < 0) return null;
  const end = output.lastIndexOf("\n}") + 2;
  try { return JSON.parse(output.slice(start, end)); } catch { return null; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
