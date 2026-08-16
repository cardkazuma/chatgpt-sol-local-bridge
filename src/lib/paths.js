import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configuredDenyPaths,
  expandHome,
  loadState,
  workspaceRoots,
} from "./config.js";

const HOME = os.homedir();
const IGNORED_NAMES = new Set([".git", "node_modules", ".DS_Store", ".venv", "__pycache__"]);

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
  const canonical = canonicalPath(target, { forWrite: write });
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

  if (write) {
    const broadWriteRoots = [HOME, ...workspaceRoots()].map((root) => {
      try { return canonicalPath(root, { forWrite: true }); } catch { return path.resolve(root); }
    });
    if (!broadWriteRoots.some((root) => isWithin(canonical, root))) {
      throw new Error(`write is limited to registered workspaces, home, and temp: ${canonical}`);
    }
  }
  return canonical;
}

export function assertInRegisteredRoots(target, { write = false } = {}) {
  const canonical = assertAllowed(target, { write });
  const allowed = workspaceRoots().map((root) => {
    try { return canonicalPath(root, { forWrite: true }); } catch { return path.resolve(root); }
  });
  if (!allowed.some((root) => isWithin(canonical, root))) {
    throw new Error(`path is outside configured workspace roots: ${canonical}\nSet WORKSPACE_ROOTS in .env; tool-driven root registration is disabled by default.`);
  }
  return canonical;
}

export function assertInWorkspace(target, { write = false } = {}) {
  const canonical = assertAllowed(target, { write });
  const allowed = [
    ...workspaceRoots(),
    currentWorkspace(),
  ].filter(Boolean).map((root) => {
    try { return canonicalPath(root, { forWrite: true }); } catch { return path.resolve(root); }
  });

  if (!allowed.some((root) => isWithin(canonical, root))) {
    throw new Error(`path is outside registered workspace roots: ${canonical}\nConfigure WORKSPACE_ROOTS or explicitly enable workspace_add_root.`);
  }
  return canonical;
}

export function fileSnapshot(target, { maxBytes = 200_000 } = {}) {
  const resolved = assertInWorkspace(target);
  const stat = fs.lstatSync(resolved);
  if (stat.isDirectory()) {
    const all = fs.readdirSync(resolved, { withFileTypes: true });
    const entries = all.slice(0, 200).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other",
    }));
    return { path: resolved, type: "dir", entries, truncated: all.length > 200 };
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
  const resolved = assertInWorkspace(root);
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
      const rel = path.relative(resolved, full) || ".";
      const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other";
      out.push({ path: rel, type });
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth) walk(full, depth + 1);
    }
  };

  walk(resolved, 1);
  return { root: resolved, count: out.length, truncated: out.length >= maxEntries, entries: out };
}

function normalizeCase(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
