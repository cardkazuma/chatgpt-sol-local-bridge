import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TaskRegistry } from "./registry.js";
import { RecoveryBudget } from "./recovery.js";

const VERSION = "s7c-1";
const CATALOG = ["bridge_status", "bridge_recover", "task_workspace"];
const GENERATION = crypto.createHash("sha256").update(JSON.stringify({ version: VERSION, tools: CATALOG })).digest("hex");

export async function startController({ root, port, token, dependencies, repositories = [], registerCoordinator, recovery: suppliedRecovery, recover = async () => {} }) {
  if (typeof token !== "string" || token.length < 16) throw new Error("controller transport authentication unavailable");
  const registry = new TaskRegistry(path.join(root, "registry"));
  const recovery = suppliedRecovery || new RecoveryBudget(root);
  let busy = false;
  let selected = null;
  const status = async () => {
    let health;
    try { health = await dependencies(); }
    catch { health = { tunnel: { ready: false, reason: "probe_failed" }, coordinator: { ready: false, reason: "probe_failed" } }; }
    return {
      version: VERSION, ready: health.tunnel?.ready === true && health.coordinator?.ready === true && recovery.status().phase !== "DEGRADED",
      controller: { ready: true, pid: process.pid }, ...health,
      catalog: { generation: GENERATION, version: VERSION, tools: CATALOG, refresh: "Refresh the installed ChatGPT Local Bridge app actions after a catalog change; verify this generation in a new ordinary Chat." },
      surface: { expected: "supported ordinary ChatGPT web with the app activated", state: "client_verification_required" },
      workspace: selected, recovery: recovery.status(), scope: "S7-C durable lifecycle; development operations require S7-D",
    };
  };
  const toolResult = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify({ ...value, catalogGeneration: GENERATION }) }], isError });
  function server() {
    const mcp = new McpServer({ name: "ChatGPT Local Bridge", version: VERSION }, { instructions: "Trusted local operator. Read bridge_status first. Tasks outlive conversations. Repository governance and the selected Work Coordinator remain binding. High-impact work requires exact user approval. Never retrieve or disclose secrets. Current gate is S7-C lifecycle only." });
    const register = (name, description, schema, handler) => mcp.registerTool(name, { description, inputSchema: schema }, async (args) => {
      if (busy) return toolResult({ error: "CONTROLLER_BUSY; retry after the active operation" }, true);
      busy = true;
      const request = crypto.randomUUID();
      try {
        const result = await handler(args);
        audit(name, request, false);
        return toolResult(result);
      } catch (error) {
        audit(name, request, true);
        // Subprocess errors may include credential-bearing stderr. Only our
        // bounded semantic errors are returned; child output is never logged.
        const message = error?.status !== undefined || error?.code ? "operation failed; inspect the task and dependency status" : String(error.message).slice(0, 500);
        return toolResult({ error: message, request }, true);
      } finally { busy = false; }
    });
    register("bridge_status", "Current component health and catalog generation; app refresh and unsupported surfaces remain client boundaries.", {}, status);
    register("bridge_recover", "Recheck and recover only owned controller/tunnel state with bounded retries; preserves workspaces and never replays high-impact work.", {}, async () => {
      recovery.event("explicit", crypto.randomUUID()); await recover(); return status();
    });
    register("task_workspace", "Create, find, resume or retire durable task-owned worktrees. Ambiguous find results require selecting an ID. Retirement retains dirty, unpublished and active work.", {
      action: z.enum(["create", "find", "list", "resume", "status", "retire"]),
      id: z.string().optional(), repository: z.string().optional(), project: z.string().optional(), objective: z.string().max(500).optional(), pr: z.number().int().positive().optional(),
    }, async (args) => {
      if (args.action === "list") return { tasks: registry.list() };
      if (args.action === "find") return { candidates: registry.find(args) };
      if (args.action === "status") return { task: registry.inspect(args.id) };
      const health = await dependencies();
      if (!health.coordinator?.ready) throw new Error("COORDINATOR_UNAVAILABLE; no lifecycle mutation performed");
      if (args.action === "create") {
        const repository = repositories.find((r) => r.name === args.repository);
        if (!repository || typeof registerCoordinator !== "function") throw new Error("repository/controller binding unavailable");
        const task = await registry.create({ repository, objective: args.objective, project: args.project });
        try { registry.update(task.id, { coordinator: await registerCoordinator(task) }); }
        catch { registry.update(task.id, { lifecycle: "coordination_unavailable" }); throw new Error("coordinator registration failed; workspace retained for recovery"); }
        selected = task.id;
        return { task: registry.get(task.id) };
      }
      if (args.action === "resume") { const task = await registry.resume(args.id); selected = task.id; return { task }; }
      if (args.action === "retire") return { task: await registry.retire(args.id) };
      throw new Error("unknown lifecycle action");
    });
    return mcp;
  }
  function audit(operation, request, failed) {
    const file = path.join(root, "operations.jsonl");
    // No raw args, subprocess output, task text or credentials in audit.
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), operation, request, failed, catalog: GENERATION })}\n`, { mode: 0o600 });
  }
  const app = express(); app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "")) return res.sendStatus(403);
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ ready: true, version: VERSION }));
  app.get("/readyz", async (_req, res) => { const s = await status(); res.status(s.ready ? 200 : 503).json(s); });
  app.use("/mcp", (req, res, next) => {
    const actual = Buffer.from(req.headers.authorization || ""); const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.sendStatus(401);
    next();
  });
  app.use(express.json({ limit: "1mb", strict: true }));
  const transports = new Set();
  app.post("/mcp", async (req, res) => {
    const mcp = server();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transports.add(transport);
    res.once("close", () => { transports.delete(transport); void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: "MCP request failed" }); }
  });
  app.all("/mcp", (_req, res) => res.sendStatus(405));
  app.use((_error, _req, res, _next) => res.status(400).json({ error: "invalid request" }));
  const http = await new Promise((resolve, reject) => {
    const listener = app.listen(port, "127.0.0.1", (error) => error ? reject(error) : resolve(listener)); listener.once("error", reject);
  });
  return { port: http.address().port, registry, status, async close() { for (const t of transports) await t.close(); http.closeAllConnections(); await new Promise((r) => http.close(r)); } };
}
