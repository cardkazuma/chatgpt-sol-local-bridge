import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "host-publish-integration-"));
const source = path.join(base, "source");
const remote = path.join(base, "remote.git");
const decoy = path.join(base, "decoy.git");
fs.mkdirSync(source);
const runGit = (args, cwd = source) => spawnSync("git", args, { cwd, encoding: "utf8" });
const git = (args, cwd = source) => {
  const result = runGit(args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "Publish Integration"]);
git(["config", "user.email", "publish@example.invalid"]);
fs.writeFileSync(path.join(source, "README.md"), "baseline\n");
fs.mkdirSync(path.join(source, ".githooks"));
fs.writeFileSync(path.join(source, ".githooks", "pre-commit"), "#!/bin/sh\nprintf hook-pass\n", { mode: 0o700 });
git(["config", "core.hooksPath", ".githooks"]);
git(["add", "."]);
git(["commit", "-qm", "baseline"]);
git(["init", "-q", "--bare", remote]);
git(["init", "-q", "--bare", decoy]);
git(["remote", "add", "origin", remote]);
git(["push", "-q", "origin", "main"]);

process.env.BRIDGE_PROFILE = "host";
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.HOST_WORKTREE_ROOT = path.join(base, "managed-worktrees");
process.env.INCLUDE_SCRATCH_ROOT = "false";
process.env.MCP_TOKEN = "host-publish-token";
process.env.HOST = "127.0.0.1";
const { startHttpServer } = await import("../../src/server.js");

let runtime;
let client;
async function connect() {
  runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
  if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
  client = new Client({ name: "host-publish-integration", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.httpServer.address().port}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer host-publish-token" } },
  }));
}
async function call(name, args) { return client.callTool({ name, arguments: args }); }
function value(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result.content[0].text;
}
function remoteHead(branch, repository = remote) {
  return git(["--git-dir", repository, "rev-parse", `refs/heads/${branch}`]);
}
function createRemoteBranch(branch, { local = true, worktree = false } = {}) {
  const head = git(["rev-parse", "main"]);
  git(["branch", branch, head]);
  git(["push", "-q", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
  let worktreePath = null;
  if (worktree) {
    worktreePath = path.join(base, branch.replaceAll("/", "-"));
    git(["worktree", "add", "-q", worktreePath, branch]);
  } else if (!local) {
    git(["branch", "-D", branch]);
  }
  return { head, worktreePath };
}
async function attachBranch(branch, expectedHead) {
  return JSON.parse(value(await call("workspace_attach", {
    repositoryPath: source, branch, expectedHead, remote: "origin", objective: `publish ${branch}`,
  })));
}
async function commitFile(workspaceId, worktreePath, name, content, message) {
  value(await call("write_file", { workspaceId, path: name, content }));
  value(await call("git_stage", { workspaceId, paths: [name] }));
  assert.match(value(await call("git_commit", { workspaceId, message })), /hook-pass/);
  return git(["rev-parse", "HEAD"], worktreePath);
}

test("host attached-branch publisher advances the same existing branch for two commit cycles", async () => {
  await connect();
  const tools = await client.listTools();
  const publisher = tools.tools.find(({ name }) => name === "git_publish_attached_branch");
  assert.deepEqual(Object.keys(publisher.inputSchema.properties), ["workspaceId"]);
  assert.equal(publisher.inputSchema.additionalProperties, false);
  const branch = "review/local-publish";
  const initial = createRemoteBranch(branch, { worktree: true });
  const attached = await attachBranch(branch, initial.head);
  assert.equal(attached.worktreePath, fs.realpathSync.native(initial.worktreePath));

  const firstHead = await commitFile(attached.id, attached.worktreePath, "first.txt", "first\n", "first correction");
  const first = JSON.parse(value(await call("git_publish_attached_branch", { workspaceId: attached.id })));
  assert.equal(first.previousRemoteHead, initial.head);
  assert.equal(first.publishedHead, firstHead);
  assert.equal(remoteHead(branch), firstHead);

  const secondHead = await commitFile(attached.id, attached.worktreePath, "second.txt", "second\n", "second correction");
  const second = JSON.parse(value(await call("git_publish_attached_branch", { workspaceId: attached.id })));
  assert.equal(second.previousRemoteHead, firstHead);
  assert.equal(second.publishedHead, secondHead);
  assert.equal(remoteHead(branch), secondHead);
  const status = JSON.parse(value(await call("workspace_status", { workspaceId: attached.id })));
  assert.equal(status.expectedHead, secondHead);
  assert.equal(status.remoteHead, secondHead);
  assert.deepEqual(git(["--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads"]).split("\n").sort(), [
    "refs/heads/main", `refs/heads/${branch}`,
  ].sort());
});

test("host attached-branch publisher refuses remote movement without overwriting it", async () => {
  const branch = "review/stale-remote";
  const initial = createRemoteBranch(branch, { local: false });
  const attached = await attachBranch(branch, initial.head);
  await commitFile(attached.id, attached.worktreePath, "local.txt", "local\n", "local correction");

  const competitor = path.join(base, "competitor");
  git(["clone", "-q", "--branch", branch, remote, competitor]);
  git(["config", "user.name", "Competing Writer"], competitor);
  git(["config", "user.email", "competitor@example.invalid"], competitor);
  fs.writeFileSync(path.join(competitor, "remote.txt"), "remote moved\n");
  git(["add", "remote.txt"], competitor);
  git(["commit", "-qm", "competing remote correction"], competitor);
  git(["push", "-q", "origin", branch], competitor);
  const competingHead = git(["rev-parse", "HEAD"], competitor);

  const refused = await call("git_publish_attached_branch", { workspaceId: attached.id });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /remote head moved/i);
  assert.equal(remoteHead(branch), competingHead);
});

test("host attached-branch publisher cannot be redirected by caller input or changed remote configuration", async () => {
  const branch = "review/no-redirect";
  const initial = createRemoteBranch(branch, { worktree: true });
  const attached = await attachBranch(branch, initial.head);
  await commitFile(attached.id, attached.worktreePath, "redirect.txt", "bounded\n", "bounded correction");

  const extraAuthority = await call("git_publish_attached_branch", {
    workspaceId: attached.id, branch: "main", remote: decoy, refspec: "HEAD:refs/heads/competing", force: true,
  });
  assert.equal(extraAuthority.isError, true);
  assert.equal(remoteHead(branch), initial.head);
  assert.equal(runGit(["--git-dir", decoy, "show-ref"], source).status, 1);

  const otherBranch = "review/no-redirect-other";
  git(["branch", otherBranch, initial.head]);
  git(["switch", "-q", otherBranch], attached.worktreePath);
  const changedBranch = await call("git_publish_attached_branch", { workspaceId: attached.id });
  assert.equal(changedBranch.isError, true);
  assert.match(changedBranch.content[0].text, /branch changed/i);
  assert.equal(remoteHead(branch), initial.head);
  git(["switch", "-q", branch], attached.worktreePath);

  git(["remote", "set-url", "--push", "origin", decoy]);
  const changedRemote = await call("git_publish_attached_branch", { workspaceId: attached.id });
  git(["remote", "set-url", "--push", "origin", remote]);
  assert.equal(changedRemote.isError, true);
  assert.match(changedRemote.content[0].text, /remote identity changed/i);
  assert.equal(remoteHead(branch), initial.head);
  assert.equal(runGit(["--git-dir", decoy, "show-ref"], source).status, 1);
});

test("host branch attachment refuses a remote with different fetch and push routing", async () => {
  const branch = "review/split-remote";
  const initial = createRemoteBranch(branch, { local: false });
  git(["remote", "set-url", "--push", "origin", decoy]);
  const refused = await call("workspace_attach", {
    repositoryPath: source, branch, expectedHead: initial.head, remote: "origin", objective: "ambiguous remote",
  });
  git(["remote", "set-url", "--push", "origin", remote]);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /fetch.*push.*routing/i);
  assert.equal(remoteHead(branch), initial.head);
  assert.equal(runGit(["--git-dir", decoy, "show-ref"], source).status, 1);
});

test("host attached-branch publisher publishes a detached remote-only attachment to its recorded branch", async () => {
  const branch = "review/detached-publish";
  const initial = createRemoteBranch(branch, { local: false });
  const attached = await attachBranch(branch, initial.head);
  assert.equal(attached.kind, "remote-branch");
  assert.equal(git(["branch", "--show-current"], attached.worktreePath), "");
  const publishedHead = await commitFile(attached.id, attached.worktreePath, "detached.txt", "detached\n", "detached correction");

  const result = JSON.parse(value(await call("git_publish_attached_branch", { workspaceId: attached.id })));
  assert.equal(result.branch, branch);
  assert.equal(result.publishedHead, publishedHead);
  assert.equal(remoteHead(branch), publishedHead);
  assert.notEqual(runGit(["show-ref", "--verify", `refs/heads/${branch}`], source).status, 0);
});

test("host attached-branch publisher denies plain, ordinary Git, and unbound local-branch workspaces", async () => {
  const ordinary = path.join(base, "ordinary");
  fs.mkdirSync(ordinary);
  const plain = JSON.parse(value(await call("workspace_attach", { path: ordinary, objective: "plain" })));
  const repository = JSON.parse(value(await call("workspace_attach", { path: source, objective: "ordinary Git" })));
  const branch = "review/unbound";
  const initial = createRemoteBranch(branch, { worktree: true });
  const localBranch = JSON.parse(value(await call("workspace_attach", {
    repositoryPath: source, branch, expectedHead: initial.head, objective: "no reviewed remote binding",
  })));

  for (const workspaceId of [plain.id, repository.id, localBranch.id]) {
    const denied = await call("git_publish_attached_branch", { workspaceId });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /publish binding/i);
  }
  assert.equal(remoteHead(branch), initial.head);
});

test.after(async () => {
  await client?.close().catch(() => {});
  await runtime?.shutdown("test");
  fs.rmSync(base, { recursive: true, force: true });
});
