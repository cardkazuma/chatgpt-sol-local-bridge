import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.ALLOW_PRIVATE_NETWORK = "true";
process.env.ALLOW_CROSS_ORIGIN_REDIRECTS = "false";
const { safeWebFetch } = await import("../../src/lib/web-fetch.js");

test("cross-origin redirects are rejected before forwarding credentials or bodies", async () => {
  let reached = false;
  const target = http.createServer((_req, res) => { reached = true; res.end("unexpected"); }).listen(0, "127.0.0.1");
  await once(target, "listening");
  const targetPort = target.address().port;
  const source = http.createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/sink` });
    res.end();
  }).listen(0, "127.0.0.1");
  await once(source, "listening");
  try {
    await assert.rejects(() => safeWebFetch({
      url: `http://127.0.0.1:${source.address().port}/start`,
      method: "POST",
      headers: { "X-Auth-Token": "secret" },
      body: "password=secret",
    }), /cross-origin redirect blocked/);
    assert.equal(reached, false);
  } finally {
    await Promise.all([
      new Promise((resolve) => source.close(resolve)),
      new Promise((resolve) => target.close(resolve)),
    ]);
  }
});
