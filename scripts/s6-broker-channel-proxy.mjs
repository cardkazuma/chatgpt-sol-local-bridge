#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";

const socketArgument = process.argv[1] && process.argv[2] === "--socket" ? process.argv[3] : "";
const socketPath = socketArgument || "/transport/s6-broker.sock";
if (!pathIsAbsolute(socketPath)) throw new Error("S6 proxy socket path is invalid");
const pending = new Map();
let nextId = 1;

if (fs.existsSync(socketPath)) {
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error("S6 proxy socket collision");
  fs.unlinkSync(socketPath);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let envelope;
  try { envelope = JSON.parse(line); } catch { return; }
  const socket = pending.get(envelope?.id);
  if (!socket || typeof envelope.response !== "object" || envelope.response == null) return;
  pending.delete(envelope.id);
  socket.end(`${JSON.stringify(envelope.response)}\n`);
});

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  let buffer = "";
  let sent = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (sent) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 64 * 1024) return socket.destroy();
    if (!buffer.includes("\n")) return;
    const line = buffer.slice(0, buffer.indexOf("\n"));
    let request;
    try { request = JSON.parse(line); } catch { return socket.destroy(); }
    sent = true;
    const id = nextId++;
    pending.set(id, socket);
    process.stdout.write(`${JSON.stringify({ id, request })}\n`);
  });
  socket.on("close", () => {
    for (const [id, value] of pending) if (value === socket) pending.delete(id);
  });
});

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  process.stderr.write("S6_PROXY_READY\n");
});

const close = () => {
  server.close(() => {
    try { fs.unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

function pathIsAbsolute(value) { return typeof value === "string" && value.startsWith("/") && !value.includes("\0"); }
