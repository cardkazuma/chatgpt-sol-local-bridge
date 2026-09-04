import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runCommand } from "../lib/exec.js";
import { assertInWorkspace, assertStructuredPath, canonicalPath, currentWorkspace, isWithin, resolveUserPath } from "../lib/paths.js";
import { assertReviewedHooks, reviewedHooksPath } from "../lib/git-governance.js";
import { s6BrokerAttestCommit, s6BrokerConfigured, s6BrokerPublishBranch } from "../lib/s6-broker-client.js";
import { registerEnabledTool } from "../lib/tool-registry.js";
import { fail, json } from "../lib/text.js";
import { assertGovernedGitPath } from "../../scripts/pre-commit-policy.mjs";

export function registerGit(server) {
  registerEnabledTool(server, "git_status", {
    title: "Git status",
    description: "Show local Git status for the current disposable workspace; remote state is never queried.",
    inputSchema: { cwd: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd } = {}, extra) => runGitRead(["status", "--short", "--branch", "--untracked-files=no"], cwd, extra?.signal));

  registerEnabledTool(server, "git_diff", {
    title: "Git diff",
    description: "Show a bounded local Git diff. staged=true selects the index; selected paths must be visible workspace-relative files.",
    inputSchema: {
      cwd: z.string().optional(),
      staged: z.boolean().optional(),
      path: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd, staged, path: file } = {}, extra) => {
    try {
      const root = await repositoryRoot(cwd);
      const selected = file ? [selectedRepoPath(root, file)] : [];
      if (!selected.length) await assertVisibleDiffPaths(root, staged);
      const args = ["diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", ...selected];
      return json(await git(args, root, extra?.signal));
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "git_log", {
    title: "Git log",
    description: "Show recent local commits without invoking a pager or contacting a remote.",
    inputSchema: {
      cwd: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd, limit } = {}, extra) => runGitRead(["log", `-${limit ?? 15}`, "--oneline", "--decorate"], cwd, extra?.signal));

  registerEnabledTool(server, "git_branch_create", {
    title: "Create local Git branch",
    description: "Create one local branch from the current HEAD. No force, remote, worktree, or clone operation is available.",
    inputSchema: { name: z.string().min(1).max(120), cwd: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ name, cwd } = {}, extra) => {
    try {
      const root = await repositoryRoot(cwd, { write: true });
      await assertBranchName(root, name, extra?.signal);
      return json(await git(["branch", "--", name], root, extra?.signal));
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "git_branch_switch", {
    title: "Switch local Git branch",
    description: "Switch to an existing local branch without discarding changes or guessing a remote branch.",
    inputSchema: { name: z.string().min(1).max(120), cwd: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ name, cwd } = {}, extra) => {
    try {
      const root = await repositoryRoot(cwd, { write: true });
      await assertBranchName(root, name, extra?.signal);
      return json(await git(["switch", "--no-guess", "--", name], root, extra?.signal));
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "git_stage", {
    title: "Stage selected Git paths",
    description: "Stage only explicitly selected existing regular files. Directory-wide add, ignored paths, deletions, and option-like paths are rejected.",
    inputSchema: {
      cwd: z.string().optional(),
      paths: z.array(z.string().min(1).max(400)).min(1).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd, paths } = {}, extra) => {
    try {
      const root = await repositoryRoot(cwd, { write: true });
      const selected = paths.map((value) => selectedRepoPath(root, value, { mustExist: true, regularFileOnly: true }));
      if (new Set(selected).size !== selected.length) return fail("git_stage received duplicate paths");
      return json(await git(["add", "--", ...selected], root, extra?.signal));
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "git_commit", {
    title: "Create local Git commit",
    description: "Commit the existing index with the reviewed .githooks pre-commit hook forced on. Remote and destructive history operations are unavailable.",
    inputSchema: {
      cwd: z.string().optional(),
      message: z.string().min(1).max(4_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd, message } = {}, extra) => {
    try {
      const root = await repositoryRoot(cwd, { write: true });
      if (!String(message).trim() || String(message).includes("\0")) return fail("commit message must be non-empty and contain no NUL bytes");
      await assertReviewedHooks(root, extra?.signal);
      const staged = await stagedPaths(root, extra?.signal);
      if (!staged.length) return fail("git_commit requires selected staged paths");
      const deleted = await stagedDeletedPaths(root, extra?.signal);
      if (deleted.length) return fail(`git_commit refuses staged deletions: ${deleted.join(", ")}`);
      for (const value of staged) assertGovernedGitPath({ root, name: value, label: "git_commit" });
      if (process.env.BRIDGE_GOVERNANCE_MODE === "s6" && !s6BrokerConfigured()) return fail("S6 structured commits require the manager-owned broker attestation channel");
      const result = await git(["-c", `core.hooksPath=${reviewedHooksPath()}`, "commit", "-m", String(message)], root, extra?.signal);
      if (process.env.BRIDGE_GOVERNANCE_MODE === "s6") {
        const head = await git(["rev-parse", "HEAD"], root, extra?.signal);
        if (!head.ok) return fail("S6 commit was created but its HEAD could not be attested");
        try {
          await s6BrokerAttestCommit(head.stdout.trim());
        } catch (error) {
          return fail(`S6 commit was created but is not publishable: ${error.message}`);
        }
      }
      return json(result);
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "git_publish_branch", {
    title: "Publish reviewed S6 branch",
    description: "Publish the current reviewed S6 session HEAD to its manager-generated bridge-owned GitHub branch. Repository, branch, refspec, and force behavior are controller-derived.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (args = {}) => {
    try {
      if (Object.keys(args || {}).length) return fail("git_publish_branch accepts no caller-supplied authority or target");
      if (process.env.BRIDGE_GOVERNANCE_MODE !== "s6") return fail("git_publish_branch is available only in an active S6 session");
      return json(await s6BrokerPublishBranch());
    } catch (error) {
      return fail(error.message);
    }
  });
}

async function runGitRead(args, cwd, signal) {
  try {
    const root = await repositoryRoot(cwd);
    return json(await git(args, root, signal));
  } catch (error) {
    return fail(error.message);
  }
}

async function repositoryRoot(cwd, { write = false } = {}) {
  const starting = assertInWorkspace(cwd ? resolveUserPath(cwd) : currentWorkspace() || process.cwd(), { write });
  const result = await runCommand(["git", "-c", "safe.directory=*", "rev-parse", "--show-toplevel"], { cwd: starting, shell: false });
  if (!result.ok) throw new Error(result.stderr || "cwd is not inside a Git repository");
  const root = canonicalPath(result.stdout.trim());
  if (!isWithin(root, starting) && !isWithin(starting, root)) throw new Error("Git repository root is outside the workspace");
  assertInWorkspace(root, { write });
  return root;
}

async function git(args, root, signal) {
  return runCommand(["git", "--no-pager", "--literal-pathspecs", "-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    shell: false,
    signal,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

function selectedRepoPath(root, input, { mustExist = false, regularFileOnly = false, allowMissing = false } = {}) {
  const value = String(input || "");
  if (!value || value.includes("\0") || path.isAbsolute(value) || value.startsWith("-") || ["*", "?", "[", "]", ":"].some((character) => value.includes(character))) {
    throw new Error(`Git path must be a literal workspace-relative path: ${value}`);
  }
  const pieces = value.split(/[\\/]/);
  if (pieces.some((piece) => piece === "..")) throw new Error(`Git path may not contain '..': ${value}`);
  const normalized = path.normalize(value);
  const target = path.resolve(root, normalized);
  if (!isWithin(target, root)) throw new Error(`Git path escapes repository root: ${value}`);
  const checked = assertStructuredPath(target, { write: true });
  if (!isWithin(checked, root)) throw new Error(`Git path resolves outside repository root: ${value}`);
  if (!allowMissing && !fs.existsSync(checked) && mustExist) throw new Error(`Git path does not exist: ${value}`);
  if (mustExist) {
    const stat = fs.lstatSync(checked);
    if (stat.isSymbolicLink() || (regularFileOnly && !stat.isFile())) throw new Error(`Git stage accepts only existing regular files: ${value}`);
  }
  return path.relative(root, checked).split(path.sep).join("/");
}

async function assertBranchName(root, name, signal) {
  const value = String(name || "");
  if (!value || value.startsWith("-") || value.includes("\0") || value.length > 120) throw new Error("invalid local branch name");
  const result = await git(["check-ref-format", "--branch", value], root, signal);
  if (!result.ok) throw new Error(result.stderr || "invalid local branch name");
}

async function stagedPaths(root, signal) {
  const result = await git(["diff", "--cached", "--name-only", "-z"], root, signal);
  if (!result.ok) throw new Error(result.stderr || "could not inspect the Git index");
  return result.stdout.split("\0").filter(Boolean);
}

async function stagedDeletedPaths(root, signal) {
  const result = await git(["diff", "--cached", "--name-only", "--diff-filter=D", "-z"], root, signal);
  if (!result.ok) throw new Error(result.stderr || "could not inspect staged deletions");
  return result.stdout.split("\0").filter(Boolean);
}

async function assertVisibleDiffPaths(root, staged) {
  const paths = await stagedPathsForDiff(root, staged);
  for (const value of paths) selectedRepoPath(root, value, { allowMissing: true });
}

async function stagedPathsForDiff(root, staged) {
  const result = await git(["diff", ...(staged ? ["--cached"] : []), "--name-only", "-z"], root);
  if (!result.ok) throw new Error(result.stderr || "could not inspect Git diff paths");
  return result.stdout.split("\0").filter(Boolean);
}
