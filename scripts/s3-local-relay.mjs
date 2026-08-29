import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const bridgeSocket = required("S3_BRIDGE_SOCKET");
const relaySocket = process.env.S3_RELAY_SOCKET || "";
const relayHost = process.env.S3_RELAY_HOST || "";
const relayPort = relayHost ? Number(required("S3_RELAY_PORT")) : 0;
const token = required("S3_RELAY_TOKEN");
const maxBodyBytes = 2 * 1024 * 1024;

validateListenTarget();
if (relaySocket) prepareSocket(relaySocket);
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.writeHead(405, { allow: "POST" });
    response.end(JSON.stringify({ error: "MCP relay accepts POST /mcp only" }));
    return;
  }
  if (!authorized(request.headers.authorization)) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
    return;
  }
  try {
    const body = await readBody(request);
    const headers = {
      accept: request.headers.accept || "application/json, text/event-stream",
      "content-type": request.headers["content-type"] || "application/json",
      "content-length": Buffer.byteLength(body),
      host: "localhost",
    };
    const upstream = http.request({ socketPath: bridgeSocket, path: "/mcp", method: "POST", headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `bridge unavailable: ${error.code || error.message}` }));
    });
    upstream.end(body);
  } catch (error) {
    response.writeHead(error.code === "LIMIT" ? 413 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
server.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
server.listen(relaySocket || { host: relayHost, port: relayPort }, () => {
  if (relaySocket) {
    try { fs.chmodSync(relaySocket, 0o600); } catch (error) {
      if (!(["EINVAL", "ENOTSUP"].includes(error.code))) throw error;
    }
  }
  process.stdout.write(`${JSON.stringify({ ready: true, transport: relaySocket ? "unix" : "tcp", socket: relaySocket || null, host: relayHost || null, port: relayPort || null })}\n`);
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => { if (relaySocket) removeSocket(relaySocket); });
  });
}

function authorized(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maxBodyBytes) {
        const error = new Error("request body too large");
        error.code = "LIMIT";
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function prepareSocket(socketPath) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(socketPath)) return;
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error(`refusing to replace non-socket relay path: ${socketPath}`);
  fs.unlinkSync(socketPath);
}

function removeSocket(socketPath) {
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSocket()) fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`${error.message}\n`);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateListenTarget() {
  if (relaySocket && (relayHost || process.env.S3_RELAY_PORT)) throw new Error("choose either S3_RELAY_SOCKET or S3_RELAY_HOST/S3_RELAY_PORT");
  if (!relaySocket && !relayHost) throw new Error("S3_RELAY_SOCKET or S3_RELAY_HOST is required");
  if (relayHost && !["127.0.0.1", "localhost"].includes(relayHost)) throw new Error("S3_RELAY_HOST must be loopback-only");
  if (relayHost && (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535)) throw new Error("S3_RELAY_PORT must be a valid TCP port");
}
