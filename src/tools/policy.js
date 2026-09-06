import { BRIDGE_PROFILE, DESTRUCTIVE_APPROVAL_MODE, ENABLED_TOOL_NAMES, TOOL_CATALOG_VERSION } from "../lib/config.js";
import { registerEnabledTool } from "../lib/tool-registry.js";
import { ok } from "../lib/text.js";

export function registerPolicy(server) {
  registerEnabledTool(server, "bridge_instructions", {
    title: "Bridge instructions",
    description: "Return the reviewed bridge operating boundary and enabled tool catalog.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ok(BRIDGE_PROFILE === "host" ? [
    `This is the daily-use host profile (${TOOL_CATALOG_VERSION}). It runs with the normal logged-in Mac user authority; it is not a filesystem or network sandbox.`,
    `Enabled MCP tools: ${ENABLED_TOOL_NAMES.join(", ")}`,
    "Every workspace-affecting call requires a stable workspace ID. Resume refreshes real Git state and repository instruction locations; stored state is only a locator.",
    "Worktrees are isolated and mutations are serialized per worktree. This profile is non-exclusive: it does not claim universal coordinator interception, and coordinator-required operations still honor BLOCK, REFRESH, and UNAVAILABLE.",
    "Normal developer PATH, HOME, Git/gh/SSH and package authentication may be used internally. Bridge and tunnel credentials are stripped from tool children and raw credentials must never be requested or returned.",
    "repo_shell is broad and mutating. Inspect status/diff before and after it; reread files before derived edits. It can reach anything the logged-in user can reach.",
    "Before live deployment/restart, production mutation, credential/security change, or destructive work, show the exact action and obtain explicit current-task approval. A stored checkpoint is not ambiguous approval.",
    "Use repository AGENTS/HANDOFF/design sources, actual hooks without bypass, focused and complete checks, non-force push, fresh PR/review/CI state, and expected-head protection for an authorized merge.",
  ].join("\n") : [
    "This is the reviewed isolated local bridge.",
    `Enabled MCP tools: ${ENABLED_TOOL_NAMES.join(", ")}`,
    "Structured file tools can read and write only visible paths inside the mounted disposable workspace.",
    "Ignored, secret-sensitive, runtime, database, log, backup, private-key, .git, .env, db.env, secrets.yaml, and .storage paths are denied by structured tools.",
    "repo_shell and project commands execute as a non-root user inside a read-only-root, no-capability, no-network container. The container boundary—not command regexes—is the shell safety boundary.",
    ENABLED_TOOL_NAMES.includes("git_publish_branch")
      ? "Structured Git writes are limited to local branch create/switch, selected-file staging, hook-enforced commits, and the controller-derived S6 homelab bridge-branch publish. No arbitrary remote, fetch, refspec, force, delete, amend, rebase, reset, restore, clean, or discard operation is available."
      : "Structured Git writes are limited to local branch create/switch, selected-file staging, and hook-enforced commits. They never push, fetch, mutate remotes, alter Git config, force, amend, rebase, reset, restore, clean, or discard work.",
    `Destructive approval mode: ${DESTRUCTIVE_APPROVAL_MODE}. No destructive confirmation tool is exposed.`,
    "Only disposable/isolated workspaces may be mounted. No normal-user home, credentials, NAS paths, Docker socket, tunnel credentials, GitHub credentials, or Codex credentials are provided to this container.",
    "Preferred loop: workspace_open → workspace_snapshot/tree/read/search → write_file/edit_file/apply_patch → project_test/lint/typecheck/build → git_diff/status/log → branch/stage/commit.",
  ].join("\n")));
}
