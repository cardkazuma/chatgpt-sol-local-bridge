import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classifyPolicyPath } from "./pre-commit-policy.mjs";

const SESSION_ID = /^[a-z][a-z0-9-]*-[a-z0-9]+-[0-9a-f]{16}$/;
const FORBIDDEN_ROOTS = ["/Volumes", "/volume1/docker"];

export class DisposableWorkspaceManager {
  constructor({
    root,
    source,
    governance = {},
    gitIdentity = null,
    protectedPaths = [],
    staleAfterMs = 15 * 60_000,
    sessionPrefix = "s3",
    branchPrefix = `bridge/${sessionPrefix}`,
    remoteName = "source",
    materializer = null,
    allowedTrackedPaths = [],
    allowHomeRoot = false,
    readOnly = false,
  } = {}) {
    if (!root || !path.isAbsolute(root)) throw new Error("disposable workspace root must be an absolute path");
    if (!source && !readOnly) throw new Error("disposable workspace source is required");
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error("staleAfterMs must be positive");
    if (!/^[a-z][a-z0-9-]*$/.test(sessionPrefix)) throw new Error("disposable session prefix is invalid");
    if (!/^bridge\/[a-z][a-z0-9-]*$/.test(branchPrefix)) throw new Error("disposable branch prefix is invalid");
    if (!/^[a-z][a-z0-9-]*$/.test(remoteName)) throw new Error("disposable remote name is invalid");
    if (materializer != null && typeof materializer !== "function") throw new Error("disposable source materializer must be a function");
    if (!Array.isArray(allowedTrackedPaths) || allowedTrackedPaths.some((item) => typeof item !== "string" || !item || path.isAbsolute(item) || item.includes("..") || item.includes("\\") || item.includes("\0"))) {
      throw new Error("disposable allowed tracked paths are invalid");
    }
    this.root = path.resolve(root);
    this.source = source ? validateSource(source, protectedPaths) : null;
    this.governance = { ...governance, managerRoot: this.root };
    this.gitIdentity = normalizeGitIdentity(gitIdentity);
    this.protectedPaths = protectedPaths.map((item) => path.resolve(item));
    this.staleAfterMs = staleAfterMs;
    this.sessionPrefix = sessionPrefix;
    this.branchPrefix = branchPrefix;
    this.remoteName = remoteName;
    this.materializer = materializer;
    this.allowedTrackedPaths = new Set(allowedTrackedPaths);
    this.readOnly = readOnly;
    this.sessionIdPattern = new RegExp(`^${escapeRegExp(sessionPrefix)}-[a-z0-9]+-[0-9a-f]{16}$`);
    this.sessionsRoot = path.join(this.root, "sessions");
    this.stateRoot = path.join(this.root, "manager-state");
    this.gitHome = path.join(this.root, "git-home");
    assertSafeManagerRoot(this.root, this.protectedPaths, { allowHomeRoot });
    this.ensureRoots();
  }

  create() {
    if (!this.source) throw new Error("disposable workspace source is required for create");
    this.reapStale();
    const sessionId = makeSessionId(this.sessionPrefix);
    const branch = `${this.branchPrefix}/${sessionId}`;
    const workspacePath = path.join(this.sessionsRoot, sessionId);
    const statePath = path.join(this.stateRoot, `${sessionId}.json`);
    const record = {
      version: 1,
      kind: "workspace",
      state: "provisioning",
      sessionId,
      branch,
      source: this.source,
      workspacePath,
      statePath,
      ownerUid: currentUid(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    writeJsonExclusive(statePath, record);
    let preparation = {};
    try {
      preparation = this.cloneAndPrepare(workspacePath, branch, sessionId);
      const prepared = {
        ...record,
        ...preparation,
        state: "active",
        sourceCommit: git(["rev-parse", "HEAD"], workspacePath, this.gitEnv()).trim(),
        historyCommits: Number(git(["rev-list", "--all", "--count"], workspacePath, this.gitEnv()).trim()),
        coreHooksPath: git(["config", "--local", "--get", "core.hooksPath"], workspacePath, this.gitEnv()).trim(),
        heartbeatAt: new Date().toISOString(),
      };
      writeJson(statePath, prepared);
      return prepared;
    } catch (error) {
      removeOwnedPath(workspacePath, this.sessionsRoot);
      if (preparation.governanceHostRoot) {
        try { removeOwnedPath(preparation.governanceHostRoot, this.governanceRoot); } catch {}
      }
      fs.rmSync(statePath, { force: true });
      throw error;
    }
  }

  refresh(sessionId) {
    const current = this.readRecord(sessionId);
    assertOwnedRecord(current, this.sessionsRoot, this.stateRoot, this.sessionPrefix, this.branchPrefix);
    const incoming = path.join(this.sessionsRoot, `${sessionId}.incoming-${crypto.randomBytes(8).toString("hex")}`);
    const retired = path.join(this.sessionsRoot, `${sessionId}.retired-${crypto.randomBytes(8).toString("hex")}`);
    const refreshStatePath = path.join(this.stateRoot, `${sessionId}.refresh-${crypto.randomBytes(8).toString("hex")}.json`);
    const refreshing = { ...current, state: "refreshing", pid: process.pid, heartbeatAt: new Date().toISOString() };
    writeJson(current.statePath, refreshing);
    writeJsonExclusive(refreshStatePath, {
      version: 1,
      kind: "refresh",
      sessionId,
      workspacePath: incoming,
      statePath: refreshStatePath,
      ownerUid: currentUid(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    let preparation = {};
    try {
      preparation = this.cloneAndPrepare(incoming, current.branch, sessionId);
      fs.renameSync(current.workspacePath, retired);
      fs.renameSync(incoming, current.workspacePath);
      removeOwnedPath(retired, this.sessionsRoot);
      if (current.governanceHostRoot && preparation.governanceHostRoot !== current.governanceHostRoot) {
        removeOwnedPath(current.governanceHostRoot, this.governanceRoot);
      }
      fs.rmSync(refreshStatePath, { force: true });
      const refreshed = {
        ...current,
        ...preparation,
        state: "active",
        pid: process.pid,
        sourceCommit: git(["rev-parse", "HEAD"], current.workspacePath, this.gitEnv()).trim(),
        historyCommits: Number(git(["rev-list", "--all", "--count"], current.workspacePath, this.gitEnv()).trim()),
        coreHooksPath: git(["config", "--local", "--get", "core.hooksPath"], current.workspacePath, this.gitEnv()).trim(),
        refreshedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      };
      writeJson(current.statePath, refreshed);
      return refreshed;
    } catch (error) {
      removeOwnedPath(incoming, this.sessionsRoot);
      if (preparation.governanceHostRoot && preparation.governanceHostRoot !== current.governanceHostRoot) {
        try { removeOwnedPath(preparation.governanceHostRoot, this.governanceRoot); } catch {}
      }
      if (fs.existsSync(retired) && !fs.existsSync(current.workspacePath)) fs.renameSync(retired, current.workspacePath);
      fs.rmSync(refreshStatePath, { force: true });
      writeJson(current.statePath, current);
      throw error;
    }
  }

  touch(sessionId) {
    const record = this.readRecord(sessionId);
    assertOwnedRecord(record, this.sessionsRoot, this.stateRoot, this.sessionPrefix, this.branchPrefix);
    const next = { ...record, heartbeatAt: new Date().toISOString(), pid: process.pid };
    writeJson(record.statePath, next);
    return next;
  }

  destroy(sessionId) {
    const record = this.readRecord(sessionId);
    assertOwnedRecord(record, this.sessionsRoot, this.stateRoot, this.sessionPrefix, this.branchPrefix);
    removeOwnedPath(record.workspacePath, this.sessionsRoot);
    if (record.governanceHostRoot) removeOwnedPath(record.governanceHostRoot, this.governanceRoot);
    fs.rmSync(record.statePath, { force: true });
    fs.rmSync(path.join(this.stateRoot, `${sessionId}.published.json`), { force: true });
    return { sessionId, destroyed: true };
  }

  reapStale(now = Date.now()) {
    const reaped = [];
    for (const entry of fs.readdirSync(this.stateRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const statePath = path.join(this.stateRoot, entry.name);
      let record;
      try {
        record = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assertOwnedState(record, this.sessionsRoot, this.stateRoot, statePath, this.sessionPrefix, this.branchPrefix);
      } catch {
        continue;
      }
      if (!isStale(record, now, this.staleAfterMs)) continue;
      removeOwnedPath(record.workspacePath, this.sessionsRoot);
      if (record.governanceHostRoot) removeOwnedPath(record.governanceHostRoot, this.governanceRoot);
      fs.rmSync(statePath, { force: true });
      fs.rmSync(path.join(this.stateRoot, `${record.sessionId}.published.json`), { force: true });
      reapSessionTransients(record.sessionId, this.sessionsRoot);
      reaped.push(record.sessionId);
    }
    return reaped;
  }

  destroyAll() {
    const destroyed = [];
    for (const entry of fs.readdirSync(this.stateRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.stateRoot, entry.name), "utf8"));
        assertOwnedState(record, this.sessionsRoot, this.stateRoot, path.join(this.stateRoot, entry.name), this.sessionPrefix, this.branchPrefix);
        removeOwnedPath(record.workspacePath, this.sessionsRoot);
        if (record.governanceHostRoot) removeOwnedPath(record.governanceHostRoot, this.governanceRoot);
        fs.rmSync(record.statePath, { force: true });
        fs.rmSync(path.join(this.stateRoot, `${record.sessionId}.published.json`), { force: true });
        reapSessionTransients(record.sessionId, this.sessionsRoot);
        destroyed.push(record.sessionId);
      } catch {
        // An invalid state file is not a valid owned target and is left alone.
      }
    }
    return destroyed;
  }

  readRecord(sessionId) {
    if (!this.sessionIdPattern.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    const statePath = path.join(this.stateRoot, `${sessionId}.json`);
    if (!fs.existsSync(statePath)) throw new Error(`unknown disposable session: ${sessionId}`);
    const record = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (record.sessionId !== sessionId) throw new Error(`session state identity mismatch: ${sessionId}`);
    return record;
  }

  cloneAndPrepare(workspacePath, branch, sessionId) {
    if (!this.source) throw new Error("disposable workspace source is required for clone");
    if (fs.existsSync(workspacePath)) throw new Error(`workspace destination already exists: ${workspacePath}`);
    let preparation = {};
    if (this.materializer) {
      preparation = this.materializer({
        source: this.source,
        remoteName: this.remoteName,
        workspacePath,
        branch,
        sessionId,
        managerRoot: this.root,
        gitEnv: this.gitEnv(),
      }) || {};
    } else {
      git(["clone", "--no-local", "--no-hardlinks", "--origin", this.remoteName, this.source, workspacePath], this.root, this.gitEnv());
    }
    try {
      validateWorkspaceContents(workspacePath, this.gitEnv(), this.allowedTrackedPaths);
      const governance = this.installGovernance(workspacePath, sessionId);
      preparation = { ...preparation, ...governance };
      if (this.gitIdentity) {
        git(["config", "--local", "user.name", this.gitIdentity.name], workspacePath, this.gitEnv());
        git(["config", "--local", "user.email", this.gitIdentity.email], workspacePath, this.gitEnv());
      }
      git(["config", "--local", "core.hooksPath", this.governanceHooksPath()], workspacePath, this.gitEnv());
      git(["switch", "--create", branch], workspacePath, this.gitEnv());
      validatePreparedWorkspace(workspacePath, branch, this.governance, this.gitEnv(), {
        remoteName: this.remoteName,
        governanceHooksPath: this.governanceHooksPath(),
        governanceHostRoot: preparation.governanceHostRoot,
      });
      restrictTree(workspacePath);
      return preparation;
    } catch (error) {
      removeOwnedPath(workspacePath, this.sessionsRoot);
      if (preparation.governanceHostRoot) removeOwnedPath(preparation.governanceHostRoot, this.governanceRoot);
      throw error;
    }
  }

  governanceHooksPath() {
    return this.governance.external
      ? String(this.governance.hooksPath || "/bridge-governance/hooks")
      : ".githooks";
  }

  installGovernance(workspacePath, sessionId) {
    if (!this.governance.external) {
      installGovernance(workspacePath, this.governance);
      return {};
    }
    if (!sessionId || !/^[a-z][a-z0-9-]*-[a-z0-9]+-[0-9a-f]{16}$/.test(sessionId)) {
      throw new Error("external governance session identity is invalid");
    }
    const governanceRoot = path.join(this.governanceRoot, `${sessionId}-${crypto.randomBytes(8).toString("hex")}`);
    fs.mkdirSync(path.join(governanceRoot, "hooks"), { recursive: true, mode: 0o700 });
    copyReviewedFile(this.governance.hookFile, path.join(governanceRoot, "hooks", "pre-commit"));
    copyReviewedFile(this.governance.policyFile, path.join(governanceRoot, "pre-commit-policy.mjs"));
    restrictGovernanceTree(governanceRoot);
    return { governanceHostRoot: governanceRoot };
  }

  governanceFiles(record) {
    if (!record?.governanceHostRoot) return null;
    return {
      hostRoot: record.governanceHostRoot,
      hooks: path.join(record.governanceHostRoot, "hooks"),
      hookFile: path.join(record.governanceHostRoot, "hooks", "pre-commit"),
      policyFile: path.join(record.governanceHostRoot, "pre-commit-policy.mjs"),
      hooksPath: this.governanceHooksPath(),
      policyPath: String(this.governance.policyPath || "/bridge-governance/pre-commit-policy.mjs"),
    };
  }

  gitEnv() {
    return {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: this.gitHome,
      XDG_CONFIG_HOME: path.join(this.gitHome, "config"),
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      GIT_OPTIONAL_LOCKS: "0",
    };
  }

  ensureRoots() {
    this.governanceRoot = path.join(this.root, "governance");
    for (const directory of [this.root, this.sessionsRoot, this.stateRoot, this.gitHome, path.join(this.gitHome, "config"), this.governanceRoot]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`disposable manager path is not a real directory: ${directory}`);
      fs.chmodSync(directory, 0o700);
      if (currentUid() != null && stat.uid !== currentUid()) throw new Error(`disposable manager path is not owned by the current user: ${directory}`);
    }
  }
}

export function isStale(record, now = Date.now(), staleAfterMs = 15 * 60_000) {
  const heartbeat = Date.parse(record.heartbeatAt || record.createdAt || "");
  return Number.isFinite(heartbeat) && now - heartbeat > staleAfterMs && !processAlive(record.pid);
}

function validateSource(source, protectedPaths) {
  const value = String(source);
  if (/^[^/]+@[^/]+:/.test(value) || /^ssh:\/\//i.test(value)) {
    throw new Error("SSH source URLs are not allowed for disposable workspace materialization");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const parsed = new URL(value);
    if (!new Set(["https:", "file:"]).has(parsed.protocol)) throw new Error(`unsupported source URL protocol: ${parsed.protocol}`);
    if (parsed.username || parsed.password) throw new Error("source URL must not contain credentials");
    if (parsed.protocol === "file:") {
      if (parsed.hostname && parsed.hostname !== "localhost") throw new Error("file source URL must be local");
      const localPath = fs.realpathSync(decodeURIComponent(parsed.pathname));
      if (isWithin(localPath, os.homedir())) throw new Error("disposable workspace source may not be inside the normal user's home");
      for (const protectedPath of protectedPaths) {
        if (isWithin(localPath, path.resolve(protectedPath)) || isWithin(path.resolve(protectedPath), localPath)) {
          throw new Error(`source overlaps protected checkout: ${localPath}`);
        }
      }
    }
    return value;
  }
  if (!path.isAbsolute(value)) throw new Error("local disposable source must be an absolute path");
  const resolved = fs.realpathSync(value);
  if (isWithin(resolved, os.homedir())) {
    throw new Error("disposable workspace source may not be inside the normal user's home");
  }
  for (const protectedPath of protectedPaths) {
    if (isWithin(resolved, path.resolve(protectedPath)) || isWithin(path.resolve(protectedPath), resolved)) {
      throw new Error(`source overlaps protected checkout: ${resolved}`);
    }
  }
  return resolved;
}

function normalizeGitIdentity(identity) {
  if (identity == null) return null;
  if (typeof identity !== "object") throw new Error("disposable Git identity must be an object");
  const name = String(identity.name || "");
  const email = String(identity.email || "");
  if (!name || !email || /[\0\r\n]/.test(name) || /[\0\r\n]/.test(email)) {
    throw new Error("disposable Git identity must contain non-empty single-line name and email");
  }
  return Object.freeze({ name, email });
}

function assertSafeManagerRoot(root, protectedPaths, { allowHomeRoot = false } = {}) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) throw new Error("disposable workspace root may not be a filesystem root");
  const appSupportRoot = path.join(os.homedir(), "Library", "Application Support", "ChatGPT Local Bridge");
  const homeRootAllowed = allowHomeRoot && isWithin(resolved, appSupportRoot) && resolved !== appSupportRoot;
  if ((isWithin(resolved, os.homedir()) || isWithin(os.homedir(), resolved)) && !homeRootAllowed) {
    throw new Error("disposable workspace root may not be inside or above the normal user's home");
  }
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (isWithin(resolved, forbidden) || isWithin(forbidden, resolved)) throw new Error(`disposable workspace root overlaps ${forbidden}`);
  }
  for (const protectedPath of protectedPaths) {
    const candidate = path.resolve(protectedPath);
    if (isWithin(resolved, candidate) || isWithin(candidate, resolved)) throw new Error(`disposable workspace root overlaps protected checkout: ${candidate}`);
  }
  assertNoSymlinkAncestors(resolved);
}

function validateWorkspaceContents(workspacePath, env, allowedTrackedPaths = new Set()) {
  const tracked = git(["ls-files", "-z"], workspacePath, env).split("\0").filter(Boolean);
  for (const relative of tracked) {
    if (!classifyPolicyPath(relative).allowed && !allowedTrackedPaths.has(relative)) {
      throw new Error(`source contains forbidden tracked path: ${relative}`);
    }
    if (hasRuntimeDirectory(relative)) {
      const ignored = gitStatus(["check-ignore", "--no-index", "--quiet", "--", relative], workspacePath, env);
      if (ignored.status === 0) throw new Error(`source contains repository-ignored tracked runtime path: ${relative}`);
      if (ignored.status !== 1) throw new Error(`source ignored-state verification failed for tracked runtime path: ${relative}`);
    }
  }
  walkNoSymlinks(workspacePath);
  const status = git(["status", "--porcelain", "--ignored", "--untracked-files=all"], workspacePath, env).trim();
  if (status) throw new Error(`fresh clone contains unexpected material: ${status}`);
}

function validatePreparedWorkspace(workspacePath, branch, governance, env, {
  remoteName = "source",
  governanceHooksPath = ".githooks",
  governanceHostRoot = "",
} = {}) {
  const hooksPath = git(["config", "--local", "--get", "core.hooksPath"], workspacePath, env).trim();
  if (hooksPath !== governanceHooksPath) throw new Error(`core.hooksPath was not fixed to ${governanceHooksPath}: ${hooksPath}`);
  const currentBranch = git(["branch", "--show-current"], workspacePath, env).trim();
  if (currentBranch !== branch) throw new Error(`session branch mismatch: ${currentBranch}`);
  if (git(["rev-parse", "--is-shallow-repository"], workspacePath, env).trim() !== "false") throw new Error("disposable clone is shallow");
  const remote = git(["config", "--get", `remote.${remoteName}.url`], workspacePath, env).trim();
  if (remote.includes("@")) throw new Error("source remote contains unexpected credential material");
  if (governance.external) {
    const managerGovernanceRoot = path.resolve(thisManagerRoot(governance));
    if (!governanceHostRoot || !isWithin(governanceHostRoot, managerGovernanceRoot)) throw new Error("external governance path escaped manager root");
    for (const [target, source] of [[path.join(governanceHostRoot, "hooks", "pre-commit"), governance.hookFile], [path.join(governanceHostRoot, "pre-commit-policy.mjs"), governance.policyFile]]) {
      if (!fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error("external governance file missing or symlinked");
      if (source && sha256(target) !== sha256(source)) throw new Error("external governance file does not match reviewed source");
    }
  } else {
    for (const relative of [".githooks/pre-commit", "scripts/pre-commit-policy.mjs"]) {
      const target = path.join(workspacePath, relative);
      if (!fs.statSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error(`governance file missing or symlinked: ${relative}`);
    }
    if (governance.hookFile && sha256(path.join(workspacePath, ".githooks", "pre-commit")) !== sha256(governance.hookFile)) throw new Error("installed hook does not match reviewed hook");
    if (governance.policyFile && sha256(path.join(workspacePath, "scripts", "pre-commit-policy.mjs")) !== sha256(governance.policyFile)) throw new Error("installed policy does not match reviewed policy");
  }
}

function thisManagerRoot(governance) {
  if (!governance.managerRoot || !path.isAbsolute(governance.managerRoot)) throw new Error("external governance manager root is required");
  return path.join(path.resolve(governance.managerRoot), "governance");
}

function installGovernance(workspacePath, governance) {
  for (const [source, relative] of [[governance.hookFile, ".githooks/pre-commit"], [governance.policyFile, "scripts/pre-commit-policy.mjs"]]) {
    if (!source) continue;
    const resolved = fs.realpathSync(source);
    if (!fs.statSync(resolved).isFile()) throw new Error(`governance source is not a file: ${source}`);
    const target = path.join(workspacePath, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(resolved, target);
  }
}

function copyReviewedFile(source, target) {
  if (!source) throw new Error("external governance source is required");
  const resolved = fs.realpathSync(source);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`governance source is not a file: ${source}`);
  fs.copyFileSync(resolved, target);
}

function restrictGovernanceTree(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("external governance root is not a real directory");
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) restrictGovernanceTree(full);
    else if (entry.isFile()) fs.chmodSync(full, 0o555);
    else throw new Error(`external governance contains unsupported entry: ${full}`);
  }
}

function restrictTree(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`workspace is not a real directory: ${target}`);
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) restrictTree(full);
    else if (entry.isFile()) {
      const reviewedGovernance = full.endsWith(".githooks/pre-commit") || full.endsWith("scripts/pre-commit-policy.mjs");
      const executable = (fs.lstatSync(full).mode & 0o111) !== 0;
      fs.chmodSync(full, reviewedGovernance ? 0o555 : executable ? 0o700 : 0o600);
    }
    else throw new Error(`workspace contains unsupported filesystem entry: ${full}`);
  }
}

function walkNoSymlinks(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`source contains a symlink: ${target}`);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) walkNoSymlinks(path.join(target, entry.name));
}

function hasRuntimeDirectory(relative) {
  return String(relative).split("/").slice(0, -1).some((part) => part.toLowerCase() === "runtime");
}

function git(args, cwd, env) {
  const result = gitStatus(args, cwd, env);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout || "";
}

function gitStatus(args, cwd, env) {
  return spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function writeJsonExclusive(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function assertOwnedRecord(record, sessionsRoot, stateRoot, sessionPrefix = "s3", branchPrefix = "bridge/s3") {
  if (!record || record.version !== 1 || record.kind !== "workspace" || !SESSION_ID.test(record.sessionId)) throw new Error("invalid disposable session state");
  if (!new RegExp(`^${escapeRegExp(sessionPrefix)}-[a-z0-9]+-[0-9a-f]{16}$`).test(record.sessionId)) throw new Error("disposable session namespace mismatch");
  if (record.branch !== `${branchPrefix}/${record.sessionId}`) throw new Error("disposable session branch identity mismatch");
  if (path.resolve(record.statePath) !== path.join(path.resolve(stateRoot), `${record.sessionId}.json`)) throw new Error("disposable state path escaped manager state");
  if (path.resolve(record.workspacePath) !== path.join(path.resolve(sessionsRoot), record.sessionId)) throw new Error("disposable workspace path escaped manager sessions");
  if (record.ownerUid !== currentUid()) throw new Error("disposable session owner mismatch");
}

function assertOwnedState(record, sessionsRoot, stateRoot, expectedStatePath = null, sessionPrefix = "s3", branchPrefix = "bridge/s3") {
  if (record?.kind === "refresh") {
    if (record.version !== 1 || !SESSION_ID.test(record.sessionId) || !new RegExp(`^${escapeRegExp(sessionPrefix)}-[a-z0-9]+-[0-9a-f]{16}$`).test(record.sessionId) || record.ownerUid !== currentUid()) throw new Error("invalid disposable refresh state");
    const statePath = path.resolve(record.statePath);
    if (path.dirname(statePath) !== path.resolve(stateRoot) || !path.basename(statePath).startsWith(`${record.sessionId}.refresh-`)) throw new Error("disposable refresh state escaped manager state");
    if (expectedStatePath && statePath !== path.resolve(expectedStatePath)) throw new Error("disposable refresh state identity mismatch");
    const resolved = path.resolve(record.workspacePath);
    const sessionRoot = path.resolve(sessionsRoot);
    if (!isWithin(resolved, sessionRoot) || !new RegExp(`^${escapeRegExp(record.sessionId)}\\.(?:incoming|retired)-[0-9a-f]{16}$`).test(path.basename(resolved))) throw new Error("disposable refresh path escaped manager sessions");
    return;
  }
  if (expectedStatePath && path.resolve(record.statePath) !== path.resolve(expectedStatePath)) throw new Error("disposable state identity mismatch");
  assertOwnedRecord(record, sessionsRoot, stateRoot, sessionPrefix, branchPrefix);
}

function reapSessionTransients(sessionId, sessionsRoot) {
  if (!SESSION_ID.test(sessionId)) return;
  const prefix = `${sessionId}.`;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    if (!new RegExp(`^${escapeRegExp(sessionId)}\\.(?:incoming|retired)-[0-9a-f]{16}$`).test(entry.name)) continue;
    removeOwnedPath(path.join(sessionsRoot, entry.name), sessionsRoot);
  }
}

function removeOwnedPath(target, parent) {
  const resolved = path.resolve(target);
  const parentResolved = path.resolve(parent);
  if (!isWithin(resolved, parentResolved) || resolved === parentResolved) throw new Error(`refusing to remove unowned disposable path: ${resolved}`);
  if (!fs.existsSync(resolved)) return;
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing to remove non-directory disposable path: ${resolved}`);
  if (currentUid() != null && stat.uid !== currentUid()) throw new Error(`refusing to remove disposable path owned by another user: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function assertNoSymlinkAncestors(target) {
  const benignSystemAliases = process.platform === "darwin" ? new Set(["/tmp", "/var"]) : new Set();
  const absolute = path.resolve(target);
  const ancestors = [];
  let current = absolute;
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of ancestors.reverse()) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      if (!benignSystemAliases.has(candidate)) throw new Error(`disposable workspace root has a symlink ancestor: ${candidate}`);
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`disposable workspace root ancestor is not a directory: ${candidate}`);
  }
}

function makeSessionId(prefix = "s3") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
