import net from "node:net";

export function normalizeHost(host) {
  const value = String(host || "").trim();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function hostForUrl(host) {
  const normalized = normalizeHost(host);
  return net.isIPv6(normalized) ? `[${normalized}]` : normalized;
}

export function httpUrl(host, port, pathname = "") {
  const suffix = pathname.startsWith("/") || !pathname ? pathname : `/${pathname}`;
  return `http://${hostForUrl(host)}:${port}${suffix}`;
}
