import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const TERMINAL = new Set(["completed", "merged", "closed", "abandoned"]);
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ID = /^task_[a-f0-9]{24}$/;

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

export function privateDirectory(directory) {
  const target = path.resolve(directory);
  // /tmp and macOS /var are system aliases; reject application-level symlinks.
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("registry symlink refused");
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(target);
  if (!st.isDirectory() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error("registry directory is not owner-only");
  return fs.realpathSync(target);
}

export function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function safeSummary(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\0\r\n]|(?:sk-|gh[pousr]_)[a-zA-Z0-9_-]{16}|-----BEGIN .*PRIVATE KEY/.test(value)) throw new Error(`invalid sanitized ${label}`);
  return value;
}

/** Single-controller registry. Task writes are synchronous atomic replacements;
 * the controller holds one OS listener for the complete request lifecycle.
 * This is durable task metadata, never a competing coordination authority. */
export class TaskRegistry {
  constructor(root) {
    this.root = privateDirectory(root);
    this.tasksRoot = privateDirectory(path.join(this.root, "tasks"));
    this.worktreesRoot = privateDirectory(path.join(this.root, "worktrees"));
  }

  file(id) {
    if (!ID.test(String(id))) throw new Error("invalid task identity");
    return path.join(this.tasksRoot, `${id}.json`);
  }

  get(id) {
    const file = this.file(id);
    if (!fs.existsSync(file)) throw new Error("task identity not found");
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error("unsafe task record");
    let task;
    try { task = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("corrupt task record; preserve and recover explicitly"); }
    if (task.version !== 1 || task.id !== id || task.worktree !== path.join(this.worktreesRoot, id) || !task.repository?.source || !task.branch?.startsWith("bridge/s7/")) throw new Error("corrupt task identity");
    return task;
  }

  list() { return fs.readdirSync(this.tasksRoot).filter((f) => /^task_[a-f0-9]{24}\.json$/.test(f)).map((f) => this.get(f.slice(0, -5))); }
  find({ project, repository, pr } = {}) {
    return this.list().filter((t) => t.lifecycle !== "retired" && (!project || t.project === project) && (!repository || t.repository.name === repository) && (!pr || t.pr?.number === pr));
  }

  update(id, changes) {
    const task = this.get(id);
    const allowed = new Set(["lifecycle", "lastActivity", "publishedRef", "publishedHead", "pr", "checks", "evidence", "coordinator", "baseSha", "headSha", "observedRemote", "processes", "authority"]);
    if (Object.keys(changes).some((k) => !allowed.has(k))) throw new Error("task identity is immutable");
    const result = { ...task, ...changes };
    atomicJson(this.file(id), result);
    return result;
  }

  async create({ repository, objective, project, authority = { merge: false, highImpact: [] } }) {
    safeSummary(objective, "objective"); safeSummary(project, "project");
    if (!repository || !Number.isSafeInteger(repository.id) || repository.id <= 0 || !/^[\w.-]+\/[\w.-]+$/.test(repository.name)) throw new Error("repository identity unavailable");
    const source = fs.realpathSync(repository.source);
    const remote = git(source, ["remote", "get-url", "origin"]);
    const baseBranch = repository.defaultBranch;
    git(source, ["check-ref-format", `refs/heads/${baseBranch}`]);
    git(source, ["fetch", "origin", `refs/heads/${baseBranch}`]);
    const baseSha = git(source, ["rev-parse", "FETCH_HEAD^{commit}"]);
    const id = `task_${crypto.randomBytes(12).toString("hex")}`;
    const branch = `bridge/s7/${id}`;
    const worktree = path.join(this.worktreesRoot, id);
    const task = {
      version: 1, id, project, objective, repository: { ...repository, source, remote }, worktree, branch,
      baseBranch, baseSha, headSha: baseSha, publishedHead: null, publishedRef: null, pr: null,
      authority, coordinator: null, checks: [], evidence: [], processes: [],
      lifecycle: "creating", createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    };
    // Journal ownership before Git creates anything; a crash preserves a visible
    // creating task for explicit recovery, never an unowned cleanup candidate.
    atomicJson(this.file(id), task);
    git(source, ["worktree", "add", "-b", branch, worktree, baseSha]);
    return this.update(id, { lifecycle: "active" });
  }

  inspect(id) {
    const task = this.get(id);
    if (task.lifecycle === "retired") return task;
    const st = fs.lstatSync(task.worktree);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(task.worktree) !== task.worktree) throw new Error("workspace identity mismatch");
    if (git(task.worktree, ["symbolic-ref", "--short", "HEAD"]) !== task.branch) throw new Error("workspace branch identity changed");
    if (git(task.worktree, ["remote", "get-url", "origin"]) !== task.repository.remote) throw new Error("workspace remote identity changed");
    const common = git(task.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (fs.realpathSync(common) !== fs.realpathSync(git(task.repository.source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))) throw new Error("workspace repository identity changed");
    return { ...task, headSha: git(task.worktree, ["rev-parse", "HEAD"]), status: git(task.worktree, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]) };
  }

  async resume(id) {
    const task = this.inspect(id);
    if (task.lifecycle === "retired") throw new Error("workspace retired; recover from the recorded remote ref");
    git(task.worktree, ["fetch", "origin", `refs/heads/${task.baseBranch}`]);
    const base = git(task.worktree, ["rev-parse", "FETCH_HEAD^{commit}"]);
    let publishedHead = null;
    if (task.publishedRef) publishedHead = git(task.worktree, ["ls-remote", "--exit-code", "origin", task.publishedRef]).split(/\s/)[0];
    const moved = base !== task.baseSha || publishedHead !== task.publishedHead;
    return this.update(id, { lifecycle: moved ? "stale" : "active", lastActivity: new Date().toISOString(), headSha: task.headSha, observedRemote: { base, publishedHead } });
  }

  async retire(id, { automatic = false, now = Date.now() } = {}) {
    const task = this.inspect(id);
    if (task.lifecycle === "retired") return task;
    if (!TERMINAL.has(task.lifecycle)) throw new Error("only completed tasks can retire; active work retained");
    if (automatic && now - Date.parse(task.lastActivity) < RETENTION_MS) throw new Error("14-day retention not reached");
    if (task.status) throw new Error("dirty/untracked/ignored work retained");
    if (task.processes.some((p) => p.state === "running")) throw new Error("task processes must stop before retirement");
    let recoverable = false;
    for (const ref of [task.publishedRef, `refs/heads/${task.baseBranch}`].filter(Boolean)) {
      git(task.worktree, ["check-ref-format", ref]);
      try {
        git(task.worktree, ["fetch", "origin", ref]);
        git(task.worktree, ["merge-base", "--is-ancestor", task.headSha, "FETCH_HEAD"]);
        recoverable = true; break;
      } catch { /* A missing or moved ref does not establish recoverability. */ }
    }
    if (!recoverable) throw new Error("task commits are not recoverable from a verified remote ref");
    // Git's non-force removal is a second dirty/ownership check. Keep branch and
    // metadata, including remote evidence, so retirement remains recoverable.
    git(task.repository.source, ["worktree", "remove", task.worktree]);
    return this.update(id, { lifecycle: "retired", evidence: [...task.evidence, { action: "retire", headSha: task.headSha, at: new Date(now).toISOString() }] });
  }
}
