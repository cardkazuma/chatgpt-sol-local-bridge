import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { loadState, saveState, workspaceRoots } from "../lib/config.js";
import { assertStructuredPath, canonicalPath, currentWorkspace, resolveUserPath, walkTree } from "../lib/paths.js";
import { registerEnabledTool } from "../lib/tool-registry.js";
import { fail, json, ok } from "../lib/text.js";

export function registerWorkspace(server) {
  registerEnabledTool(server, "workspace_list", {
    title: "List workspaces",
    description: "List registered project roots and the current workspace.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json({ current: currentWorkspace() || null, roots: workspaceRoots().filter(isVisibleRoot) }));

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
      if (!root) return fail("no current workspace — call workspace_open first or pass path");
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
      if (!root) return fail("no current workspace — call workspace_open first");
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
