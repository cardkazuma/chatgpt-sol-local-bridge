import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("host profile has a versioned truthful catalog while legacy remains exact", async () => {
  const contract = await import("../../src/tool-contract.js");
  assert.equal(typeof contract.toolCatalogForProfile, "function");
  assert.deepEqual(contract.toolCatalogForProfile("legacy").map(({ name }) => name), [...contract.EXPECTED_TOOL_NAMES]);
  const host = contract.toolCatalogForProfile("host");
  assert.equal(contract.catalogVersionForProfile("host"), "daily-use-v1");
  assert.equal(host.some(({ name }) => name === "git_publish_branch"), false);
  assert.equal(host.some(({ name }) => name === "workspace_create"), true);
  assert.equal(host.find(({ name }) => name === "repo_shell")?.mutating, true);
  assert.throws(() => contract.toolCatalogForProfile("unknown"), /profile/i);
});

test("host child environment keeps developer authentication plumbing but strips Bridge credentials", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-host-env-"));
  const script = [
    "process.env.BRIDGE_PROFILE='host'",
    "process.env.SSH_AUTH_SOCK='/tmp/agent.sock'",
    "process.env.MCP_TOKEN='bridge-secret'",
    "process.env.CONTROL_PLANE_API_KEY='tunnel-secret'",
    "const {toolEnvironment}=await import('./src/lib/exec.js')",
    "const value=toolEnvironment()",
    "console.log(JSON.stringify({home:value.HOME,path:value.PATH,ssh:value.SSH_AUTH_SOCK,mcp:value.MCP_TOKEN,tunnel:value.CONTROL_PLANE_API_KEY}))",
  ].join(";");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: base },
  });
  fs.rmSync(base, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.ok(value.home);
  assert.ok(value.path);
  assert.equal(value.ssh, "/tmp/agent.sock");
  assert.equal(value.mcp, undefined);
  assert.equal(value.tunnel, undefined);
});

test("host public instructions disclose normal-user authority and non-exclusive coordination", () => {
  const script = [
    "process.env.BRIDGE_PROFILE='host'",
    "process.env.BRIDGE_STATE_DIR=process.env.TMPDIR+'/state'",
    "process.env.HOST_WORKTREE_ROOT=process.env.TMPDIR+'/worktrees'",
    "const tools=new Map()",
    "const server={registerTool:(n,d,h)=>tools.set(n,{d,h})}",
    "const {registerPolicy}=await import('./src/tools/policy.js')",
    "const {registerProcess}=await import('./src/tools/process.js')",
    "registerPolicy(server);registerProcess(server)",
    "const result=await tools.get('bridge_instructions').h({})",
    "console.log(JSON.stringify({text:result.content[0].text,shell:tools.get('repo_shell').d}))",
  ].join(";");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-host-policy-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."), encoding: "utf8", env: { ...process.env, TMPDIR: base },
  });
  fs.rmSync(base, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.match(value.text, /normal logged-in Mac user/);
  assert.match(value.text, /non-exclusive/);
  assert.match(value.text, /workspace ID/);
  assert.equal(value.shell.annotations.readOnlyHint, false);
  assert.match(value.shell.description, /normal-user host/);
});
