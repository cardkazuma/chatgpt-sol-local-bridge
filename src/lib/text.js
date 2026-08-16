import { MAX_STDERR_CHARS, MAX_STDOUT_CHARS } from "./config.js";

export const DEFAULT_MAX_CHARS = MAX_STDOUT_CHARS;

export function clip(value, max = DEFAULT_MAX_CHARS, { tail = false } = {}) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return tail
    ? `… truncated ${omitted} chars; showing tail …\n${text.slice(-max)}`
    : `${text.slice(0, max)}\n\n… truncated ${omitted} chars`;
}

export function ok(text, extra = {}) {
  return {
    content: [{ type: "text", text: clip(text) }],
    ...extra,
  };
}

export function fail(text, details = undefined) {
  const message = details ? `${text}\n${clip(JSON.stringify(details, null, 2), MAX_STDERR_CHARS)}` : text;
  return {
    content: [{ type: "text", text: clip(message, MAX_STDERR_CHARS) }],
    isError: true,
  };
}

export function json(value) {
  return ok(JSON.stringify(value, null, 2));
}

export function nowIso() {
  return new Date().toISOString();
}

export function splitArgs(input) {
  const source = String(input ?? "");
  const args = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "\\" && quote !== "'" && next != null && (/\s/.test(next) || next === "\\" || next === '"' || next === "'")) {
      current += next;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quote in arguments");
  if (current) args.push(current);
  return args;
}

export function redact(value, key = "") {
  const secretKey = /(authorization|cookie|token|secret|password|api[-_]?key|credential)/i;
  if (secretKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]));
  }
  if (typeof value === "string") {
    const cleaned = value
      .replace(/\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/gi, "[REDACTED]")
      .replace(/\b(password|passwd|token|secret|api[-_]?key|authorization)(\s*[=:]\s*|\s+)[^\s'"]+/gi, "$1$2[REDACTED]");
    return clip(cleaned, 4_000);
  }
  return value;
}
