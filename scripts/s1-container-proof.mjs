#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/server.js";
import { EXPECTED_TOOL_NAMES } from "../src/tool-contract.js";

const root = "/workspace/repo";
const outside = process.env.S1_HOST_OUTSIDE_PATH || "/not-mounted/outside-secret.txt";
const outsideWrite = process.env.S1_HOST_OUTSIDE_WRITE || "/not-mounted/outside-write.txt";
const fakeHome = process.env.S1_HOST_HOME_SENTINEL || "/not-mounted/host-home";
const checks = [];
const runtime = startHttpServer({ host: "127.0.0.1", port: 0 });
if (!runtime.httpServer.listening) await once(runtime.httpServer, "listening");
const port = runtime.httpServer.address().port;
const client = new Client({ name: "s1-container-proof", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

try {
  await client.connect(transport);
  await check("catalog", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert(JSON.stringify(names) === JSON.stringify(EXPECTED_TOOL_NAMES), "MCP discovery did not match the reviewed S1 catalog");
    for (const disabled of ["shell", "git_run", "codex_run", "workspace_add_root", "confirm_destructive", "web_fetch", "office", "system_info", "dom_cdp"]) {
      assert(!names.includes(disabled), `${disabled} was discoverable`);
    }
  });

  await check("workspace-open", async () => {
    await expectOk("workspace_open", { path: root });
  });

  await check("structured-allowed-file-operations", async () => {
    await expectOk("read_file", { path: path.join(root, "README.md") });
    await expectOk("write_file", { path: path.join(root, "allowed.txt"), content: "one\n" });
    await expectOk("read_file", { path: path.join(root, "allowed.txt") });
    await expectOk("write_file", { path: path.join(root, "allowed.txt"), content: "two\n" });
    await expectOk("edit_file", { path: path.join(root, "allowed.txt"), oldText: "two", newText: "edited" });
    const read = JSON.parse(await expectOk("read_file", { path: path.join(root, "allowed.txt") }));
    assert(read.content === "edited\n", "non-empty overwrite/edit did not persist");
  });

  await check("structured-patch-and-search", async () => {
    const diff = "diff --git a/patched.txt b/patched.txt\nnew file mode 100644\n--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1 @@\n+patched\n";
    await expectOk("apply_patch", { cwd: root, diff });
    const result = await expectOk("search_text", { path: root, pattern: "edited|patched" });
    assert(result.includes("edited") && result.includes("patched"), "search did not find allowed repository text");
    await expectError("apply_patch", {
      cwd: root,
      diff: "diff --git a/../../outside.txt b/../../outside.txt\n--- a/../../outside.txt\n+++ b/../../outside.txt\n@@ -0,0 +1 @@\n+escape\n",
    }, /escapes|workspace-relative/);
  });

  await check("structured-secret-and-ignored-denial", async () => {
    for (const name of [".env", "db.env", "secrets.yaml", ".storage/token", "fixture.log", "backups/secret.txt", "ignored.txt"]) {
      await expectError("read_file", { path: path.join(root, name) }, /secret-sensitive|repository-ignored/);
    }
    const directory = JSON.parse(await expectOk("read_file", { path: root }));
    for (const name of [".env", "fixture.log", "ignored.txt", "backups"]) {
      assert(!directory.entries.some((entry) => entry.name === name), `${name} was listed by read_file`);
    }
    const tree = await expectOk("workspace_tree", { path: root, maxDepth: 5 });
    assert(!/\.env|fixture\.log|ignored\.txt|backups/.test(tree), "workspace_tree exposed a denied path");
    const search = await expectOk("search_text", { path: root, pattern: "DISPOSABLE_SECRET" });
    assert(!/fixture\.log|\.env|backup/.test(search), "search exposed a denied path");
  });

  await check("structured-outside-and-symlink-denial", async () => {
    await expectError("read_file", { path: outside }, /outside registered workspace roots/);
    await expectError("write_file", { path: outsideWrite, content: "must-not-write" }, /outside registered workspace roots/);
    await expectError("read_file", { path: path.join(root, "escape-system") }, /outside registered workspace roots/);
    await expectError("read_file", { path: path.join(root, "escape-host") }, /ENOENT|outside registered workspace roots/);
    await expectError("write_file", { path: path.join(root, "escape-system"), content: "must-not-write" }, /outside registered workspace roots/);
    await expectError("read_file", { path: path.join(root, ".git", "config") }, /secret-sensitive|protected/);
  });

  await check("project-test-lint-typecheck-build", async () => {
    for (const name of ["test", "lint", "typecheck", "build"]) {
      const result = JSON.parse(await expectOk(`project_${name}`, { cwd: root }));
      assert(result.ok === true, `project_${name} failed: ${result.stderr || result.stdout}`);
    }
    assert(fs.existsSync(path.join(root, "build-output.txt")), "project_build did not create its bounded output");
  });

  await check("git-local-structured-writes", async () => {
    await expectOk("git_status", { cwd: root });
    await expectOk("git_diff", { cwd: root });
    await expectOk("git_log", { cwd: root, limit: 5 });
    await expectOk("git_branch_create", { cwd: root, name: "s1/isolated" });
    await expectOk("git_branch_switch", { cwd: root, name: "s1/isolated" });
    await expectOk("git_stage", { cwd: root, paths: ["allowed.txt", "patched.txt"] });
    const commit = await expectOk("git_commit", { cwd: root, message: "S1 disposable proof commit" });
    assert(commit.includes("S1 pre-commit policy passed"), "reviewed pre-commit hook did not run");
    await expectOk("git_diff", { cwd: root, staged: true });
    await expectOk("git_log", { cwd: root, limit: 5 });
    await expectError("git_stage", { cwd: root, paths: ["../outside/secret.txt"] }, /literal workspace-relative|may not contain/);
    await expectError("git_stage", { cwd: root, paths: [".git/config"] }, /secret-sensitive|protected/);
    await expectUnknown("git_run");
  });

  await check("immutable-git-governance-mounts", async () => {
    const configAttempt = await repoShell("git config core.hooksPath /tmp/bypass-hooks");
    assert(configAttempt.ok === false, "repo_shell changed core.hooksPath");
    const remoteAttempt = await repoShell("git remote add bypass https://example.invalid/bypass.git");
    assert(remoteAttempt.ok === false, "repo_shell changed Git remotes");
    const hookAttempt = await repoShell("printf bypass > /workspace/repo/.githooks/pre-commit");
    assert(hookAttempt.ok === false, "repo_shell changed the immutable reviewed hook");
    const policyAttempt = await repoShell("printf bypass > /workspace/repo/scripts/pre-commit-policy.mjs");
    assert(policyAttempt.ok === false, "repo_shell changed the immutable policy helper");
    const config = await repoShell("test \"$(git -c safe.directory=/workspace/repo config --local --get core.hooksPath)\" = .githooks");
    assert(config.ok === true, "core.hooksPath was not retained");
    const remotes = await repoShell("test -z \"$(git -c safe.directory=/workspace/repo remote)\"");
    assert(remotes.ok === true, "a remote was added");
  });

  await check("contained-process-supervisor", async () => {
    const started = JSON.parse(await expectOk("process_start", {
      cwd: root,
      command: "node -e 'console.log(\"ready\"); setInterval(()=>{}, 1000)'",
    }));
    let logs = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(50);
      logs = await expectOk("process_logs", { id: started.id, lines: 20 });
      if (logs.includes("ready")) break;
    }
    assert(logs.includes("ready"), "managed process output was not captured");
    await expectOk("process_stop", { id: started.id });
    await expectOk("process_list", {});
  });

  await check("container-identity-and-boundary", async () => {
    const uid = await repoShell("test \"$(id -u)\" = 10001");
    assert(uid.ok, "bridge process is not running as uid 10001");
    const caps = await repoShell("grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status");
    assert(caps.ok, "effective capabilities were not empty");
    const nnp = await repoShell("grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status");
    assert(nnp.ok, "no-new-privileges was not enabled");
    const rootWrite = await repoShell("touch /opt/bridge/s1-root-write 2>/dev/null");
    assert(!rootWrite.ok && !fs.existsSync("/opt/bridge/s1-root-write"), "read-only container root was writable");
    const noSocket = await repoShell("test ! -S /var/run/docker.sock");
    assert(noSocket.ok, "Docker socket was visible");
    const noPaths = await repoShell("for p in /Volumes /volume1/docker; do test ! -e \"$p\" || exit 1; done");
    assert(noPaths.ok, "NAS or /Volumes path was visible");
    const noCredEnv = await repoShell("if env | grep -E 'CONTROL_PLANE|GITHUB|CODEX|OPENAI_API_KEY|ANTHROPIC_API_KEY|SSH_AUTH_SOCK'; then exit 1; fi");
    assert(noCredEnv.ok, "credential-bearing environment variables were visible");
    const stateMutation = await repoShell("printf '{\"version\":1,\"extraRoots\":[\"/\"]}' > /state/state.json");
    assert(stateMutation.ok, "could not exercise disposable state mutation");
    await expectError("workspace_open", { path: "/state" }, /outside registered workspace roots/);
    await expectOk("workspace_open", { path: root });
    for (const credentialPath of [
      path.join(fakeHome, ".ssh", "id_ed25519"),
      path.join(fakeHome, ".config", "gh", "hosts.yml"),
      path.join(fakeHome, ".codex", "config.toml"),
    ]) {
      const result = await repoShell(`cat ${quote(credentialPath)}`);
      assert(!result.ok, `host credential sentinel was readable: ${credentialPath}`);
    }
    const hostSymlinkAttempt = await repoShell("cat /workspace/repo/escape-host");
    assert(!hostSymlinkAttempt.ok, "a workspace symlink reached an unmounted host path");
    const normalHome = process.env.S1_NORMAL_HOME || "/Users/not-mounted";
    const homeAttempt = await repoShell(`test ! -e ${quote(path.join(normalHome, ".ssh"))}`);
    assert(homeAttempt.ok, "normal user's home path was visible");
  });

  await check("network-egress-denial", async () => {
    const result = await repoShell("node -e 'const net=require(\"node:net\");const s=net.connect({host:\"1.1.1.1\",port:80});s.setTimeout(750);s.on(\"connect\",()=>process.exit(1));s.on(\"timeout\",()=>{s.destroy();process.exit(0)});s.on(\"error\",()=>process.exit(0));'");
    assert(result.ok, `network egress was available: ${result.stderr || result.stdout}`);
  });

  await check("confined-damage-recovery", async () => {
    const damage = path.join(root, "damage.txt");
    await expectOk("write_file", { path: damage, content: "disposable damage\n" });
    const damaged = await repoShell("rm -f /workspace/repo/damage.txt");
    assert(damaged.ok, "repo_shell was unexpectedly command-filtered");
    assert(!fs.existsSync(damage), "disposable damage file was not removed");
    await expectOk("write_file", { path: damage, content: "recreated safely\n" });
    const recovered = JSON.parse(await expectOk("read_file", { path: damage }));
    assert(recovered.content === "recreated safely\n", "workspace recreation failed");
    assert(!fs.existsSync(outside), "outside sentinel path was unexpectedly mounted");
    assert(!fs.existsSync(outsideWrite), "outside write sentinel was created");
  });
} finally {
  await client.close().catch(() => {});
  await runtime.shutdown("s1-proof");
}

const failed = checks.filter((item) => !item.pass);
console.log(JSON.stringify({ proof: "s1-container", passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
if (failed.length) process.exitCode = 1;

async function check(id, fn) {
  try {
    await fn();
    checks.push({ id, pass: true });
  } catch (error) {
    checks.push({ id, pass: false, detail: String(error.message || error) });
  }
}

async function expectOk(name, args) {
  const result = await call(name, args);
  const text = textOf(result);
  assert(!result.isError, `${name} failed: ${text}`);
  return text;
}

async function expectError(name, args, pattern) {
  const result = await call(name, args);
  const text = textOf(result);
  assert(result.isError, `${name} unexpectedly succeeded: ${text}`);
  assert(pattern.test(text), `${name} error did not match ${pattern}: ${text}`);
  return text;
}

async function expectUnknown(name) {
  try {
    const result = await call(name, {});
    assert(result.isError, `${name} unexpectedly succeeded`);
  } catch (error) {
    assert(/not found|unknown tool|invalid/i.test(String(error.message)), `${name} error was unexpected: ${error.message}`);
  }
}

async function repoShell(command) {
  const text = await expectOk("repo_shell", { cwd: root, command });
  return JSON.parse(text);
}

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

function textOf(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
