import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";

const context = new AsyncLocalStorage();
const mutationTails = new Map();

export class WorkspaceIndexCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceIndexCorruptError";
    this.code = "WORKSPACE_INDEX_RECOVERY_REQUIRED";
  }
}

export class HostWorkspaceIndex {
  constructor({ stateFile, worktreeRoot } = {}) {
    if (!path.isAbsolute(String(stateFile || "")) || !path.isAbsolute(String(worktreeRoot || ""))) {
      throw new Error("host workspace index requires absolute state and worktree paths");
    }
    this.stateFile = path.resolve(stateFile);
    this.worktreeRoot = path.resolve(worktreeRoot);
  }

  list() {
    return Object.values(this.#read().workspaces).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    const record = this.#read().workspaces[id];
    if (!record) throw new Error(`unknown host workspace ${id}`);
    return record;
  }

  create({ repositoryPath, branch, base = "HEAD", objective, project = "", scope = [] } = {}) {
    const source = realDirectory(repositoryPath, "repositoryPath");
    git(["rev-parse", "--git-dir"], source);
    if (!validBranch(branch)) throw new Error("workspace branch is invalid");
    if (!Array.isArray(scope) || scope.some((item) => typeof item !== "string" || item.length > 500)) throw new Error("workspace scope is invalid");
    const id = `ws_${crypto.randomBytes(8).toString("hex")}`;
    const target = path.join(this.worktreeRoot, id);
    fs.mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.worktreeRoot, 0o700);
    const baseHead = git(["rev-parse", "--verify", `${base}^{commit}`], source);
    git(["worktree", "add", target, "-b", branch, baseHead], source);
    const now = new Date().toISOString();
    const record = {
      id,
      version: 1,
      project: bounded(project, 200),
      objective: bounded(objective, 2_000, true),
      scope: scope.map((item) => bounded(item, 500)),
      repositoryPath: source,
      repositoryIdentity: sha256(realGitCommonDir(source)),
      worktreePath: fs.realpathSync.native(target),
      branch,
      baseRef: bounded(base, 200),
      baseHead,
      observedHead: baseHead,
      pr: null,
      checkpoint: null,
      processIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const index = this.#read();
    index.workspaces[id] = record;
    this.#write(index);
    return record;
  }

  resume(id) {
    const index = this.#read();
    const record = index.workspaces[id];
    if (!record) throw new Error(`unknown host workspace ${id}`);
    const gitState = inspectGit(record.worktreePath);
    record.observedHead = gitState.head;
    record.updatedAt = new Date().toISOString();
    this.#write(index);
    return { ...record, git: gitState, instructionFiles: instructionFiles(record.worktreePath) };
  }

  status(id) {
    const record = this.get(id);
    return { ...record, git: inspectGit(record.worktreePath), instructionFiles: instructionFiles(record.worktreePath) };
  }

  checkpoint(id, { summary, pr = undefined, processIds = undefined } = {}) {
    const index = this.#read();
    const record = index.workspaces[id];
    if (!record) throw new Error(`unknown host workspace ${id}`);
    if (pr !== undefined && pr !== null && (!Number.isInteger(pr) || pr <= 0)) throw new Error("workspace PR must be a positive integer");
    if (processIds !== undefined && (!Array.isArray(processIds) || processIds.some((value) => !/^p_[A-Za-z0-9_]+$/.test(value)))) throw new Error("workspace process references are invalid");
    const gitState = inspectGit(record.worktreePath);
    record.observedHead = gitState.head;
    if (pr !== undefined) record.pr = pr;
    if (processIds !== undefined) record.processIds = [...new Set(processIds)];
    record.checkpoint = { summary: bounded(summary, 2_000, true), at: new Date().toISOString(), head: gitState.head };
    record.updatedAt = record.checkpoint.at;
    this.#write(index);
    return record;
  }

  recoverCandidates() {
    if (!fs.existsSync(this.worktreeRoot)) return [];
    return fs.readdirSync(this.worktreeRoot, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
      const worktreePath = path.join(this.worktreeRoot, entry.name);
      try {
        const gitState = inspectGit(worktreePath);
        return [{ worktreePath, ...gitState }];
      } catch { return []; }
    });
  }

  #read() {
    if (!fs.existsSync(this.stateFile)) return { version: 1, workspaces: {} };
    let value;
    try { value = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); }
    catch { throw new WorkspaceIndexCorruptError(`workspace index is corrupt; preserved at ${this.stateFile}; use workspace_recover for read-only candidates`); }
    if (!validIndex(value)) throw new WorkspaceIndexCorruptError(`workspace index is invalid; preserved at ${this.stateFile}; use workspace_recover for read-only candidates`);
    return value;
  }

  #write(value) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }
}

export function activeHostWorkspace() {
  return context.getStore() || null;
}

export async function withHostWorkspace(index, id, { mutating = false } = {}, callback) {
  if (typeof callback !== "function") throw new Error("workspace callback is required");
  const record = index.get(id);
  const run = () => context.run(record, callback);
  if (!mutating) return run();
  const prior = mutationTails.get(record.worktreePath) || Promise.resolve();
  const next = prior.catch(() => {}).then(run);
  mutationTails.set(record.worktreePath, next);
  try { return await next; }
  finally { if (mutationTails.get(record.worktreePath) === next) mutationTails.delete(record.worktreePath); }
}

function inspectGit(root) {
  const head = git(["rev-parse", "HEAD"], root);
  const branch = git(["branch", "--show-current"], root);
  const status = git(["status", "--short", "--branch"], root);
  return { head, branch, dirty: status.split("\n").slice(1).some(Boolean), status: status.split("\n").filter(Boolean).slice(0, 100) };
}

function instructionFiles(root) {
  return ["AGENTS.md", "HANDOFF.md"].map((name) => path.join(root, name)).filter((target) => fs.existsSync(target));
}

function git(args, cwd) {
  const result = spawnSync("git", ["--no-pager", ...args], {
    cwd, encoding: "utf8", maxBuffer: 2_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "git command failed").trim());
  return String(result.stdout || "").trim();
}

function realGitCommonDir(root) {
  const value = git(["rev-parse", "--git-common-dir"], root);
  return fs.realpathSync.native(path.resolve(root, value));
}

function realDirectory(value, name) {
  if (!path.isAbsolute(String(value || ""))) throw new Error(`${name} must be absolute`);
  const resolved = fs.realpathSync.native(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${name} must be a directory`);
  return resolved;
}

function bounded(value, max, required = false) {
  const text = String(value || "").trim();
  if ((required && !text) || text.includes("\0") || text.length > max) throw new Error("workspace text field is invalid");
  return text;
}

function validBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.startsWith("-") && !value.includes("\0");
}

function validIndex(value) {
  if (!value || value.version !== 1 || !value.workspaces || typeof value.workspaces !== "object" || Array.isArray(value.workspaces)) return false;
  return Object.entries(value.workspaces).every(([id, record]) => id === record?.id
    && /^ws_[a-f0-9]{16}$/.test(id)
    && record.version === 1
    && path.isAbsolute(record.repositoryPath || "")
    && path.isAbsolute(record.worktreePath || "")
    && /^[a-f0-9]{64}$/.test(record.repositoryIdentity || "")
    && /^[a-f0-9]{40,64}$/.test(record.baseHead || "")
    && Array.isArray(record.scope)
    && Array.isArray(record.processIds));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
