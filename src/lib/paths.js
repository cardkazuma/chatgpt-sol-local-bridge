import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  configuredDenyPaths,
  expandHome,
  loadState,
  workspaceRoots,
} from "./config.js";

const HOME = os.homedir();
const IGNORED_NAMES = new Set([".git", "node_modules", ".DS_Store", ".venv", "__pycache__"]);
const DENIED_DIRECTORY_NAMES = new Set([
  ".git",
  ".storage",
  ".venv",
  "__pycache__",
  "backups",
  "backup",
  "logs",
  "log",
  "secrets",
  "credentials",
]);
const DENIED_FILE_PATTERNS = Object.freeze([
  /^\.(?:git|storage|venv)$/i,
  /^\.env(?:\..*)?$/i,
  /^db\.env$/i,
  /^secrets?\.(?:ya?ml|json)$/i,
  /(?:^|[._-])(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)(?:$|[._-])/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
  /\.(?:db|sqlite|sqlite3|wal|shm|dump|bak|backup)$/i,
  /\.log$/i,
]);

export { expandHome };

export function resolveUserPath(input, cwd) {
  const expanded = expandHome(String(input || "").trim());
  if (!expanded) throw new Error("path is required");
  const base = cwd ? expandHome(cwd) : currentWorkspace() || HOME;
  return path.resolve(base, expanded);
}

export function currentWorkspace() {
  const current = loadState().currentWorkspace || "";
  if (!current) return "";
  let canonical;
  try { canonical = canonicalPath(current); } catch { return ""; }
  const registered = workspaceRoots().some((root) => {
    try { return isWithin(canonical, canonicalPath(root)); } catch { return false; }
  });
  return registered ? canonical : "";
}

export function canonicalPath(target, { forWrite = false } = {}) {
  const resolved = path.resolve(target);
  if (!forWrite) return fs.realpathSync.native(resolved);

  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parentReal = fs.realpathSync.native(path.dirname(cursor));
      return path.resolve(parentReal, ...components.slice(index));
    }
    if (stat.isSymbolicLink()) {
      try { cursor = fs.realpathSync.native(cursor); }
      catch { throw new Error(`refusing dangling symlink in write path: ${cursor}`); }
    }
  }
  return fs.realpathSync.native(cursor);
}

export function isWithin(target, root) {
  const targetNormalized = normalizeCase(path.resolve(target));
  const rootNormalized = normalizeCase(path.resolve(root));
  const relative = path.relative(rootNormalized, targetNormalized);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertAllowed(target, { write = false } = {}) {
  const requested = path.resolve(target);
  const requestedSensitiveReason = sensitivePathReason(requested);
  if (requestedSensitiveReason) {
    throw new Error(`refusing secret-sensitive or runtime path (${requestedSensitiveReason}): ${requested}`);
  }
  const canonical = canonicalPath(requested, { forWrite: write });
  const parsed = path.parse(canonical);
  if (normalizeCase(canonical) === normalizeCase(parsed.root)) {
    throw new Error("refusing to touch filesystem root");
  }

  for (const denied of configuredDenyPaths()) {
    let deniedCanonical;
    try {
      deniedCanonical = canonicalPath(denied, { forWrite: true });
    } catch {
      deniedCanonical = path.resolve(denied);
    }
    if (isWithin(canonical, deniedCanonical)) {
      throw new Error(`refusing protected path: ${canonical}`);
    }
  }

  const sensitiveReason = sensitivePathReason(canonical);
  if (sensitiveReason) throw new Error(`refusing secret-sensitive or runtime path (${sensitiveReason}): ${canonical}`);

  if (write) {
    const writeRoots = workspaceRoots().map((root) => {
      try { return canonicalPath(root, { forWrite: true }); } catch { return path.resolve(root); }
    });
    if (!writeRoots.some((root) => isWithin(canonical, root))) {
      throw new Error(`path is outside registered workspace roots; write is limited to registered workspaces: ${canonical}`);
    }
  }
  return canonical;
}

export function assertInRegisteredRoots(target, { write = false } = {}) {
  assertLexicallyInWorkspace(target, "configured");
  const canonical = assertAllowed(target, { write });
  const allowed = workspaceRoots().map((root) => {
    try { return canonicalPath(root, { forWrite: true }); } catch { return path.resolve(root); }
  });
  if (!allowed.some((root) => isWithin(canonical, root))) {
    throw new Error(`path is outside configured workspace roots: ${canonical}\nConfigure WORKSPACE_ROOTS explicitly; tool-driven root registration is not available in S1.`);
  }
  return canonical;
}

export function assertInWorkspace(target, { write = false } = {}) {
  assertLexicallyInWorkspace(target, "registered");
  const canonical = assertAllowed(target, { write });
  const allowed = [
    ...workspaceRoots(),
    currentWorkspace(),
  ].filter(Boolean).map((root) => {
    try { return canonicalPath(root, { forWrite: true }); } catch { return path.resolve(root); }
  });

  if (!allowed.some((root) => isWithin(canonical, root))) {
    throw new Error(`path is outside registered workspace roots: ${canonical}\nConfigure WORKSPACE_ROOTS explicitly; tool-driven root registration is not available in S1.`);
  }
  return canonical;
}

function assertLexicallyInWorkspace(target, scope) {
  const requested = path.resolve(target);
  const roots = workspaceRoots();
  const lexicalAllowed = roots.some((root) => isWithin(requested, path.resolve(root)));
  const allowed = roots.map((root) => {
    try { return canonicalPath(root, { forWrite: true }); } catch { return path.resolve(root); }
  });
  let candidate;
  try { candidate = canonicalPath(requested, { forWrite: true }); }
  catch {
    if (lexicalAllowed) return;
    throw new Error(`path is outside ${scope} workspace roots: ${requested}\nConfigure WORKSPACE_ROOTS explicitly; tool-driven root registration is not available in S1.`);
  }
  if (!allowed.some((root) => isWithin(candidate, root))) {
    throw new Error(`path is outside ${scope} workspace roots: ${requested}\nConfigure WORKSPACE_ROOTS explicitly; tool-driven root registration is not available in S1.`);
  }
}

// Structured file/workspace tools add a second repository-aware check.  The
// regular workspace check protects location; this check protects the content
// class (including ignored files) even when a path is otherwise in-bounds.
export function assertStructuredPath(target, { write = false } = {}) {
  const requested = path.resolve(target);
  const canonical = assertInWorkspace(target, { write });
  assertNotIgnored(canonical);
  assertRuntimePathIsTrackedSource(requested);
  return canonical;
}

export function fileSnapshot(target, { maxBytes = 200_000 } = {}) {
  const resolved = assertStructuredPath(target);
  const stat = fs.lstatSync(resolved);
  if (stat.isDirectory()) {
    const visible = fs.readdirSync(resolved, { withFileTypes: true })
      .map((entry) => ({ entry, full: path.join(resolved, entry.name) }))
      .filter(({ full }) => isVisibleStructuredPath(full));
    const entries = visible.slice(0, 200).map(({ entry }) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other",
    }));
    return { path: resolved, type: "dir", entries, truncated: visible.length > 200 };
  }
  if (stat.isSymbolicLink()) {
    return { path: resolved, type: "symlink", target: fs.readlinkSync(resolved) };
  }
  if (!stat.isFile()) return { path: resolved, type: "other", size: stat.size };

  const fd = fs.openSync(resolved, "r");
  try {
    const bytes = Math.min(stat.size, maxBytes);
    const slice = Buffer.alloc(bytes);
    fs.readSync(fd, slice, 0, bytes, 0);
    const text = slice.toString("utf8");
    const looksBinary = text.includes("\u0000");
    return {
      path: resolved,
      type: "file",
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      truncated: stat.size > maxBytes,
      encoding: looksBinary ? "base64" : "utf8",
      content: looksBinary ? slice.toString("base64") : text,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function walkTree(root, { maxDepth = 3, maxEntries = 400 } = {}) {
  const resolved = assertStructuredPath(root);
  const out = [];
  const visited = new Set();

  const walk = (dir, depth) => {
    if (out.length >= maxEntries) return;
    let real;
    try { real = fs.realpathSync.native(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (IGNORED_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (!isVisibleStructuredPath(full)) continue;
      const rel = path.relative(resolved, full) || ".";
      const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other";
      out.push({ path: rel, type });
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth) walk(full, depth + 1);
    }
  };

  walk(resolved, 1);
  return { root: resolved, count: out.length, truncated: out.length >= maxEntries, entries: out };
}

export function visibleFilePaths(root, { maxFiles = 10_000 } = {}) {
  const resolved = assertStructuredPath(root);
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles || IGNORED_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (!isVisibleStructuredPath(full)) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      else if (entry.isFile()) out.push(canonicalPath(full));
    }
  };
  try {
    if (fs.statSync(resolved).isFile()) return [resolved];
  } catch { return []; }
  walk(resolved);
  return out;
}

export function sensitivePathReason(target) {
  const parts = path.resolve(target).split(path.sep).filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const directory = lowerParts.slice(0, -1);
  const basename = parts.at(-1) || "";
  if (directory.some((part) => DENIED_DIRECTORY_NAMES.has(part) || IGNORED_NAMES.has(part))) return "denied directory";
  if (DENIED_DIRECTORY_NAMES.has(basename) || IGNORED_NAMES.has(basename)) return "denied directory";
  if (DENIED_FILE_PATTERNS.some((pattern) => pattern.test(basename))) return "denied filename";
  return "";
}

function isVisibleStructuredPath(target) {
  try {
    assertStructuredPath(target);
    return true;
  } catch {
    return false;
  }
}

function assertRuntimePathIsTrackedSource(requested) {
  const root = findRepositoryRoot(requested);
  if (!root) return;
  const relative = path.relative(root, requested);
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;

  let stat;
  try { stat = fs.lstatSync(requested); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    stat = null;
  }
  const parts = relative.split(path.sep).filter(Boolean).map((part) => part.toLowerCase());
  const beneathRuntime = parts.slice(0, -1).includes("runtime") || (stat?.isDirectory() && parts.at(-1) === "runtime");
  if (!beneathRuntime) return;
  if (stat?.isSymbolicLink()) throw new Error(`refusing symlink beneath runtime source directory: ${requested}`);

  const tracked = trackedHeadPaths(root, relative);
  if (stat?.isFile() && tracked.includes(toGitPath(relative))) return;
  if (stat?.isDirectory() && tracked.some((name) => isVisibleTrackedRuntimeFile(root, name))) return;
  throw new Error(`refusing runtime path that is not tracked regular source: ${requested}`);
}

function trackedHeadPaths(root, relative) {
  const result = spawnSync("git", [
    "--no-pager",
    "-c", `safe.directory=${root}`,
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    toGitPath(relative),
  ], {
    cwd: root,
    encoding: "utf8",
    env: gitProbeEnvironment(),
  });
  if (result.status !== 0) throw new Error(`refusing runtime path because tracked-state verification failed: ${path.join(root, relative)}`);
  return String(result.stdout || "").split("\0").filter(Boolean);
}

function isVisibleTrackedRuntimeFile(root, relative) {
  const absolute = path.join(root, ...relative.split("/"));
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink() || sensitivePathReason(absolute)) return false;
  return ignoredStatus(root, relative) === 1;
}

function assertNotIgnored(canonical) {
  const root = findRepositoryRoot(canonical);
  if (!root) return;
  const relative = path.relative(root, canonical);
  if (!relative || relative === ".") return;
  const status = ignoredStatus(root, toGitPath(relative));
  if (status === 0) throw new Error(`refusing repository-ignored path: ${canonical}`);
  if (status !== 1) throw new Error(`refusing path because ignored-state verification failed: ${canonical}`);
}

function ignoredStatus(root, relative) {
  const result = spawnSync("git", [
    "--no-pager",
    "-c", `core.excludesFile=${nullDevice()}`,
    "-c", `safe.directory=${root}`,
    "check-ignore",
    "--no-index",
    "--quiet",
    "--",
    relative,
  ], {
    cwd: root,
    encoding: "utf8",
    env: gitProbeEnvironment(),
  });
  return result.status;
}

function toGitPath(value) {
  return String(value).split(path.sep).join("/");
}

function findRepositoryRoot(target) {
  let cursor = nearestExistingPath(target);
  try {
    if (!fs.statSync(cursor).isDirectory()) cursor = path.dirname(cursor);
  } catch { return ""; }
  while (true) {
    try {
      if (fs.lstatSync(path.join(cursor, ".git"))) return cursor;
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) return "";
    cursor = parent;
  }
}

function nearestExistingPath(target) {
  let cursor = path.resolve(target);
  while (true) {
    try { fs.lstatSync(cursor); return cursor; } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}

function gitProbeEnvironment() {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || "",
    USERPROFILE: process.env.USERPROFILE || "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function nullDevice() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function normalizeCase(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
