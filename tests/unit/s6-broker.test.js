import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { DisposableWorkspaceManager } from "../../scripts/disposable-workspace.mjs";
import {
  classifyPolicyPath,
  classifyPublishPath,
  isHighRiskGovernancePath,
} from "../../scripts/pre-commit-policy.mjs";
import {
  S6GitHubBroker,
  S6BrokerServer,
  S6_REPOSITORY_URL,
  S6_GOVERNANCE_HOOKS_PATH,
  S6_GOVERNANCE_POLICY_PATH,
  assertS6RepositoryAlias,
  assertS6Source,
  s6BranchForSession,
  s6RemoteRefForSession,
  s6BrokerSocketPath,
  parseBrokerReady,
  parsePushReceipt,
} from "../../scripts/s6-github-broker.mjs";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s6-broker-test-"));
const source = path.join(base, "github-source");
const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-local-bridge-s6-test-"));
const gitHome = path.join(base, "git-home");
const gitEnv = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: gitHome,
  XDG_CONFIG_HOME: path.join(gitHome, "config"),
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  GIT_SSH_COMMAND: "/usr/bin/false",
};
const credentialTempRoot = path.join(managerRoot, "credential-tmp");
const credentialRounds = [];
let remoteSha = null;

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(managerRoot, { recursive: true, force: true });
});

test("S6 accepts only the fixed homelab repository and generated branch/ref", () => {
  assert.equal(assertS6RepositoryAlias(), S6_REPOSITORY_URL);
  assert.throws(() => assertS6RepositoryAlias("portfolio-db"), /only the homelab repository alias/);
  for (const value of [
    "https://github.com/other/repo.git",
    "https://github.com/cardkazuma/portfolio-db.git",
    "https://user:password@github.com/cardkazuma/homelab.git",
    "git@github.com:cardkazuma/homelab.git",
    "ssh://git@github.com/cardkazuma/homelab.git",
    "/Users/example/homelab",
    "file:///tmp/homelab",
  ]) assert.throws(() => assertS6Source(value), /fixed to the canonical homelab GitHub repository/);
  const session = "s6-test-0123456789abcdef";
  assert.equal(s6BranchForSession(session), `bridge/s6/${session}`);
  assert.equal(s6RemoteRefForSession(session), `refs/heads/bridge/s6/${session}`);
  assert.throws(() => s6BranchForSession("s5-test-0123456789abcdef"), /invalid S6 session/);
});

test("S6 reuses the reviewed policy and fails closed on sensitive and governance paths", () => {
  for (const name of [".env", "secrets.yaml", "runtime/cache.db", "logs/bridge.log", "private/id_rsa"]) {
    assert.equal(classifyPolicyPath(name).allowed, false, name);
    assert.equal(classifyPublishPath(name).allowed, false, name);
  }
  for (const name of [".github/workflows/release.yml", ".githooks/pre-commit", "scripts/pre-commit-policy.mjs", ".gitmodules"]) {
    assert.equal(isHighRiskGovernancePath(name), true, name);
    assert.equal(classifyPublishPath(name).allowed, false, name);
    assert.match(classifyPublishPath(name).reason, /fail-closed/);
  }
  assert.equal(classifyPublishPath(".env.example").allowed, true);
});

test("S6 broker independently validates a clean linear graph and rejects bypasses, movement, and governance paths", async () => {
  prepareSource();
  const manager = new DisposableWorkspaceManager({
    root: managerRoot,
    source: S6_REPOSITORY_URL,
    remoteName: "origin",
    materializer: (context) => makeBroker(context.sessionId).materializeWorkspace(context),
    governance: {
      external: true,
      hookFile: path.join(repo, "scripts", "s6-pre-commit"),
      policyFile: path.join(repo, "scripts", "pre-commit-policy.mjs"),
      hooksPath: S6_GOVERNANCE_HOOKS_PATH,
      policyPath: S6_GOVERNANCE_POLICY_PATH,
    },
    gitIdentity: { name: "S6 Fixture", email: "s6-fixture@example.invalid" },
    protectedPaths: [repo],
    sessionPrefix: "s6",
    branchPrefix: "bridge/s6",
    staleAfterMs: 15 * 60_000,
  });
  const session = manager.create();
  const broker = makeBroker(session.sessionId, true);
  assert.equal(session.source, S6_REPOSITORY_URL);
  assert.equal(session.branch, `bridge/s6/${session.sessionId}`);
  assert.match(session.expectedBaseCommit, /^[0-9a-f]{40}$/);
  assert.equal(session.historyCommits, 1);
  assert.equal(session.coreHooksPath, S6_GOVERNANCE_HOOKS_PATH);
  assert.equal(readGit(["config", "--local", "--get", "remote.origin.url"], session.workspacePath), S6_REPOSITORY_URL);
  assert.equal(readGit(["config", "--local", "--get", "core.hooksPath"], session.workspacePath), S6_GOVERNANCE_HOOKS_PATH);
  assert.equal(credentialRounds.length, 1);
  assert.equal(fs.readdirSync(credentialTempRoot).length, 0);
  await assert.rejects(() => broker.publishBranch(), /at least one reviewed local commit/);

  const first = commitWithReviewedHook(session, "README.md", "S6 reviewed edit\n", "S6 reviewed edit");
  assert.ok(broker.attestCommit(first).attested);
  const evidence = await broker.publishBranch();
  assert.deepEqual(evidence, {
    repository: "homelab",
    sessionId: session.sessionId,
    branch: session.branch,
    remoteRef: `refs/heads/${session.branch}`,
    baseCommit: session.expectedBaseCommit,
    commit: first,
    remoteSha: first,
    status: "published",
  });
  assert.doesNotMatch(JSON.stringify(evidence), /github_pat|password|token|\/Users|\/tmp/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(managerRoot, "manager-state", `${session.sessionId}.published.json`), "utf8")).publishedSha, first);
  assert.deepEqual(await broker.publishBranch(), { ...evidence, status: "already-published" });
  const restarted = makeBroker(session.sessionId, true);
  assert.deepEqual(await restarted.publishBranch(), { ...evidence, status: "already-published" });
  fs.writeFileSync(path.join(session.workspacePath, ".git", "shallow"), `${session.expectedBaseCommit}\n`, { mode: 0o600 });
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /workspace is shallow/);
  fs.rmSync(path.join(session.workspacePath, ".git", "shallow"), { force: true });
  remoteSha = "b".repeat(40);
  await assert.rejects(() => broker.publishBranch(), /unexpected remote movement/);
  remoteSha = first;

  const bypass = commitWithNoVerify(session, "bypass.txt", "shell-created\n", "shell bypass");
  assert.match(bypass, /^[0-9a-f]{40}$/);
  await assert.rejects(() => broker.publishBranch(), /every unpublished commit.*attestation/);

  const ignored = commitWithNoVerify(session, "ignored.txt", "forced ignored\n", "forced ignored path");
  assert.match(ignored, /^[0-9a-f]{40}$/);
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /repository-ignored path/);
  runGit(["reset", "--hard", first], session.workspacePath, gitEnv);

  fs.mkdirSync(path.join(session.workspacePath, "runtime"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(session.workspacePath, "runtime", "secret.log"), "ignored\n", { mode: 0o600 });
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /clean worktree.*ignored/);
  fs.rmSync(path.join(session.workspacePath, "runtime"), { recursive: true, force: true });

  const workflow = commitWithReviewedHook(session, ".github/workflows/not-approved.yml", "name: not approved\n", "S6 workflow candidate");
  assert.match(workflow, /^[0-9a-f]{40}$/);
  assert.throws(() => broker.attestCommit(workflow), /fail-closed governance or automation path/);
  await assert.rejects(() => broker.publishBranch(), /every unpublished commit.*attestation|fail-closed governance/);

  manager.destroy(session.sessionId);
  assert.equal(fs.existsSync(path.join(managerRoot, "manager-state", `${session.sessionId}.published.json`)), false);
});

test("S6 broker socket protocol carries no caller-selected target", async () => {
  const session = "s6-protocol-0123456789abcdef";
  const protocolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-local-bridge-s6-protocol-"));
  const broker = new S6GitHubBroker({ managerRoot: protocolRoot, bridgeRoot: repo, sessionId: session, platform: "linux", remoteAdapter: { lsRemote: () => null } });
  const socketPath = s6BrokerSocketPath(protocolRoot, session);
  const server = new S6BrokerServer({ broker, socketPath });
  try {
    server.listen();
    await once(server.server, "listening");
    parseBrokerReady("S6_BROKER_READY");
    const capability = "a".repeat(64);
    assert.deepEqual(await brokerRequest(socketPath, { operation: "register", capability }), { registered: true });
    assert.match((await brokerRequest(socketPath, { operation: "publish", capability: "b".repeat(64) })).error, /authentication/);
    assert.match((await brokerRequest(socketPath, { operation: "publish", capability, branch: "main", force: true, refspec: "*" })).error, /no authority-bearing input/);
  } finally {
    await server.close();
    fs.rmSync(protocolRoot, { recursive: true, force: true });
  }
  assert.equal(broker.repositoryAlias(), "homelab");
  assert.throws(() => s6RemoteRefForSession("s5-protocol-0123456789abcdef"), /invalid/);
});

test("S6 accepts only exact fast-forward or new-branch push receipts", () => {
  const ref = "refs/heads/bridge/s6/s6-receipt-0123456789abcdef";
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  assert.deepEqual(parsePushReceipt(`To ${S6_REPOSITORY_URL}\n\tHEAD:${ref} ${oldSha}..${newSha}\nDone`, ref), { oldSha, newSha });
  assert.deepEqual(parsePushReceipt(`To ${S6_REPOSITORY_URL}\n*\tHEAD:${ref} [new branch]\nDone`, ref), { oldSha: null, newSha: null });
  assert.throws(() => parsePushReceipt(`HEAD:${ref} [forced update]`, ref), /not an exact/);
});

function makeBroker(sessionId, withRemote = false) {
  return new S6GitHubBroker({
    managerRoot,
    bridgeRoot: repo,
    sessionId,
    platform: "linux",
    credentialTempRoot,
    gitRunner: offlineGitRunner,
    credentialRunner: fakeCredentialRunner,
    remoteAdapter: withRemote ? {
      lsRemote: () => remoteSha,
      push: ({ head }) => {
        const oldSha = remoteSha;
        remoteSha = head;
        return { oldSha, newSha: head };
      },
    } : null,
  });
}

function fakeCredentialRunner(_options, callback) {
  fs.mkdirSync(credentialTempRoot, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(credentialTempRoot, "round-"));
  const tokenFile = path.join(directory, "token");
  fs.writeFileSync(tokenFile, "offline-fixture-token\n", { mode: 0o600 });
  credentialRounds.push(directory);
  try { return callback(tokenFile); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function offlineGitRunner(args, cwd, env) {
  const mapped = [...args];
  const sourceIndex = mapped.indexOf(S6_REPOSITORY_URL);
  if (sourceIndex >= 0) mapped[sourceIndex] = source;
  const result = spawnSync("git", ["--no-pager", "-c", `safe.directory=${cwd}`, "-c", "credential.helper=", ...mapped], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (sourceIndex >= 0 && mapped[0] === "clone" && result.status === 0) {
    const configured = spawnSync("git", ["config", "remote.origin.url", S6_REPOSITORY_URL], { cwd: mapped.at(-1), env, encoding: "utf8" });
    if (configured.status !== 0) return configured;
  }
  return result;
}

function prepareSource() {
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  writeSource(".gitignore", "runtime/\n*.log\n.env\nignored.txt\n");
  writeSource("README.md", "S6 baseline\n");
  writeSource("package.json", "{\"name\":\"s6-fixture\",\"private\":true}\n");
  runGit(["init", "-q", "-b", "main"], source);
  runGit(["config", "core.hooksPath", "/dev/null"], source);
  runGit(["config", "user.name", "S6 Source"], source);
  runGit(["config", "user.email", "s6-source@example.invalid"], source);
  runGit(["add", "--", ".gitignore", "README.md", "package.json"], source);
  runGit(["commit", "-qm", "S6 source baseline"], source);
}

function commitWithReviewedHook(session, relative, content, message) {
  const workspace = session.workspacePath;
  const hostHooks = path.join(session.governanceHostRoot, "hooks");
  const hostPolicy = path.join(session.governanceHostRoot, "pre-commit-policy.mjs");
  const env = { ...gitEnv, BRIDGE_GOVERNANCE_MODE: "s6", BRIDGE_REVIEWED_HOOK_PATH: path.join(hostHooks, "pre-commit"), BRIDGE_REVIEWED_HOOKS_PATH: hostHooks, BRIDGE_REVIEWED_POLICY_PATH: hostPolicy };
  fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, relative), content, { mode: 0o600 });
  runGit(["config", "--local", "core.hooksPath", hostHooks], workspace, env);
  runGit(["add", "--", relative], workspace, env);
  const directPolicy = spawnSync(process.execPath, [hostPolicy], { cwd: workspace, env, encoding: "utf8" });
  assert.equal(directPolicy.status, 0, directPolicy.stderr || directPolicy.stdout);
  assert.match(`${directPolicy.stdout || ""}${directPolicy.stderr || ""}`, /S6 pre-commit policy passed/);
  const hookProbe = spawnSync(path.join(hostHooks, "pre-commit"), [], { cwd: workspace, env, encoding: "utf8" });
  assert.equal(hookProbe.status, 0, hookProbe.stderr || hookProbe.stdout);
  assert.match(`${hookProbe.stdout || ""}${hookProbe.stderr || ""}`, /S6 pre-commit policy passed/);
  const result = runGit(["commit", "-m", message], workspace, env);
  assert.match(result, /S6 pre-commit policy passed/);
  runGit(["config", "--local", "core.hooksPath", S6_GOVERNANCE_HOOKS_PATH], workspace, gitEnv);
  return readGit(["rev-parse", "HEAD"], workspace);
}

function commitWithNoVerify(session, relative, content, message) {
  const workspace = session.workspacePath;
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
  runGit(["add", "-f", "--", relative], workspace, gitEnv);
  runGit(["commit", "--no-verify", "-m", message], workspace, gitEnv);
  return readGit(["rev-parse", "HEAD"], workspace);
}

function writeSource(relative, content) {
  fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, relative), content, { mode: 0o600 });
}

function runGit(args, cwd, env = gitEnv) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr || result.stdout}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function readGit(args, cwd) { return runGit(args, cwd).trim(); }

function brokerRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      try { resolve(JSON.parse(response.trim())); } catch (error) { reject(error); }
    });
  });
}
