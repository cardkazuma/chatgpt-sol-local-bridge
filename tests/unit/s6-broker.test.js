import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
const credentialDelegationRounds = [];
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

test("S6 credential-time Git invocations isolate hooks, templates, and repository config", async () => {
  const isolationBase = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-s6-hook-isolation-"));
  const isolationManagerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-local-bridge-s6-hook-isolation-"));
  const workspace = path.join(isolationBase, "workspace");
  const bareRemote = path.join(isolationBase, "remote.git");
  const templateRoot = path.join(isolationBase, "template");
  const markers = {
    template: path.join(isolationBase, "template-hook-ran"),
    repository: path.join(isolationBase, "repository-hook-ran"),
    global: path.join(isolationBase, "global-hook-ran"),
    helper: path.join(isolationBase, "credential-helper-ran"),
    trustedHelper: path.join(isolationBase, "trusted-credential-helper-ran"),
    askpass: path.join(isolationBase, "repository-askpass-ran"),
  };
  const sessionId = "s6-hookproof-0123456789abcdef";
  const branch = s6BranchForSession(sessionId);
  const setupHome = path.join(isolationBase, "setup-home");
  const setupEnv = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: setupHome,
    XDG_CONFIG_HOME: path.join(setupHome, "config"),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "/usr/bin/false",
  };
  let credentialCalls = 0;
  let authServerProcess;
  try {
    fs.mkdirSync(path.join(templateRoot, "hooks"), { recursive: true, mode: 0o700 });
    writeExecutable(path.join(templateRoot, "hooks", "pre-push"), hookScript(markers.template));
    runGit(["init", "-q", `--initial-branch=${branch}`, `--template=${templateRoot}`, workspace], isolationBase, setupEnv);
    runGit(["config", "user.name", "S6 Hook Isolation"], workspace, setupEnv);
    runGit(["config", "user.email", "s6-hook-isolation@example.invalid"], workspace, setupEnv);
    fs.writeFileSync(path.join(workspace, "README.md"), "hook isolation baseline\n", { mode: 0o600 });
    runGit(["add", "--", "README.md"], workspace, setupEnv);
    runGit(["commit", "--no-verify", "-qm", "S6 hook isolation baseline"], workspace, setupEnv);
    fs.mkdirSync(path.join(workspace, ".githooks"), { recursive: true, mode: 0o700 });
    writeExecutable(path.join(workspace, ".githooks", "pre-push"), hookScript(markers.repository));
    const globalHooks = path.join(isolationBase, "global-hooks");
    fs.mkdirSync(globalHooks, { recursive: true, mode: 0o700 });
    writeExecutable(path.join(globalHooks, "pre-push"), hookScript(markers.global));
    const replacementHelper = path.join(isolationBase, "credential-helper");
    const trustedHelper = path.join(isolationBase, "trusted-credential-helper");
    const replacementAskpass = path.join(isolationBase, "repository-askpass");
    writeExecutable(replacementHelper, hookScript(markers.helper));
    writeExecutable(trustedHelper, credentialHelperScript(markers.trustedHelper));
    writeExecutable(replacementAskpass, hookScript(markers.askpass));

    runGit(["remote", "add", "origin", S6_REPOSITORY_URL], workspace, setupEnv);
    runGit(["config", "--local", "core.hooksPath", S6_GOVERNANCE_HOOKS_PATH], workspace, setupEnv);
    runGit(["config", "--local", "alias.status", `!${replacementHelper}`], workspace, setupEnv);

    const broker = new S6GitHubBroker({
      managerRoot: isolationManagerRoot,
      bridgeRoot: repo,
      sessionId,
      platform: "linux",
      credentialRunner: (options, callback) => {
        credentialCalls += 1;
        assert.equal(options.managerRoot, isolationManagerRoot);
        assert.equal(Object.keys(options).some((key) => /^GH_|^GITHUB_/.test(key)), false);
        return callback({ helperBin: trustedHelper });
      },
    });
    const emptyHooks = path.join(isolationManagerRoot, "broker-empty-hooks");
    const emptyTemplate = path.join(isolationManagerRoot, "broker-empty-template");
    assert.equal(fs.existsSync(emptyHooks), true, "broker-owned empty hook directory is required");
    assert.equal(fs.existsSync(emptyTemplate), true, "broker-owned empty template directory is required");
    assert.deepEqual(fs.readdirSync(emptyHooks), []);
    assert.deepEqual(fs.readdirSync(emptyTemplate), []);
    assert.equal(broker.gitEnvironment().HOME, path.join(isolationManagerRoot, "git-home"));
    assert.equal(broker.gitEnvironment().XDG_CONFIG_HOME, path.join(isolationManagerRoot, "git-home", "config"));
    assert.equal(broker.gitEnvironment().GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(broker.gitEnvironment().GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(broker.gitEnvironment().GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(broker.gitEnvironment().GIT_TEMPLATE_DIR, emptyTemplate);
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR"]) {
      assert.equal(key in broker.gitEnvironment(), false, `${key} leaked into broker Git`);
    }
    assert.throws(() => broker.validateWorkspaceIdentity(workspace, branch), /alias\.status/);
    assert.equal(credentialCalls, 0, "repository aliases must be rejected before credential scope");
    runGit(["config", "--local", "--unset-all", "alias.status"], workspace, setupEnv);
    runGit(["config", "--local", "filter.evil.clean", `!${replacementHelper}`], workspace, setupEnv);
    assert.throws(() => broker.validateWorkspaceIdentity(workspace, branch), /filter\.evil\.clean/);
    assert.equal(credentialCalls, 0, "repository filters must be rejected before credential scope");
    runGit(["config", "--local", "--unset-all", "filter.evil.clean"], workspace, setupEnv);

    fs.mkdirSync(path.join(isolationManagerRoot, "git-home"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(isolationManagerRoot, "git-home", ".gitconfig"), `[core]\n\thooksPath = ${globalHooks}\n[credential]\n\thelper = !${replacementHelper}\n`, { mode: 0o600 });
    runGit(["config", "--local", "credential.helper", `!${replacementHelper}`], workspace, setupEnv);
    runGit(["config", "--local", "core.askPass", replacementAskpass], workspace, setupEnv);

    const authProbeMarker = path.join(isolationBase, "authentication-probe-reached");
    authServerProcess = spawn(process.execPath, ["-e", authenticationServerSource(), authProbeMarker], { stdio: ["ignore", "pipe", "pipe"] });
    const authPort = await waitForChildPort(authServerProcess);
    runGit(["remote", "set-url", "origin", `http://127.0.0.1:${authPort}/s6.git`], workspace, setupEnv);
    const authResult = broker.withCredential(({ credentialHelper }) => broker.gitStatusWithCredential(["ls-remote", "--heads", "origin"], workspace, { credentialHelper }));
    assert.notEqual(authResult.status, 0, "local authentication probe must not succeed");
    assert.equal(fs.existsSync(authProbeMarker), false, "non-HTTPS arbitrary host was reached during credential scope");
    await stopChild(authServerProcess);
    authServerProcess = null;
    assert.equal(fs.existsSync(markers.helper), false, "repository credential helper executed during credential scope");
    assert.equal(fs.existsSync(markers.askpass), false, "repository askpass executed during credential scope");
    assert.equal(fs.existsSync(markers.trustedHelper), false, "credential helper ran for a denied protocol");
    assert.doesNotMatch(`${authResult.stdout || ""}${authResult.stderr || ""}`, /offline-trusted-helper-secret/, "credential helper output entered Git diagnostics");

    const helperResult = broker.withCredential(({ credentialHelper }) => broker.gitStatusWithCredential(
      ["credential", "reject"], workspace, { credentialHelper }, { input: "protocol=https\nhost=github.com\n\n" },
    ));
    assert.equal(helperResult.status, 0, helperResult.stderr || helperResult.stdout);
    assert.equal(fs.existsSync(markers.trustedHelper), true, "fixed trusted credential helper was not delegated to Git");
    assert.equal(fs.existsSync(markers.helper), false, "repository credential helper replaced the fixed trusted helper");
    assert.equal(fs.existsSync(markers.askpass), false, "repository askpass executed during credential delegation");
    assert.doesNotMatch(`${helperResult.stdout || ""}${helperResult.stderr || ""}`, /offline-trusted-helper-secret/, "credential helper output entered Git diagnostics");

    runGit(["init", "--bare", "-q", bareRemote], isolationBase, setupEnv);
    runGit(["remote", "set-url", "origin", bareRemote], workspace, setupEnv);
    const firstPush = broker.withCredential(({ credentialHelper }) => broker.gitStatusWithCredential(["-c", "protocol.file.allow=always", "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], workspace, { credentialHelper }));
    assert.equal(firstPush.status, 0, firstPush.stderr || firstPush.stdout);
    runGit(["config", "--local", "--unset-all", "core.hooksPath"], workspace, setupEnv);
    fs.appendFileSync(path.join(workspace, "README.md"), "second push\n");
    runGit(["add", "--", "README.md"], workspace, setupEnv);
    runGit(["commit", "--no-verify", "-qm", "S6 hook isolation second push"], workspace, setupEnv);
    const secondPush = broker.withCredential(({ credentialHelper }) => broker.gitStatusWithCredential(["-c", "protocol.file.allow=always", "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], workspace, { credentialHelper }));
    assert.equal(secondPush.status, 0, secondPush.stderr || secondPush.stdout);
    for (const marker of [markers.repository, markers.template, markers.global]) {
      assert.equal(fs.existsSync(marker), false, `untrusted hook executed during credential scope: ${path.basename(marker)}`);
    }
    assert.equal(fs.existsSync(path.join(isolationManagerRoot, "credential-tmp")), false, "credential material directory was created");
  } finally {
    await stopChild(authServerProcess);
    fs.rmSync(isolationBase, { recursive: true, force: true });
    fs.rmSync(isolationManagerRoot, { recursive: true, force: true });
  }
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
  assert.equal(credentialDelegationRounds.length, 1);
  assert.equal(fs.existsSync(path.join(managerRoot, "credential-tmp")), false);
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
  broker.writePublishedState(first, session.expectedBaseCommit, "publishing");
  assert.deepEqual(broker.recoverPublish(), { recovered: true, state: "published", commit: first });

  runGit(["config", "--local", "--add", "remote.origin.url", "https://github.com/other/repo.git"], session.workspacePath, gitEnv);
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /single fixed canonical URL/);
  runGit(["config", "--local", "--unset-all", "remote.origin.url"], session.workspacePath, gitEnv);
  runGit(["config", "--local", "remote.origin.url", S6_REPOSITORY_URL], session.workspacePath, gitEnv);

  runGit(["switch", "--no-guess", "main"], session.workspacePath, gitEnv);
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /not attached to the generated branch/);
  runGit(["switch", "--no-guess", session.branch], session.workspacePath, gitEnv);

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

  runGit(["reset", "--hard", session.expectedBaseCommit], session.workspacePath, gitEnv);
  const diverged = commitWithReviewedHook(session, "diverged.txt", "non-fast-forward\n", "S6 non-fast-forward candidate");
  assert.ok(broker.attestCommit(diverged).attested);
  await assert.rejects(() => broker.publishBranch(), /not a fast-forward/);
  runGit(["reset", "--hard", first], session.workspacePath, gitEnv);

  fs.symlinkSync("README.md", path.join(session.workspacePath, "symlink.txt"));
  runGit(["add", "--", "symlink.txt"], session.workspacePath, gitEnv);
  runGit(["commit", "--no-verify", "-m", "symlink candidate"], session.workspacePath, gitEnv);
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /symlink tree entry/);
  runGit(["reset", "--hard", first], session.workspacePath, gitEnv);

  fs.mkdirSync(path.join(session.workspacePath, "runtime"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(session.workspacePath, "runtime", "secret.log"), "ignored\n", { mode: 0o600 });
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /clean worktree.*ignored/);
  fs.rmSync(path.join(session.workspacePath, "runtime"), { recursive: true, force: true });

  const workflow = commitWithReviewedHook(session, ".github/workflows/not-approved.yml", "name: not approved\n", "S6 workflow candidate");
  assert.match(workflow, /^[0-9a-f]{40}$/);
  assert.throws(() => broker.attestCommit(workflow), /fail-closed governance or automation path/);
  await assert.rejects(() => broker.publishBranch(), /every unpublished commit.*attestation|fail-closed governance/);

  runGit(["reset", "--hard", first], session.workspacePath, gitEnv);
  const modules = commitWithNoVerify(session, ".gitmodules", "[submodule \"untrusted\"]\n\tpath = untrusted\n\turl = https://example.invalid/untrusted.git\n", "S6 gitmodules candidate");
  assert.match(modules, /^[0-9a-f]{40}$/);
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /fail-closed governance or automation path/);
  runGit(["reset", "--hard", first], session.workspacePath, gitEnv);
  const nested = path.join(session.workspacePath, "untrusted-submodule");
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  runGit(["init", "-q", "-b", "main"], nested, gitEnv);
  runGit(["config", "core.hooksPath", "/dev/null"], nested, gitEnv);
  runGit(["config", "user.name", "Untrusted Submodule"], nested, gitEnv);
  runGit(["config", "user.email", "untrusted-submodule@example.invalid"], nested, gitEnv);
  fs.writeFileSync(path.join(nested, "README.md"), "untrusted nested fixture\n", { mode: 0o600 });
  runGit(["add", "--", "README.md"], nested, gitEnv);
  runGit(["commit", "--no-verify", "-qm", "nested fixture"], nested, gitEnv);
  const nestedHead = readGit(["rev-parse", "HEAD"], nested);
  runGit(["update-index", "--add", "--cacheinfo", `160000,${nestedHead},untrusted-submodule`], session.workspacePath, gitEnv);
  runGit(["commit", "--no-verify", "-m", "S6 submodule candidate"], session.workspacePath, gitEnv);
  assert.throws(() => broker.validateLocalPublishState({ requireAttestations: false }), /submodule tree entry/);
  runGit(["reset", "--hard", first], session.workspacePath, gitEnv);

  manager.destroy(session.sessionId);
  assert.equal(fs.existsSync(path.join(managerRoot, "manager-state", `${session.sessionId}.published.json`)), false);

  const collision = manager.create();
  const collisionBroker = makeBroker(collision.sessionId, true);
  remoteSha = "c".repeat(40);
  const collisionCommit = commitWithReviewedHook(collision, "README.md", "S6 collision\n", "S6 unowned branch collision");
  assert.ok(collisionBroker.attestCommit(collisionCommit).attested);
  await assert.rejects(() => collisionBroker.publishBranch(), /branch already exists/);
  manager.destroy(collision.sessionId);
  remoteSha = null;
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

test("S6 failure diagnostics redact synthetic credential material", () => {
  const session = "s6-redaction-0123456789abcdef";
  const redactionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-local-bridge-s6-redaction-"));
  try {
    const broker = new S6GitHubBroker({
      managerRoot: redactionRoot,
      bridgeRoot: repo,
      sessionId: session,
      platform: "linux",
      gitRunner: () => ({ status: 128, stdout: "", stderr: "fatal: password=offline-helper-secret" }),
    });
    assert.throws(() => broker.gitResult(["ls-remote", "origin"], redactionRoot), (error) => {
      assert.match(error.message, /<redacted>/);
      assert.doesNotMatch(error.message, /offline-helper-secret/);
      return true;
    });
  } finally {
    fs.rmSync(redactionRoot, { recursive: true, force: true });
  }
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
  credentialDelegationRounds.push(Date.now());
  return callback({ helperBin: "/usr/bin/false" });
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

function writeExecutable(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o700 });
  fs.chmodSync(target, 0o700);
}

function hookScript(marker) {
  return `#!/bin/sh\nset -eu\nprintf '%s\\n' "credential-visible=\${S6_GITHUB_TOKEN_FILE:+yes}" > ${shellQuote(marker)}\n`;
}

function credentialHelperScript(marker) {
  return `#!/bin/sh\nset -eu\nprintf '%s\\n' delegated > ${shellQuote(marker)}\nif [ "\${1-}" = get ]; then\n  printf '%s\\n' 'username=offline-user' 'password=offline-trusted-helper-secret' ''\nfi\n`;
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

function authenticationServerSource() {
  return [
    'const fs=require("node:fs");',
    'const http=require("node:http");',
    'const marker=process.argv[1];',
    'const server=http.createServer((_request,response)=>{fs.writeFileSync(marker,"reached\\n",{mode:0o600});response.writeHead(401,{"WWW-Authenticate":"Basic realm=s6","Content-Length":"0",Connection:"close"});response.end();});',
    'server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)+"\\n"));',
    'process.on("SIGTERM",()=>server.close(()=>process.exit(0)));',
  ].join("");
}

function waitForChildPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => finish(new Error("local authentication probe did not become ready")), 5_000);
    const finish = (error, port) => {
      clearTimeout(timeout);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("exit");
      if (error) reject(error); else resolve(port);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/^([0-9]+)\r?\n/);
      if (!match) return;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) finish(new Error("local authentication probe returned an invalid port"));
      else finish(null, port);
    });
    child.stderr?.on("data", (chunk) => { errors += chunk; });
    child.once("exit", (code) => finish(new Error(`local authentication probe exited before readiness (${code ?? "unknown"}): ${errors.trim()}`)));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    }, 2_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timeout); resolve(); }
  });
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
