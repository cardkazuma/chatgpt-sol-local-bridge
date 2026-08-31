// This is the reviewed bridge public catalog. The upstream implementation still
// contains code for later capabilities, but those names are deliberately not
// in this catalog and therefore cannot be exposed through MCP discovery.
export const EXPECTED_TOOL_NAMES = Object.freeze([
  "bridge_instructions",
  "workspace_list",
  "workspace_open",
  "workspace_tree",
  "workspace_snapshot",
  "read_file",
  "search_text",
  "write_file",
  "apply_patch",
  "edit_file",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch_create",
  "git_branch_switch",
  "git_stage",
  "git_commit",
  "git_publish_branch",
  "project_test",
  "project_lint",
  "project_typecheck",
  "project_build",
  "repo_shell",
  "process_start",
  "process_list",
  "process_logs",
  "process_stop",
  "health",
]);

export const TOOL_CATALOG = Object.freeze([
  { name: "bridge_instructions", family: "policy" },
  { name: "workspace_list", family: "workspace" },
  { name: "workspace_open", family: "workspace" },
  { name: "workspace_tree", family: "workspace" },
  { name: "workspace_snapshot", family: "workspace" },
  { name: "read_file", family: "files" },
  { name: "search_text", family: "files" },
  { name: "write_file", family: "files" },
  { name: "apply_patch", family: "files" },
  { name: "edit_file", family: "files" },
  { name: "git_status", family: "git-read" },
  { name: "git_diff", family: "git-read" },
  { name: "git_log", family: "git-read" },
  { name: "git_branch_create", family: "git-write" },
  { name: "git_branch_switch", family: "git-write" },
  { name: "git_stage", family: "git-write" },
  { name: "git_commit", family: "git-write" },
  { name: "git_publish_branch", family: "git-remote-write" },
  { name: "project_test", family: "project" },
  { name: "project_lint", family: "project" },
  { name: "project_typecheck", family: "project" },
  { name: "project_build", family: "project" },
  { name: "repo_shell", family: "execution" },
  { name: "process_start", family: "processes" },
  { name: "process_list", family: "processes" },
  { name: "process_logs", family: "processes" },
  { name: "process_stop", family: "processes" },
  { name: "health", family: "runtime" },
]);

const REVIEWED_NAMES = new Set(EXPECTED_TOOL_NAMES);

export function parseEnabledTools(rawValue) {
  if (rawValue == null) return new Set(EXPECTED_TOOL_NAMES);
  const raw = String(rawValue).trim();
  if (!raw) throw new Error("ENABLED_TOOLS must contain at least one reviewed bridge tool name");
  const names = raw.split(/[\n,]/).map((name) => name.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error("ENABLED_TOOLS contains duplicate tool names");
  const unsupported = names.filter((name) => !REVIEWED_NAMES.has(name));
  if (unsupported.length) {
    throw new Error(`ENABLED_TOOLS contains unsupported or disabled tool(s): ${unsupported.join(", ")}`);
  }
  return new Set(names);
}
