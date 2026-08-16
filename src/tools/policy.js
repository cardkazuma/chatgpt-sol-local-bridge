import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { DESTRUCTIVE_APPROVAL_MODE } from "../lib/config.js";
import { auditEvent } from "../lib/audit.js";
import { runCommand, startProcess } from "../lib/exec.js";
import { interceptor } from "../lib/interceptor.js";
import { writeOfficeFile } from "../lib/office.js";
import { listPending, takeDestructive } from "../lib/policy.js";
import { safeWebFetch } from "../lib/web-fetch.js";
import { assertInWorkspace } from "../lib/paths.js";
import { fail, json, ok, splitArgs } from "../lib/text.js";
import { platformAdapter, platformSummary } from "../platform/index.js";

export function registerPolicy(server) {
  server.registerTool("confirm_destructive", {
    title: "Confirm destructive action",
    description: "Execute one exact, previously previewed delete/reset/quit action after the human explicitly said yes. Tokens are single-use and expire after 10 minutes by default.",
    inputSchema: {
      token: z.string().regex(/^del_[A-Za-z0-9_-]{20,}$/),
      userSaidYes: z.boolean().describe("Must be true only after the human explicitly confirmed the shown preview."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ token, userSaidYes }, extra) => {
    const taken = takeDestructive(token, { userSaidYes });
    if (taken.error) return fail(taken.error);
    try {
      const result = await executeApproved(taken.item, extra?.signal);
      auditEvent("destructive.executed", { fingerprint: taken.item.fingerprint, kind: taken.item.kind, ok: result?.ok !== false, code: result?.code });
      return json({ confirmed: summarize(taken.item), result });
    } catch (error) {
      auditEvent("destructive.execution_failed", { fingerprint: taken.item.fingerprint, kind: taken.item.kind, error: error.message });
      return fail(`approved action failed: ${error.message}`);
    }
  });

  server.registerTool("pending_destructive", {
    title: "Pending destructive actions",
    description: "List unexpired, unused destructive previews waiting for a human yes.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json({ approvalMode: DESTRUCTIVE_APPROVAL_MODE, pending: listPending().map(summarize) }));

  server.registerTool("penpot_status", {
    title: "Penpot status",
    description: "Show supported Penpot connection paths. Penpot MCP remains a separate connector; this bridge can also drive the Penpot web app through dom_cdp.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => json({
    hosted: "https://design.penpot.app",
    localMcp: "http://127.0.0.1:4401/mcp",
    startLocal: "npx -y @penpot/mcp@stable",
    pluginManifest: "http://127.0.0.1:4400/manifest.json",
    options: [
      "Expose Penpot MCP through a second Secure MCP Tunnel profile/ChatGPT app.",
      "Use dom_cdp through this bridge to operate design.penpot.app in the signed-in browser.",
    ],
  }));

  server.registerTool("bridge_instructions", {
    title: "Standing instructions",
    description: "Always-on operating rules, safety policy, platform capabilities, and preferred development loop. Call this first.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => ok([
    "You are operating this workstation through chatgpt-sol-local-bridge.",
    `Platform: ${JSON.stringify(platformSummary())}`,
    "Create, update, edit, test, lint, typecheck, build, browse, and inspect are allowed inside registered workspace roots.",
    "Never delete/trash data, hard-reset, git-clean/restore, force-push, drop database data, or quit an app without an exact pending token and explicit human yes.",
    "If a tool returns DELETE BLOCKED: show the preview verbatim, ask the human, and only then call confirm_destructive with that token and userSaidYes=true.",
    `Destructive approval mode: ${DESTRUCTIVE_APPROVAL_MODE}. Tokens are single-use and expire.`,
    "Preferred loop: workspace_open → workspace_snapshot/search/read → apply_patch/edit_file → project_test/lint/typecheck → git_diff/status.",
    "Use process_start/process_logs/process_stop for long-running servers; shell is for bounded commands.",
    "Use dom_cdp for browser pages. Use accessibility/input_event/window/vision for native UI only when the platform capability reports it available.",
    "codex_run is optional and spends the separate Codex usage pool.",
    "Stay inside registered roots. Do not seek credentials, keychains, .ssh, cloud config, or other protected paths.",
  ].join("\n")));
}

async function executeApproved(item, signal) {
  if (item.kind === "shell" || item.kind === "git") {
    const cwd = assertInWorkspace(item.cwd, { write: true });
    return runCommand(item.command, { cwd, timeoutMs: item.timeoutMs || 300_000, signal });
  }
  if (item.kind === "process_start") {
    const cwd = assertInWorkspace(item.cwd, { write: true });
    return startProcess(item.command, { cwd });
  }
  if (item.kind === "apply_patch_delete") {
    const cwd = assertInWorkspace(item.cwd, { write: true });
    const check = await runCommand(["git", "apply", "--check", "--whitespace=nowarn", "-"], { cwd, shell: false, stdin: item.diff, signal });
    if (!check.ok) return check;
    return runCommand(["git", "apply", "--whitespace=nowarn", "-"], { cwd, shell: false, stdin: item.diff, signal });
  }
  if (item.kind === "window") return platformAdapter.window(item.action);
  if (item.kind === "web_fetch") return safeWebFetch(item.request, { signal });
  if (item.kind === "scheduler_create") return platformAdapter.scheduler(item.args);
  if (item.kind === "desktop_action") {
    if (item.tool === "dom_cdp") return interceptor(splitArgs(item.action));
    if (item.tool === "accessibility") return platformAdapter.accessibility(item.action);
    throw new Error(`unsupported desktop tool ${item.tool}`);
  }
  if (item.kind === "write_empty" || item.kind === "office_write_empty") {
    const target = assertInWorkspace(item.path, { write: true });
    const current = fs.readFileSync(target);
    const actual = crypto.createHash("sha256").update(current).digest("hex");
    if (actual !== item.expectedSha256) throw new Error("file changed after preview; request a new approval token");
    if (item.kind === "office_write_empty") return writeOfficeFile(target, item.content || "");
    fs.writeFileSync(target, "");
    return { ok: true, path: target, bytes: 0 };
  }
  throw new Error(`unsupported destructive preview kind ${item.kind}`);
}

function summarize(item) {
  const { diff, ...safe } = item;
  return { ...safe, ...(diff ? { diffPreview: String(diff).slice(0, 4_000), diffBytes: Buffer.byteLength(diff) } : {}) };
}
