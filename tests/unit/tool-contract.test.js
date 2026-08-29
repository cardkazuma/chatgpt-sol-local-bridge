import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_TOOL_NAMES, TOOL_CATALOG, parseEnabledTools } from "../../src/tool-contract.js";

const REQUIRED_S1 = [
  "bridge_instructions",
  "workspace_list", "workspace_open", "workspace_tree", "workspace_snapshot",
  "read_file", "search_text", "write_file", "apply_patch", "edit_file",
  "git_status", "git_diff", "git_log", "git_branch_create", "git_branch_switch", "git_stage", "git_commit",
  "project_test", "project_lint", "project_typecheck", "project_build",
  "repo_shell",
  "process_start", "process_list", "process_logs", "process_stop",
  "health",
];

const DISABLED_UPSTREAM = [
  "accessibility", "audio", "clipboard", "codex_run", "confirm_destructive", "dom_cdp", "file_dialog",
  "git_run", "input_event", "notification", "office", "pending_destructive", "penpot_status", "project_dev",
  "scheduler", "screen_record", "shell", "system_info", "vision", "web_fetch", "window", "workspace_add_root",
];

test("the reviewed S1 catalog is exact and unique", () => {
  assert.deepEqual([...EXPECTED_TOOL_NAMES], REQUIRED_S1);
  assert.equal(new Set(EXPECTED_TOOL_NAMES).size, EXPECTED_TOOL_NAMES.length);
  assert.deepEqual(TOOL_CATALOG.map(({ name }) => name), REQUIRED_S1);
  assert.equal(REQUIRED_S1.some((name) => DISABLED_UPSTREAM.includes(name)), false);
});

test("ENABLED_TOOLS can only reduce the reviewed catalog", () => {
  assert.deepEqual([...parseEnabledTools("health,read_file")], ["health", "read_file"]);
  assert.throws(() => parseEnabledTools("health,shell"), /unsupported or disabled/);
  assert.throws(() => parseEnabledTools("health,health"), /duplicate/);
  assert.throws(() => parseEnabledTools(""), /at least one/);
  assert.deepEqual([...parseEnabledTools(undefined)], REQUIRED_S1);
});
