import { z } from "zod";
import { runCommand } from "../lib/exec.js";
import { denyDeleteMessage, inspectDestructive, inspectGitDestructive, queueDestructive } from "../lib/policy.js";
import { assertInWorkspace, currentWorkspace, resolveUserPath } from "../lib/paths.js";
import { fail, json, splitArgs } from "../lib/text.js";

async function git(args, cwd, signal) {
  const root = assertInWorkspace(cwd ? resolveUserPath(cwd) : currentWorkspace() || process.cwd());
  return runCommand(["git", ...args], { cwd: root, shell: false, signal });
}

export function registerGit(server) {
  server.registerTool("git_status", {
    title: "Git status",
    description: "Show git status --short --branch for the current workspace.",
    inputSchema: { cwd: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd } = {}, extra) => json(await git(["status", "--short", "--branch"], cwd, extra?.signal)));

  server.registerTool("git_diff", {
    title: "Git diff",
    description: "Show a bounded git diff. staged=true selects the index.",
    inputSchema: {
      cwd: z.string().optional(),
      staged: z.boolean().optional(),
      path: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd, staged, path: file } = {}, extra) => {
    const args = ["diff", "--no-ext-diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);
    return json(await git(args, cwd, extra?.signal));
  });

  server.registerTool("git_log", {
    title: "Git log",
    description: "Show recent commits without invoking external pagers.",
    inputSchema: {
      cwd: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ cwd, limit } = {}, extra) => json(await git(["--no-pager", "log", `-${limit ?? 15}`, "--oneline", "--decorate"], cwd, extra?.signal)));

  server.registerTool("git_run", {
    title: "Git run",
    description: "Run a git subcommand inside the current workspace. Deletes, hard resets, restore, branch deletion, and force-push require confirm_destructive.",
    inputSchema: {
      args: z.string().min(1).describe("Arguments after git, e.g. 'add -A' or 'commit -m \"message\"'"),
      cwd: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ args, cwd }, extra) => {
    try {
      const root = assertInWorkspace(cwd ? resolveUserPath(cwd) : currentWorkspace() || process.cwd(), { write: true });
      const argv = splitArgs(args);
      const forbidden = argv.find((arg, index) => ["-C", "-c", "--config-env"].includes(arg)
        || arg.startsWith("--git-dir") || arg.startsWith("--work-tree") || arg.startsWith("--exec-path")
        || (index > 0 && argv[index - 1] === "-c"));
      if (forbidden) return fail(`git global override ${forbidden} is not allowed; use workspace_open/cwd instead`);
      const textInspection = inspectDestructive(`git ${args}`);
      const argvInspection = inspectGitDestructive(argv);
      const inspection = { destructive: textInspection.destructive || argvInspection.destructive, matches: [...new Set([...textInspection.matches, ...argvInspection.matches])] };
      if (inspection.destructive) {
        return fail(denyDeleteMessage(queueDestructive({ kind: "git", command: `git ${args}`, cwd: root, matches: inspection.matches })));
      }
      return json(await git(argv, root, extra?.signal));
    } catch (error) {
      return fail(error.message);
    }
  });
}
