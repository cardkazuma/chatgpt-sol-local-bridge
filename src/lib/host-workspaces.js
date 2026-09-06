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
    git(["check-ref-format", "--branch", branch], source);
    if (!Array.isArray(scope) || scope.length > 100 || scope.some((item) => typeof item !== "string" || item.length > 500)) throw new Error("workspace scope is invalid");
    const normalizedObjective = bounded(objective, 2_000, true);
    const normalizedProject = bounded(project, 200);
    const normalizedScope = scope.map((item) => bounded(item, 500));
    const normalizedBase = bounded(base, 200, true);
    const baseHead = git(["rev-parse", "--verify", `${normalizedBase}^{commit}`], source);
    const index = this.#read();
    const id = `ws_${crypto.randomBytes(8).toString("hex")}`;
    const target = path.join(this.worktreeRoot, id);
    fs.mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.worktreeRoot, 0o700);
    git(["worktree", "add", target, "-b", branch, baseHead], source);
    const now = new Date().toISOString();
    const record = {
      id,
      version: 1,
      kind: "worktree",
      project: normalizedProject,
      objective: normalizedObjective,
      scope: normalizedScope,
      repositoryPath: source,
      repositoryIdentity: sha256(realGitCommonDir(source)),
      worktreePath: fs.realpathSync.native(target),
      branch,
      baseRef: normalizedBase,
      baseHead,
      observedHead: baseHead,
      pr: null,
      checkpoint: null,
      processIds: [],
      createdAt: now,
      updatedAt: now,
    };
    index.workspaces[id] = record;
    this.#write(index);
    return record;
  }

  attach({ directoryPath, objective, project = "", scope = [] } = {}) {
    const selected = realDirectory(directoryPath, "directoryPath");
    if (!Array.isArray(scope) || scope.length > 100 || scope.some((item) => typeof item !== "string" || item.length > 500)) throw new Error("workspace scope is invalid");
    const normalizedObjective = bounded(objective, 2_000, true);
    const normalizedProject = bounded(project, 200);
    const normalizedScope = scope.map((item) => bounded(item, 500));
    const index = this.#read();
    const gitState = inspectAttachedDirectory(selected);
    const repositoryPath = gitState.repository ? gitState.repositoryPath : selected;
    const repositoryIdentity = gitState.repository ? sha256(realGitCommonDir(selected)) : sha256(selected);
    const id = `ws_${crypto.randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    const record = {
      id,
      version: 1,
      kind: "attached",
      project: normalizedProject,
      objective: normalizedObjective,
      scope: normalizedScope,
      repositoryPath,
      repositoryIdentity,
      worktreePath: selected,
      branch: gitState.branch || "",
      baseRef: gitState.head || "",
      baseHead: gitState.head || null,
      observedHead: gitState.head || null,
      pr: null,
      checkpoint: null,
      processIds: [],
      createdAt: now,
      updatedAt: now,
    };
    index.workspaces[id] = record;
    this.#write(index);
    return { ...record, git: publicGitState(gitState), instructionFiles: instructionFiles(selected) };
  }

  attachBranch({ repositoryPath, branch, expectedHead, remote = "", objective, project = "", scope = [] } = {}) {
    const source = realDirectory(repositoryPath, "repositoryPath");
    git(["rev-parse", "--git-dir"], source);
    if (!validBranch(branch)) throw new Error("workspace branch is invalid");
    git(["check-ref-format", "--branch", branch], source);
    const normalizedExpectedHead = String(expectedHead || "").toLowerCase();
    if (!/^[a-f0-9]{40,64}$/.test(normalizedExpectedHead)) throw new Error("workspace expectedHead is invalid");
    if (remote && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(remote)) throw new Error("workspace remote name is invalid");
    if (!Array.isArray(scope) || scope.length > 100 || scope.some((item) => typeof item !== "string" || item.length > 500)) throw new Error("workspace scope is invalid");
    const normalizedObjective = bounded(objective, 2_000, true);
    const normalizedProject = bounded(project, 200);
    const normalizedScope = scope.map((item) => bounded(item, 500));
    const index = this.#read();
    const repositoryPathResolved = fs.realpathSync.native(git(["rev-parse", "--show-toplevel"], source));
    const repositoryIdentity = sha256(realGitCommonDir(source));

    if (remote) verifyRemoteHead(source, remote, branch, normalizedExpectedHead);
    const prior = Object.values(index.workspaces).find((record) => record.repositoryIdentity === repositoryIdentity
      && record.requestedBranch === branch && record.expectedHead === normalizedExpectedHead && (record.remote || "") === remote);
    if (prior) {
      const gitState = inspectRecord(prior);
      if (gitState.head !== normalizedExpectedHead) throw new Error("workspace expected-head mismatch for the previously attached branch");
      return { ...prior, git: publicGitState(gitState), instructionFiles: instructionFiles(prior.worktreePath) };
    }

    const checkedOut = worktreeRecords(source).find((record) => record.branch === `refs/heads/${branch}`);
    if (checkedOut && checkedOut.head !== normalizedExpectedHead) throw new Error("workspace expected-head mismatch for the existing branch worktree");
    const localHead = optionalGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], source);
    if (localHead && localHead !== normalizedExpectedHead) throw new Error("workspace expected-head mismatch for the existing local branch");
    if (!checkedOut && !localHead && !remote) throw new Error("existing local branch is unavailable; provide a remote name for exact remote verification");

    const id = `ws_${crypto.randomBytes(8).toString("hex")}`;
    let target;
    let kind;
    let managedWorktree;
    if (checkedOut) {
      target = realDirectory(checkedOut.path, "existing branch worktree");
      kind = "existing-branch";
      managedWorktree = false;
    } else {
      target = path.join(this.worktreeRoot, id);
      fs.mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.worktreeRoot, 0o700);
      if (localHead) {
        git(["worktree", "add", target, branch], source);
        kind = "existing-branch";
      } else {
        if (optionalGit(["rev-parse", "--verify", `${normalizedExpectedHead}^{commit}`], source) !== normalizedExpectedHead) {
          fixedGit(["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${branch}`], source, "exact remote branch could not be fetched");
        }
        if (optionalGit(["rev-parse", "--verify", `${normalizedExpectedHead}^{commit}`], source) !== normalizedExpectedHead) {
          throw new Error("verified remote branch head is unavailable locally");
        }
        git(["worktree", "add", "--detach", target, normalizedExpectedHead], source);
        kind = "remote-branch";
      }
      managedWorktree = true;
      target = fs.realpathSync.native(target);
    }

    const gitState = inspectAttachedDirectory(target);
    if (!gitState.repository || gitState.head !== normalizedExpectedHead) throw new Error("workspace expected-head mismatch after branch attachment");
    const now = new Date().toISOString();
    const record = {
      id,
      version: 1,
      kind,
      managedWorktree,
      project: normalizedProject,
      objective: normalizedObjective,
      scope: normalizedScope,
      repositoryPath: repositoryPathResolved,
      repositoryIdentity,
      worktreePath: target,
      branch: gitState.branch || "",
      requestedBranch: branch,
      remote,
      expectedHead: normalizedExpectedHead,
      baseRef: remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`,
      baseHead: normalizedExpectedHead,
      observedHead: normalizedExpectedHead,
      pr: null,
      checkpoint: null,
      processIds: [],
      createdAt: now,
      updatedAt: now,
    };
    index.workspaces[id] = record;
    this.#write(index);
    return { ...record, git: publicGitState(gitState), instructionFiles: instructionFiles(target) };
  }

  resume(id) {
    const index = this.#read();
    const record = index.workspaces[id];
    if (!record) throw new Error(`unknown host workspace ${id}`);
    const gitState = inspectRecord(record);
    record.observedHead = gitState.head || null;
    record.updatedAt = new Date().toISOString();
    this.#write(index);
    return { ...record, git: publicGitState(gitState), instructionFiles: instructionFiles(record.worktreePath) };
  }

  status(id) {
    const record = this.get(id);
    return { ...record, git: publicGitState(inspectRecord(record)), instructionFiles: instructionFiles(record.worktreePath) };
  }

  checkpoint(id, { summary, pr = undefined, processIds = undefined } = {}) {
    const index = this.#read();
    const record = index.workspaces[id];
    if (!record) throw new Error(`unknown host workspace ${id}`);
    if (pr !== undefined && pr !== null && (!Number.isInteger(pr) || pr <= 0)) throw new Error("workspace PR must be a positive integer");
    if (processIds !== undefined && (!Array.isArray(processIds) || processIds.some((value) => !/^p_[A-Za-z0-9_]+$/.test(value)))) throw new Error("workspace process references are invalid");
    const gitState = inspectRecord(record);
    record.observedHead = gitState.head || null;
    if (pr !== undefined) record.pr = pr;
    if (processIds !== undefined) record.processIds = [...new Set(processIds)];
    record.checkpoint = { summary: bounded(summary, 2_000, true), at: new Date().toISOString(), head: gitState.head || null };
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
    if (!fs.existsSync(this.stateFile)) {
      if (this.recoverCandidates().length > 0) {
        throw new WorkspaceIndexCorruptError(`workspace index is missing while recoverable work exists; use workspace_recover for read-only candidates`);
      }
      return { version: 1, workspaces: {} };
    }
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

function inspectAttachedDirectory(root) {
  if (!fs.statSync(root).isDirectory()) throw new Error(`workspace directory is unavailable: ${root}`);
  const topLevel = optionalGit(["rev-parse", "--show-toplevel"], root);
  if (!topLevel) return { repository: false };
  const repositoryPath = fs.realpathSync.native(topLevel);
  if (repositoryPath !== fs.realpathSync.native(root)) return { repository: false };
  const head = optionalGit(["rev-parse", "HEAD"], root);
  const branch = optionalGit(["branch", "--show-current"], root) || "";
  const status = git(["status", "--short", "--branch"], root);
  return {
    repository: true,
    repositoryPath,
    head,
    branch,
    dirty: status.split("\n").slice(1).some(Boolean),
    status: status.split("\n").filter(Boolean).slice(0, 100),
  };
}

function inspectRecord(record) {
  return record.kind === "attached" ? inspectAttachedDirectory(record.worktreePath) : inspectGit(record.worktreePath);
}

function publicGitState(state) {
  if (state.repository === false) return { repository: false };
  return { repository: true, head: state.head, branch: state.branch, dirty: state.dirty, status: state.status };
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

function optionalGit(args, cwd) {
  const result = spawnSync("git", ["--no-pager", ...args], {
    cwd, encoding: "utf8", maxBuffer: 2_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

function fixedGit(args, cwd, failureMessage) {
  const result = spawnSync("git", ["--no-pager", ...args], {
    cwd, encoding: "utf8", maxBuffer: 2_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(failureMessage);
  return String(result.stdout || "").trim();
}

function verifyRemoteHead(root, remote, branch, expectedHead) {
  const value = fixedGit(["ls-remote", "--heads", "--exit-code", remote, `refs/heads/${branch}`], root, "existing remote branch is unavailable");
  const remoteHead = value.split(/\s+/, 1)[0]?.toLowerCase();
  if (remoteHead !== expectedHead) throw new Error("workspace expected-head mismatch for the existing remote branch");
}

function worktreeRecords(root) {
  const fields = git(["worktree", "list", "--porcelain", "-z"], root).split("\0");
  const records = [];
  let record = {};
  for (const field of fields) {
    if (!field) {
      if (record.path) records.push(record);
      record = {};
    } else if (field.startsWith("worktree ")) record.path = field.slice(9);
    else if (field.startsWith("HEAD ")) record.head = field.slice(5).toLowerCase();
    else if (field.startsWith("branch ")) record.branch = field.slice(7);
  }
  if (record.path) records.push(record);
  return records;
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
    && Array.isArray(record.scope)
    && Array.isArray(record.processIds)
    && validWorkspaceKind(record));
}

function validWorkspaceKind(record) {
  if (!record.kind || record.kind === "worktree") {
    return /^[a-f0-9]{40,64}$/.test(record.baseHead || "");
  }
  const common = ["attached", "existing-branch", "remote-branch"].includes(record.kind)
    && typeof record.branch === "string"
    && typeof record.baseRef === "string"
    && (record.baseHead === null || /^[a-f0-9]{40,64}$/.test(record.baseHead || ""))
    && (record.observedHead === null || /^[a-f0-9]{40,64}$/.test(record.observedHead || ""));
  if (!common || record.kind === "attached") return common;
  return typeof record.managedWorktree === "boolean"
    && validBranch(record.requestedBranch)
    && /^[a-f0-9]{40,64}$/.test(record.expectedHead || "")
    && typeof record.remote === "string"
    && (record.kind !== "remote-branch" || (record.managedWorktree && record.remote.length > 0));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
