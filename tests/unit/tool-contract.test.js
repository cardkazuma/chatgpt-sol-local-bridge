import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_TOOL_NAMES } from "../../src/tool-contract.js";

const AUTHORITATIVE_44 = [
  "accessibility", "apply_patch", "audio", "bridge_instructions", "clipboard", "codex_run",
  "confirm_destructive", "dom_cdp", "edit_file", "file_dialog", "git_diff", "git_log",
  "git_run", "git_status", "health", "input_event", "notification", "office",
  "pending_destructive", "penpot_status", "process_list", "process_logs", "process_start",
  "process_stop", "project_build", "project_dev", "project_lint", "project_test",
  "project_typecheck", "read_file", "scheduler", "screen_record", "search_text", "shell",
  "system_info", "vision", "web_fetch", "window", "workspace_add_root", "workspace_list",
  "workspace_open", "workspace_snapshot", "workspace_tree", "write_file",
];

test("the public MCP contract is exactly the authoritative 44 tools", () => {
  assert.equal(EXPECTED_TOOL_NAMES.length, 44);
  assert.equal(new Set(EXPECTED_TOOL_NAMES).size, 44);
  assert.deepEqual([...EXPECTED_TOOL_NAMES].sort(), AUTHORITATIVE_44.sort());
});
