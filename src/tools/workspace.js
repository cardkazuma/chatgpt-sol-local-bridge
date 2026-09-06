import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { BRIDGE_PROFILE, loadState, saveState, TOOL_CATALOG_VERSION, workspaceRoots } from "../lib/config.js";
import { assertAllowed, assertStructuredPath, canonicalPath, currentWorkspace, expandHome, resolveUserPath, walkTree } from "../lib/paths.js";
import { hostWorkspaceIndex, registerEnabledTool } from "../lib/tool-registry.js";
import { fail, json, ok } from "../lib/text.js";

export function registerWorkspace(server) {
  registerEnabledTool(server, "workspace_list", {
    title: "List workspaces",
    description: "List registered project roots and the current workspace.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    if (BRIDGE_PROFILE !== "host") return json({ current: currentWorkspace() || null, roots: workspaceRoots().filter(isVisibleRoot) });
    try {
      const workspaces = hostWorkspaceIndex.list().map(({ id, kind, project, objective, branch, baseRef, baseHead, observedHead, pr, checkpoint, createdAt, updatedAt }) => ({
        id, kind: kind || "worktree", project, objective, branch, baseRef, baseHead, observedHead, pr, checkpoint, createdAt, updatedAt,
      }));
      return json({ catalog: TOOL_CATALOG_VERSION, workspaces });
    }
    catch (error) { return fail(`${error.message}; recovery candidates: ${JSON.stringify(hostWorkspaceIndex.recoverCandidates())}`); }
  });

  registerEnabledTool(server, "workspace_open", {
    title: "Open workspace",
    description: "Set the current disposable project directory used as the default cwd for file, Git, project, and repo_shell tools.",
    inputSchema: { path: z.string().describe("Absolute, relative-to-current, or ~ path to a project directory") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ path: input }) => {
    try {
      const resolved = assertStructuredPath(resolveUserPath(input));
      if (!fs.statSync(resolved).isDirectory()) return fail(`${resolved} is not a directory`);
      const state = loadState();
      state.currentWorkspace = canonicalPath(resolved);
      saveState(state);
      return ok(`current workspace = ${state.currentWorkspace}`);
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "workspace_create", {
    title: "Create host workspace",
    description: "Create a durable task-owned Git worktree from an explicitly selected existing repository.",
    inputSchema: {
      repositoryPath: z.string(), branch: z.string().min(1).max(200), base: z.string().optional(),
      objective: z.string().min(1).max(2_000), project: z.string().max(200).optional(),
      scope: z.array(z.string().max(500)).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => {
    try { return json(hostWorkspaceIndex.create(args)); } catch (error) { return fail(error.message); }
  });

  registerEnabledTool(server, "workspace_attach", {
    title: "Attach existing host workspace",
    description: "Register an existing directory in place, or open an exact existing Git branch at an expected head. Reuses an existing branch worktree; an unmounted local branch gets one same-branch worktree, while a remote-only branch gets a detached exact-head worktree. Never creates or replaces a branch.",
    inputSchema: {
      path: z.string().min(1).max(4_000).optional().describe("Directory mode: absolute or ~ path to an existing local directory"),
      repositoryPath: z.string().min(1).max(4_000).optional().describe("Branch mode: absolute or ~ path to an existing local Git repository"),
      branch: z.string().min(1).max(200).optional().describe("Branch mode: exact existing local or remote branch name"),
      expectedHead: z.string().regex(/^[a-fA-F0-9]{40,64}$/).optional().describe("Branch mode: reviewed full commit ID that must match"),
      remote: z.string().min(1).max(101).optional().describe("Branch mode: optional Git remote name for exact remote-head verification"),
      objective: z.string().min(1).max(2_000), project: z.string().max(200).optional(),
      scope: z.array(z.string().max(500)).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ path: input, repositoryPath: repositoryInput, branch, expectedHead, remote, ...metadata }) => {
    try {
      const directoryMode = Boolean(input);
      const branchMode = Boolean(repositoryInput || branch || expectedHead || remote);
      if (directoryMode === branchMode) throw new Error("workspace_attach requires exactly one mode: path, or repositoryPath + branch + expectedHead");
      if (branchMode && (!repositoryInput || !branch || !expectedHead)) {
        throw new Error("branch attachment requires repositoryPath, branch, and expectedHead");
      }
      const selectedInput = directoryMode ? input : repositoryInput;
      const expanded = expandHome(selectedInput);
      if (!path.isAbsolute(expanded)) throw new Error("workspace_attach paths must be absolute or start with ~");
      const directoryPath = assertAllowed(expanded);
      if (!fs.statSync(directoryPath).isDirectory()) throw new Error(`${directoryPath} is not a directory`);
      if (directoryMode) return json(hostWorkspaceIndex.attach({ directoryPath, ...metadata }));
      return json(hostWorkspaceIndex.attachBranch({
        repositoryPath: directoryPath, branch, expectedHead, remote, ...metadata,
      }));
    } catch (error) { return fail(error.message); }
  });

  registerEnabledTool(server, "workspace_resume", {
    title: "Resume host workspace",
    description: "Resume by stable workspace ID after refreshing actual Git state and repository instruction locations.",
    inputSchema: { workspaceId: z.string().regex(/^ws_[a-f0-9]{16}$/) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try { return json(hostWorkspaceIndex.resume(workspaceId)); } catch (error) { return fail(error.message); }
  });

  registerEnabledTool(server, "workspace_status", {
    title: "Host workspace status",
    description: "Read stored locator metadata together with fresh Git state.",
    inputSchema: { workspaceId: z.string().regex(/^ws_[a-f0-9]{16}$/) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try { return json(hostWorkspaceIndex.status(workspaceId)); } catch (error) { return fail(error.message); }
  });

  registerEnabledTool(server, "workspace_checkpoint", {
    title: "Checkpoint host workspace",
    description: "Persist a bounded sanitized checkpoint, optional PR number, and managed process references.",
    inputSchema: {
      workspaceId: z.string().regex(/^ws_[a-f0-9]{16}$/), summary: z.string().min(1).max(2_000),
      pr: z.number().int().positive().optional(), processIds: z.array(z.string()).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, ...checkpoint }) => {
    try { return json(hostWorkspaceIndex.checkpoint(workspaceId, checkpoint)); } catch (error) { return fail(error.message); }
  });

  registerEnabledTool(server, "workspace_recover", {
    title: "Recover workspace locators",
    description: "Read Git worktrees beneath the host-profile root without rewriting missing or corrupt metadata.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json({ candidates: hostWorkspaceIndex.recoverCandidates(), metadataChanged: false }));

  registerEnabledTool(server, "workspace_tree", {
    title: "Workspace tree",
    description: "Bounded project tree snapshot; skips .git, node_modules, virtualenvs, and does not follow symlink directories.",
    inputSchema: {
      path: z.string().optional().describe("Directory to list. Defaults to current workspace."),
      maxDepth: z.number().int().min(1).max(8).optional(),
      maxEntries: z.number().int().min(10).max(2_000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path: input, maxDepth, maxEntries } = {}) => {
    try {
      const root = input ? resolveUserPath(input) : currentWorkspace();
      if (!root) return fail(BRIDGE_PROFILE === "host" ? "no explicit host workspace" : "no current workspace — call workspace_open first or pass path");
      return json(walkTree(root, { maxDepth: maxDepth ?? 3, maxEntries: maxEntries ?? 400 }));
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "workspace_snapshot", {
    title: "Workspace snapshot",
    description: "High-level snapshot: current workspace, git HEAD/status, package metadata, and top-level files.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try {
      const root = currentWorkspace();
      if (!root) return fail(BRIDGE_PROFILE === "host" ? "no explicit host workspace" : "no current workspace — call workspace_open first");
      const top = fs.readdirSync(root)
        .filter((name) => name !== ".DS_Store")
        .map((name) => path.join(root, name))
        .filter(isVisiblePath)
        .map((name) => path.basename(name))
        .sort()
        .slice(0, 100);
      const pkgPath = path.join(root, "package.json");
      let pkg = null;
      if (fs.existsSync(pkgPath) && isVisiblePath(pkgPath)) {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        pkg = { name: parsed.name || null, version: parsed.version || null, scripts: Object.keys(parsed.scripts || {}) };
      }
      const git = gitSnapshot(root);
      return json({ path: root, top, package: pkg, git });
    } catch (error) {
      return fail(error.message);
    }
  });
}

function isVisibleRoot(root) {
  return isVisiblePath(root);
}

function isVisiblePath(target) {
  try {
    assertStructuredPath(target);
    return true;
  } catch {
    return false;
  }
}

function gitSnapshot(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return { repository: false };
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--short"], { cwd: root, encoding: "utf8", maxBuffer: 1_000_000 });
  return {
    repository: true,
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    dirty: Boolean(status.stdout.trim()),
    status: status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100),
  };
}
