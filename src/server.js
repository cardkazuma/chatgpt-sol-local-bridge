import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  APP_NAME,
  APP_VERSION,
  BODY_LIMIT,
  ENABLED_TOOL_NAMES,
  HARDENED_CONTAINER,
  HOST,
  MCP_TOKEN,
  MCP_UNIX_SOCKET_PATH,
  PORT,
  ensureStateDirs,
  isLoopbackHost,
  validateRuntimeConfig,
  validateUnixSocketPath,
} from "./lib/config.js";
import { auditEvent, instrumentServer } from "./lib/audit.js";
import { httpUrl, normalizeHost } from "./lib/net.js";
import { platformSummary } from "./platform/index.js";
import { registerFiles } from "./tools/files.js";
import { registerGit } from "./tools/git.js";
import { registerPolicy } from "./tools/policy.js";
import { registerProcess } from "./tools/process.js";
import { registerProject } from "./tools/project.js";
import { registerWorkspace } from "./tools/workspace.js";

// A control-plane key, if inherited from an outer launcher, must never reach tool children.
delete process.env.CONTROL_PLANE_API_KEY;

export function createServer() {
  const server = instrumentServer(new McpServer({
    name: APP_NAME,
    version: APP_VERSION,
    websiteUrl: "https://github.com/mingrath/chatgpt-sol-local-bridge",
  }, {
    instructions: [
      "You are connected to this workstation through chatgpt-sol-local-bridge.",
      "Call bridge_instructions before operating.",
      "Create/update/edit/test/build are allowed inside registered workspaces.",
      "The repo_shell and project commands run only inside the hardened non-root bridge container.",
      "Destructive approval mode is deny; no destructive confirmation tool is exposed.",
      `Enabled S1 tools: ${ENABLED_TOOL_NAMES.join(", ")}.`,
    ].join(" "),
  }));
  registerPolicy(server);
  registerWorkspace(server);
  registerFiles(server);
  registerGit(server);
  registerProject(server);
  registerProcess(server);
  return server;
}

export function createApp({ host = HOST } = {}) {
  validateRuntimeConfig(host);
  ensureStateDirs();
  const app = express();
  const activeTransports = new Set();
  app.disable("x-powered-by");
  app.use(hostHeaderGuardFor(host));
  app.use("/mcp", (req, res, next) => {
    if (authorized(req)) return next();
    auditEvent("http.unauthorized", { ip: req.ip, path: req.path });
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
  });
  app.use(express.json({ limit: BODY_LIMIT, strict: true }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: APP_NAME, version: APP_VERSION, platform: platformSummary(), pid: process.pid });
  });
  app.get("/readyz", (_req, res) => {
    res.json({ ready: true, toolCount: ENABLED_TOOL_NAMES.length, tools: ENABLED_TOOL_NAMES });
  });

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    activeTransports.add(transport);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      activeTransports.delete(transport);
      await Promise.allSettled([transport.close(), server.close()]);
    };
    res.once("finish", close);
    res.once("close", close);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      auditEvent("http.mcp_failed", { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal MCP error" }, id: null });
      }
    }
    return undefined;
  });

  app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "stateless MCP endpoint accepts POST only" }));
  app.use((error, _req, res, _next) => {
    auditEvent("http.error", { error: error.message });
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
    return res.status(400).json({ error: "invalid request" });
  });

  return { app, activeTransports };
}

export function startHttpServer({ host = HOST, port = PORT, unixSocketPath = MCP_UNIX_SOCKET_PATH } = {}) {
  const { app, activeTransports } = createApp({ host });
  validateUnixSocketPath(unixSocketPath);
  if (unixSocketPath) prepareUnixSocket(unixSocketPath);
  const sockets = new Set();
  const httpServer = unixSocketPath
    ? app.listen(unixSocketPath, onListening)
    : app.listen(port, host, onListening);

  function onListening() {
    if (unixSocketPath) {
      try {
        fs.chmodSync(unixSocketPath, 0o600);
      } catch (error) {
        if (!new Set(["EINVAL", "ENOTSUP"]).has(error?.code)) throw error;
        auditEvent("server.socket_mode_unavailable", { socketPath: unixSocketPath, error: error.code });
      }
    }
    const address = httpServer.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const endpoint = unixSocketPath
      ? `Unix socket ${unixSocketPath} (HTTP path /mcp)`
      : httpUrl(host, actualPort, "/mcp");
    console.log(`${APP_NAME} ${APP_VERSION} listening on ${endpoint}`);
    console.log(`${ENABLED_TOOL_NAMES.length} enabled S1 tools | platform=${platformSummary().adapter} | destructive approval=${process.env.DESTRUCTIVE_APPROVAL_MODE || "deny"}`);
    auditEvent("server.started", { host, port: actualPort, unixSocketPath: unixSocketPath || null, platform: platformSummary() });
  }

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const shutdown = async (signal = "shutdown") => {
    auditEvent("server.stopping", { signal });
    await Promise.race([
      Promise.allSettled([...activeTransports].map((transport) => transport.close())),
      delay(2_000),
    ]);
    const closed = new Promise((resolve) => httpServer.close(resolve));
    await Promise.race([closed, delay(5_000)]);
    if (httpServer.listening || sockets.size) {
      httpServer.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await Promise.race([closed, delay(500)]);
    }
    if (unixSocketPath) removeOwnedUnixSocket(unixSocketPath);
  };
  return { app, httpServer, shutdown };
}

function prepareUnixSocket(socketPath) {
  const parent = path.dirname(socketPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if ((fs.statSync(parent).mode & 0o077) !== 0) throw new Error(`MCP Unix socket parent must be private: ${parent}`);
  if (HARDENED_CONTAINER) {
    const transportRoot = fs.realpathSync("/transport");
    const parentReal = fs.realpathSync(parent);
    if (transportRoot !== "/transport" || !isWithinPath(parentReal, transportRoot)) {
      throw new Error(`MCP Unix socket parent escaped /transport: ${parent}`);
    }
  }
  if (!fs.existsSync(socketPath)) return;
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket MCP_UNIX_SOCKET_PATH: ${socketPath}`);
  fs.unlinkSync(socketPath);
}

function isWithinPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function removeOwnedUnixSocket(socketPath) {
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSocket()) fs.unlinkSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") auditEvent("server.socket_cleanup_failed", { socketPath, error: error.message });
  }
}

function authorized(req) {
  if (!MCP_TOKEN) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(MCP_TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function hostHeaderGuardFor(host) {
  return (req, res, next) => {
  if (!isLoopbackHost(host)) return next();
  const raw = String(req.headers.host || "");
  const hostname = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  if (!["127.0.0.1", "localhost", "::1"].includes(normalizeHost(hostname).toLowerCase())) {
    auditEvent("http.invalid_host", { host: raw });
    return res.status(403).json({ error: "invalid Host header" });
  }
  return next();
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const runtime = startHttpServer();
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      await runtime.shutdown(signal);
      process.exit(0);
    });
  }
}
