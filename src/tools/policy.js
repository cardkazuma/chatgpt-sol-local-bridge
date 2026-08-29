import { DESTRUCTIVE_APPROVAL_MODE, ENABLED_TOOL_NAMES } from "../lib/config.js";
import { registerEnabledTool } from "../lib/tool-registry.js";
import { ok } from "../lib/text.js";

export function registerPolicy(server) {
  registerEnabledTool(server, "bridge_instructions", {
    title: "S1 bridge instructions",
    description: "Return the reviewed S1 operating boundary and enabled tool catalog.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ok([
    "This is the S1 isolated local bridge foundation.",
    `Enabled MCP tools: ${ENABLED_TOOL_NAMES.join(", ")}`,
    "Structured file tools can read and write only visible paths inside the mounted disposable workspace.",
    "Ignored, secret-sensitive, runtime, database, log, backup, private-key, .git, .env, db.env, secrets.yaml, and .storage paths are denied by structured tools.",
    "repo_shell and project commands execute as a non-root user inside a read-only-root, no-capability, no-network container. The container boundary—not command regexes—is the shell safety boundary.",
    "Structured Git writes are limited to local branch create/switch, selected-file staging, and hook-enforced commits. They never push, fetch, mutate remotes, alter Git config, force, amend, rebase, reset, restore, clean, or discard work.",
    `Destructive approval mode: ${DESTRUCTIVE_APPROVAL_MODE}. No destructive confirmation tool is exposed in S1.`,
    "Only disposable/isolated workspaces may be mounted. No normal-user home, credentials, NAS paths, Docker socket, tunnel credentials, GitHub credentials, or Codex credentials are provided to this container.",
    "Preferred loop: workspace_open → workspace_snapshot/tree/read/search → write_file/edit_file/apply_patch → project_test/lint/typecheck/build → git_diff/status/log → branch/stage/commit.",
  ].join("\n")));
}
