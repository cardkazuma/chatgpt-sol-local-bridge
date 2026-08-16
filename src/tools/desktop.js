import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { interceptor } from "../lib/interceptor.js";
import { readOfficeFile, writeOfficeFile } from "../lib/office.js";
import { denyDeleteMessage, inspectDestructive, queueDestructive } from "../lib/policy.js";
import { safeWebFetch } from "../lib/web-fetch.js";
import { assertInWorkspace, resolveUserPath } from "../lib/paths.js";
import { fail, json, ok, splitArgs } from "../lib/text.js";
import { platformAdapter } from "../platform/index.js";

export function registerDesktop(server) {
  server.registerTool("dom_cdp", {
    title: "Browser / CDP",
    description: "Drive a signed-in browser through interceptor: open, read, inspect, click, type, navigate, evaluate, list tabs, and screenshot.",
    inputSchema: { action: z.string().min(1).describe("interceptor browser action, e.g. 'open https://example.com --text-only'") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ action }, extra) => {
    if (looksLikeUiDelete(action)) return fail(denyDeleteMessage(queueDestructive({ kind: "desktop_action", tool: "dom_cdp", action, summary: `browser action may delete data: ${action}` })));
    const result = await interceptor(splitArgs(action), { signal: extra?.signal });
    return /\bscreenshot\b/i.test(action) ? packVision(withDiscoveredImage(result)) : pack(result);
  });

  server.registerTool("accessibility", {
    title: "Native accessibility",
    description: "Inspect and operate native application accessibility/UI Automation using the active macOS, Linux, or Windows adapter.",
    inputSchema: { action: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ action }) => {
    if (looksLikeUiDelete(action)) return fail(denyDeleteMessage(queueDestructive({ kind: "desktop_action", tool: "accessibility", action, summary: `accessibility action may delete data: ${action}` })));
    return pack(await platformAdapter.accessibility(action));
  });

  server.registerTool("input_event", {
    title: "Keyboard / mouse",
    description: "Low-level keyboard, click, and scroll input through the active platform adapter.",
    inputSchema: { action: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ action }) => pack(await platformAdapter.inputEvent(action)));

  server.registerTool("vision", {
    title: "Vision / OCR",
    description: "Capture the screen/window and optionally OCR it using the active platform adapter.",
    inputSchema: { app: z.string().optional(), mode: z.enum(["screenshot", "ocr", "text"]).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (args = {}) => packVision(await platformAdapter.vision(args)));

  server.registerTool("window", {
    title: "Window",
    description: "List, activate, move, resize, minimize/maximize, or close native windows using the active platform adapter. Close/quit/kill requires confirmation.",
    inputSchema: { action: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ action }) => {
    if (looksLikeWindowClose(action)) {
      return fail(denyDeleteMessage(queueDestructive({ kind: "window", action, summary: `window action: ${action}` })));
    }
    return pack(await platformAdapter.window(action));
  });

  server.registerTool("clipboard", {
    title: "Clipboard",
    description: "Read or write the local text clipboard through the active platform adapter.",
    inputSchema: { mode: z.enum(["read", "write"]), text: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ mode, text }) => {
    if (mode === "write" && text == null) return fail("text is required for clipboard write");
    return pack(await platformAdapter.clipboard({ mode, text: text || "" }));
  });

  server.registerTool("notification", {
    title: "Notification",
    description: "Post a native OS notification.",
    inputSchema: { title: z.string().min(1), body: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => pack(await platformAdapter.notification(args)));

  server.registerTool("file_dialog", {
    title: "File dialog",
    description: "Open a native Open/Save dialog and return the chosen path.",
    inputSchema: { mode: z.enum(["open", "save"]).optional(), prompt: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args = {}) => pack(await platformAdapter.fileDialog(args)));

  server.registerTool("screen_record", {
    title: "Screen record",
    description: "Record a bounded 2–60 second screen capture with the platform's ffmpeg backend.",
    inputSchema: { action: z.enum(["start", "stop"]), seconds: z.number().int().min(2).max(60).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => pack(await platformAdapter.screenRecord(args)));

  server.registerTool("audio", {
    title: "Audio",
    description: "Record a bounded microphone clip or play a local audio file through the active platform adapter.",
    inputSchema: {
      action: z.enum(["record", "play"]),
      path: z.string().optional(),
      seconds: z.number().int().min(1).max(30).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => {
    try {
      const safeArgs = args.action === "play" && args.path
        ? { ...args, path: assertInWorkspace(resolveUserPath(args.path)) }
        : args;
      return pack(await platformAdapter.audio(safeArgs));
    } catch (error) {
      return fail(error.message);
    }
  });

  server.registerTool("scheduler", {
    title: "Scheduler",
    description: "List or create user-scoped scheduled tasks using launchd, systemd-user, or Windows Task Scheduler. Deletion is intentionally not exposed.",
    inputSchema: {
      action: z.enum(["list", "create"]),
      label: z.string().optional(),
      command: z.string().optional(),
      intervalSeconds: z.number().int().min(60).max(31_536_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => {
    if (args.action === "create") {
      if (!args.label?.startsWith("chatgpt-sol-local-bridge.")) {
        return fail("scheduler labels must start with chatgpt-sol-local-bridge. to avoid overwriting unrelated user jobs");
      }
    }
    if (args.action === "create" && args.command) {
      const inspection = inspectDestructive(args.command);
      if (inspection.destructive) return fail(denyDeleteMessage(queueDestructive({ kind: "scheduler_create", args, summary: `scheduled command is destructive: ${args.command}`, matches: inspection.matches })));
    }
    return pack(await platformAdapter.scheduler(args));
  });

  server.registerTool("web_fetch", {
    title: "Web fetch",
    description: "Bounded HTTP request from the workstation. Private/local addresses are blocked by default and redirects are revalidated; allow them explicitly for intranet use.",
    inputSchema: {
      url: z.string().url(),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (request, extra) => {
    if ((request.method || "GET").toUpperCase() === "DELETE") {
      return fail(denyDeleteMessage(queueDestructive({ kind: "web_fetch", summary: `HTTP DELETE ${request.url}`, request })));
    }
    try { return json(await safeWebFetch(request, { signal: extra?.signal })); }
    catch (error) { return fail(error.message); }
  });

  server.registerTool("office", {
    title: "Office documents",
    description: "Cross-platform read/write for .docx and .xlsx plus CSV/TSV/text. Uses Node document libraries, not platform-specific Office COM.",
    inputSchema: {
      action: z.enum(["read", "write"]),
      path: z.string(),
      content: z.string().max(1_000_000).optional().describe("Text/Markdown for docx; JSON or CSV/TSV for xlsx"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ action, path, content }) => {
    try {
      if (action === "read") return json(await readOfficeFile(path));
      if (content == null) return fail("content is required for office write");
      const target = assertInWorkspace(resolveUserPath(path), { write: true });
      if (content.length === 0 && fs.existsSync(target) && fs.statSync(target).size > 0) {
        const expectedSha256 = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
        return fail(denyDeleteMessage(queueDestructive({
          kind: "office_write_empty",
          summary: `office write would replace existing content with an empty document: ${target}`,
          path: target,
          content,
          expectedSha256,
        })));
      }
      return json(await writeOfficeFile(target, content));
    } catch (error) {
      return fail(error.message);
    }
  });
}

function looksLikeWindowClose(action) {
  const text = String(action);
  return (/\b(?:quit|kill|close|terminate|force.?quit|windowclose|windowkill)\b/i.test(text)
    || /(^|\s)-c(?:\s|$)/.test(text))
    && !/\b(?:hide|minimize)\b/i.test(text);
}

function looksLikeUiDelete(action) {
  const text = String(action);
  return /\b(?:click|press|invoke|submit|act)\b[^\n]{0,120}\b(?:delete|remove|trash|destroy|empty)\b/i.test(text)
    || /\b(?:delete|remove|trash|destroy|empty)\b[^\n]{0,120}\b(?:button|menu|confirm)\b/i.test(text);
}

function withDiscoveredImage(result) {
  if (!result?.ok || result.artifactPath) return result;
  for (const match of String(result.stdout || "").match(/(?:[A-Za-z]:\\|\/)[^\n"']+\.(?:png|jpe?g)/gi) || []) {
    const candidate = match.trim();
    if (fs.existsSync(candidate)) return { ...result, artifactPath: candidate };
  }
  return result;
}

function packVision(result) {
  if (!result?.ok) return fail(result?.stderr || result?.stdout || "vision adapter failed");
  if (!result.artifactPath) return pack(result);
  try {
    const stat = fs.statSync(result.artifactPath);
    if (stat.size > 10_000_000) return fail(`screenshot exceeds 10 MB MCP image limit: ${result.artifactPath}`);
    const extension = path.extname(result.artifactPath).toLowerCase();
    const mimeType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
    return {
      content: [
        { type: "text", text: `captured ${result.artifactPath} (${stat.size} bytes)` },
        { type: "image", data: fs.readFileSync(result.artifactPath).toString("base64"), mimeType },
      ],
    };
  } catch (error) {
    return fail(`capture succeeded but image could not be attached: ${error.message}`);
  }
}

function pack(result) {
  if (!result?.ok) return fail(result?.stderr || result?.stdout || "platform adapter failed");
  return ok(result.stdout || JSON.stringify(result, null, 2) || "(empty)");
}
