import { z } from "zod";
import { listProcesses, runCommand, startProcess, stopProcess, tailFile } from "../lib/exec.js";
import { assertInWorkspace, currentWorkspace, resolveUserPath } from "../lib/paths.js";
import { registerEnabledTool } from "../lib/tool-registry.js";
import { fail, json } from "../lib/text.js";
import { platformSummary } from "../platform/index.js";
import { BRIDGE_PROFILE } from "../lib/config.js";
import { activeHostWorkspace } from "../lib/host-workspaces.js";

export function registerProcess(server) {
  registerEnabledTool(server, "repo_shell", {
    title: BRIDGE_PROFILE === "host" ? "Host repository shell" : "Contained repository shell",
    description: BRIDGE_PROFILE === "host"
      ? "Run a bounded, inherently mutating shell command as the normal-user host inside the explicit workspace. Inspect Git state before and after; command filtering is not a containment boundary."
      : "Run a bounded shell command in the hardened non-root bridge container, with cwd constrained to the mounted disposable workspace. Command filtering is not the security boundary.",
    inputSchema: {
      command: z.string().min(1).max(100_000),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ command, cwd, timeoutMs }, extra) => {
    try {
      const root = cwd ? assertInWorkspace(resolveUserPath(cwd), { write: true }) : currentWorkspace();
      if (!root) return fail(BRIDGE_PROFILE === "host" ? "no explicit host workspace" : "no workspace — call workspace_open first or pass cwd");
      return json(await runCommand(command, { cwd: root, timeoutMs, signal: extra?.signal }));
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "process_start", {
    title: "Start process",
    description: BRIDGE_PROFILE === "host" ? "Start a workspace-associated normal-user process and return its stable id and bounded log paths." : "Start a bridge-owned process inside the hardened bridge container and return its stable id and bounded log paths.",
    inputSchema: { command: z.string().min(1).max(100_000), cwd: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ command, cwd }) => {
    try {
      const root = cwd ? assertInWorkspace(resolveUserPath(cwd), { write: true }) : currentWorkspace();
      if (!root) return fail(BRIDGE_PROFILE === "host" ? "no explicit host workspace" : "no workspace — call workspace_open first or pass cwd");
      return json(startProcess(command, { cwd: root }));
    } catch (error) {
      return fail(error.message);
    }
  });

  registerEnabledTool(server, "process_list", {
    title: "List processes",
    description: "List only processes started by this bridge, including current liveness and log paths.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json(listProcesses({ workspaceId: activeHostWorkspace()?.id })));

  registerEnabledTool(server, "process_logs", {
    title: "Process logs",
    description: "Tail stdout and stderr of a bridge-managed process.",
    inputSchema: { id: z.string(), lines: z.number().int().min(10).max(400).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ id, lines }) => {
    const match = listProcesses({ workspaceId: activeHostWorkspace()?.id }).find((item) => item.id === id);
    if (!match) return fail(`unknown bridge-managed process ${id}`);
    return json({ ...match, stdout: tailFile(match.stdoutPath, lines ?? 80), stderr: tailFile(match.stderrPath, lines ?? 80) });
  });

  registerEnabledTool(server, "process_stop", {
    title: "Stop process",
    description: "Stop a process created by process_start. Arbitrary system PIDs are never accepted.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id }) => {
    try {
      const match = listProcesses({ workspaceId: activeHostWorkspace()?.id }).find((item) => item.id === id);
      if (!match) return fail(`process ${id} is not associated with this workspace`);
      return json(await stopProcess(id));
    }
    catch (error) { return fail(error.message); }
  });

  registerEnabledTool(server, "health", {
    title: "Health",
    description: "Bounded bridge runtime health; it does not expose broad host system information.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json({
    ok: true,
    runtime: BRIDGE_PROFILE === "host" ? "daily-use-host" : "s1-contained",
    platform: platformSummary(),
    node: process.version,
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: process.memoryUsage(),
    cwd: process.cwd(),
    workspace: currentWorkspace() || null,
    managedProcesses: listProcesses(),
  }));
}
