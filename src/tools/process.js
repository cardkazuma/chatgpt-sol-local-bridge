import os from "node:os";
import { z } from "zod";
import { CODEX_BIN } from "../lib/config.js";
import { listProcesses, runCommand, startProcess, stopProcess, tailFile } from "../lib/exec.js";
import { denyDeleteMessage, inspectDestructive, queueDestructive } from "../lib/policy.js";
import { assertInWorkspace, currentWorkspace, resolveUserPath } from "../lib/paths.js";
import { fail, json } from "../lib/text.js";
import { platformAdapter, platformSummary } from "../platform/index.js";

export function registerProcess(server) {
  server.registerTool("shell", {
    title: "Shell",
    description: "Run a bounded local shell command inside a registered workspace. Delete/reset commands are previewed and require confirm_destructive.",
    inputSchema: {
      command: z.string().min(1).max(100_000),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ command, cwd, timeoutMs }, extra) => {
    try {
      const root = cwd ? assertInWorkspace(resolveUserPath(cwd), { write: true }) : currentWorkspace();
      if (!root) return fail("no workspace — call workspace_open first or pass cwd");
      const inspection = inspectDestructive(command);
      if (inspection.destructive) {
        return fail(denyDeleteMessage(queueDestructive({ kind: "shell", command, cwd: root, timeoutMs, matches: inspection.matches })));
      }
      return json(await runCommand(command, { cwd: root, timeoutMs, signal: extra?.signal }));
    } catch (error) {
      return fail(error.message);
    }
  });

  server.registerTool("process_start", {
    title: "Start process",
    description: "Start a bridge-managed long-running process (dev server, watcher) and return its stable id and log paths.",
    inputSchema: { command: z.string().min(1).max(100_000), cwd: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ command, cwd }) => {
    try {
      const root = cwd ? assertInWorkspace(resolveUserPath(cwd), { write: true }) : currentWorkspace();
      if (!root) return fail("no workspace — call workspace_open first or pass cwd");
      const inspection = inspectDestructive(command);
      if (inspection.destructive) {
        return fail(denyDeleteMessage(queueDestructive({ kind: "process_start", command, cwd: root, matches: inspection.matches })));
      }
      return json(startProcess(command, { cwd: root }));
    } catch (error) {
      return fail(error.message);
    }
  });

  server.registerTool("process_list", {
    title: "List processes",
    description: "List only processes started by this bridge, including current liveness and log paths.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json(listProcesses()));

  server.registerTool("process_logs", {
    title: "Process logs",
    description: "Tail stdout and stderr of a bridge-managed process.",
    inputSchema: { id: z.string(), lines: z.number().int().min(10).max(400).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ id, lines }) => {
    const match = listProcesses().find((item) => item.id === id);
    if (!match) return fail(`unknown bridge-managed process ${id}`);
    return json({ ...match, stdout: tailFile(match.stdoutPath, lines ?? 80), stderr: tailFile(match.stderrPath, lines ?? 80) });
  });

  server.registerTool("process_stop", {
    title: "Stop process",
    description: "Stop a process created by process_start. Arbitrary system PIDs are never accepted.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id }) => {
    try { return json(await stopProcess(id)); }
    catch (error) { return fail(error.message); }
  });

  server.registerTool("codex_run", {
    title: "Run local Codex",
    description: "Delegate implementation or review to the local Codex CLI. This consumes the Codex usage pool.",
    inputSchema: {
      prompt: z.string().min(1).max(100_000),
      cwd: z.string().optional(),
      model: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
      timeoutMs: z.number().int().min(30_000).max(900_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ prompt, cwd, model, reasoningEffort, timeoutMs }, extra) => {
    try {
      const root = cwd ? assertInWorkspace(resolveUserPath(cwd), { write: true }) : currentWorkspace();
      if (!root) return fail("no workspace — call workspace_open first");
      const safePrompt = `${prompt}\n\nStanding safety rule: create/update/edit are allowed. Do not delete files, run hard resets, or discard work unless the human already confirmed that exact action.`;
      const args = [CODEX_BIN, "exec", "--skip-git-repo-check", "--sandbox", "workspace-write"];
      if (model) args.push("--model", model);
      if (reasoningEffort) args.push("--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
      args.push(safePrompt);
      return json(await runCommand(args, { cwd: root, shell: false, timeoutMs: timeoutMs ?? 600_000, maxStdout: 40_000, signal: extra?.signal }));
    } catch (error) {
      return fail(error.message);
    }
  });

  server.registerTool("health", {
    title: "Health",
    description: "Bridge, CPU/RAM/disk, workspace, platform-adapter, and managed-process status.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json({
    ok: true,
    platform: platformSummary(),
    node: process.version,
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: process.memoryUsage(),
    host: { hostname: os.hostname(), cpus: os.cpus().length, freeMemory: os.freemem(), totalMemory: os.totalmem(), loadAverage: os.loadavg() },
    cwd: process.cwd(),
    workspace: currentWorkspace() || null,
    managedProcesses: listProcesses(),
    system: await platformAdapter.healthInfo(),
  }));

  server.registerTool("system_info", {
    title: "System info",
    description: "Cross-platform hardware/software snapshot using the active platform adapter.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json({ platform: platformSummary(), details: await platformAdapter.systemInfo() }));
}
