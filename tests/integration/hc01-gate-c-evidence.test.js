import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerHC01GateCEvidence } from "../../src/tools/hc01-gate-c-evidence.js";

test("the collector is absent from the legacy profile", () => {
  const tools = new Map();
  const registered = registerHC01GateCEvidence({ registerTool: (name, definition, handler) => tools.set(name, { definition, handler }) });
  assert.equal(registered, false);
  assert.equal(tools.size, 0);
});
test("the host profile registers one context-free strict empty-input read-only operation", () => {
  const script = [
    "process.env.BRIDGE_PROFILE='host'",
    "process.env.BRIDGE_STATE_DIR='/private/tmp/hc01-bridge-integration-state'",
    "const tools=new Map()",
    "const server={registerTool:(name,definition,handler)=>tools.set(name,{definition,handler})}",
    "const {registerHC01GateCEvidence}=await import('./src/tools/hc01-gate-c-evidence.js')",
    "const registered=registerHC01GateCEvidence(server)",
    "const tool=tools.get('collect_hc01_gate_c_readonly_evidence')",
    "const empty=tool.definition.inputSchema.safeParse({}).success",
    "const extra=tool.definition.inputSchema.safeParse({workspaceId:'ws_0123456789abcdef'}).success",
    "const result=await tool.handler({})",
    "const hostile=await tool.handler({workspaceId:'ws_0123456789abcdef',path:'/private/key',command:'cat'})",
    "console.log(JSON.stringify({registered,count:tools.size,empty,extra,readOnly:tool.definition.annotations.readOnlyHint,workspace:tool.definition.inputSchema.safeParse({workspaceId:'ws_0123456789abcdef'}).success,result:result.content[0].text,hostile:hostile.content[0].text}))",
  ].join(";");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, BRIDGE_PROFILE: "host", BRIDGE_STATE_DIR: "/private/tmp/hc01-bridge-integration-state" } });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  assert.equal(value.registered, true);
  assert.equal(value.count, 1);
  assert.equal(value.empty, true);
  assert.equal(value.extra, false);
  assert.equal(value.workspace, false);
  assert.equal(value.readOnly, true);
  assert.equal(value.result, "HC01_GATE_C_READONLY_EVIDENCE_REFUSED");
  assert.equal(value.hostile, "HC01_GATE_C_READONLY_EVIDENCE_REFUSED");
});
