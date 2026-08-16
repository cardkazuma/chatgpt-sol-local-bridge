import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { ALLOW_CROSS_ORIGIN_REDIRECTS, ALLOW_PRIVATE_NETWORK, MAX_FETCH_BYTES, WEB_FETCH_ALLOW_HOSTS } from "./config.js";
import { normalizeHost } from "./net.js";

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export async function safeWebFetch({ url, method = "GET", headers = {}, body }, { signal } = {}) {
  let current = new URL(url);
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  let requestHeaders = { ...headers };
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertSafeTarget(current);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason || new Error("request cancelled"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("request timed out")), REQUEST_TIMEOUT_MS);
    const dispatcher = safeDispatcher(normalizeHost(current.hostname));
    try {
      const response = await undiciFetch(current, {
        method: currentMethod,
        headers: requestHeaders,
        body: currentBody == null || ["GET", "HEAD"].includes(currentMethod) ? undefined : currentBody,
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        await response.body?.cancel();
        const next = new URL(response.headers.get("location"), current);
        if (next.origin !== current.origin) {
          if (!ALLOW_CROSS_ORIGIN_REDIRECTS) throw new Error(`cross-origin redirect blocked: ${current.origin} → ${next.origin}`);
          requestHeaders = keepRedirectSafeHeaders(requestHeaders);
          currentMethod = "GET";
          currentBody = undefined;
        }
        if (response.status === 303 || ([301, 302].includes(response.status) && currentMethod === "POST")) {
          currentMethod = "GET";
          currentBody = undefined;
        }
        current = next;
        continue;
      }

      const payload = await readBoundedBody(response, MAX_FETCH_BYTES);
      return {
        url: current.toString(),
        status: response.status,
        headers: Object.fromEntries([...response.headers].map(([key, value]) => [key, key === "set-cookie" ? "[REDACTED]" : value])),
        body: payload.text,
        bytes: payload.bytes,
        truncated: payload.truncated,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await dispatcher.close();
    }
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

export async function assertSafeTarget(url) {
  if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error("only http:// and https:// URLs are allowed");
  if (url.username || url.password) throw new Error("credentials embedded in URLs are not allowed");
  const host = normalizeHost(url.hostname).toLowerCase();
  if (isAllowlisted(host) || ALLOW_PRIVATE_NETWORK) return;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`private/local target ${host} is blocked; set WEB_FETCH_ALLOW_HOSTS or ALLOW_PRIVATE_NETWORK=true`);
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dnsPromises.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`DNS returned no addresses for ${host}`);
  const blocked = addresses.find(({ address }) => isPrivateAddress(address));
  if (blocked) throw new Error(`private/special address ${blocked.address} is blocked for ${host}; explicitly allow the host if intentional`);
}

export function isPrivateAddress(address) {
  try {
    const parsed = ipaddr.parse(String(address).split("%")[0]);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
      return isPrivateAddress(parsed.toIPv4Address().toString());
    }
    if (parsed.kind() === "ipv6") {
      const normalized = parsed.toNormalizedString();
      if (normalized.startsWith("64:ff9b:0:0:0:0:")) return true; // NAT64 can reach IPv4 special ranges
    }
    return parsed.range() !== "unicast";
  } catch {
    return true;
  }
}

function keepRedirectSafeHeaders(headers) {
  const safe = new Set(["accept", "accept-language", "user-agent"]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => safe.has(key.toLowerCase())));
}

function safeDispatcher(expectedHost) {
  const allowPrivate = ALLOW_PRIVATE_NETWORK || isAllowlisted(expectedHost.toLowerCase());
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dns.lookup(hostname, options, (error, address, family) => {
          if (error) return callback(error);
          const values = Array.isArray(address) ? address : [{ address, family }];
          if (!allowPrivate) {
            const blocked = values.find((entry) => isPrivateAddress(typeof entry === "string" ? entry : entry.address));
            if (blocked) return callback(new Error(`connection-time DNS resolved to blocked address ${typeof blocked === "string" ? blocked : blocked.address}`));
          }
          return callback(null, address, family);
        });
      },
    },
  });
}

function isAllowlisted(host) {
  return WEB_FETCH_ALLOW_HOSTS.some((entry) => entry === host || (entry.startsWith("*.") && host.endsWith(entry.slice(1))));
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) return { text: "", bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const remaining = Math.max(0, maxBytes - total);
      if (remaining) chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel("response size limit reached");
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total, truncated };
}
