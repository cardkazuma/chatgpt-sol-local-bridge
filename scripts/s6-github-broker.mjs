#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withS6GitCredentialHelper } from "./s6-credential.mjs";
import {
  classifyPolicyPath,
  classifyPublishPath,
  isHighRiskGovernancePath,
  normalizeRepositoryName,
} from "./pre-commit-policy.mjs";
import {
  REVIEWED_POLICY_SHA256,
  S6_REVIEWED_HOOK_SOURCE,
} from "../src/lib/git-governance.js";

export const S6_REPOSITORY_ALIAS = "homelab";
export const S6_REPOSITORY_URL = "https://github.com/cardkazuma/homelab.git";
export const S6_REMOTE_NAME = "origin";
export const S6_BRANCH_PREFIX = "bridge/s6";
export const S6_REMOTE_REF_PREFIX = "refs/heads/bridge/s6/";
export const S6_GOVERNANCE_HOOKS_PATH = "/bridge-governance/hooks";
export const S6_GOVERNANCE_POLICY_PATH = "/bridge-governance/pre-commit-policy.mjs";
export const S6_STANDARD_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
export const S6_CANONICAL_PLACEHOLDER_PATHS = Object.freeze(["paperless/secrets/decrypt-passwords.txt.example"]);
const SHA = /^[0-9a-f]{40}$/;
const SESSION = /^s6-[a-z0-9]+-[0-9a-f]{16}$/;
const BRANCH = /^bridge\/s6\/s6-[a-z0-9]+-[0-9a-f]{16}$/;
const REMOTE_REF = /^refs\/heads\/bridge\/s6\/s6-[a-z0-9]+-[0-9a-f]{16}$/;
const TOKEN_LIKE = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|Bearer\s+\S+|password[=:]\S+)/gi;

export function assertS6RepositoryAlias(alias = S6_REPOSITORY_ALIAS) {
  if (alias !== S6_REPOSITORY_ALIAS) throw new Error("S6 supports only the homelab repository alias");
  return S6_REPOSITORY_URL;
}

export function assertS6Source(source) {
  if (source !== S6_REPOSITORY_URL) throw new Error("S6 source is fixed to the canonical homelab GitHub repository");
  return source;
}

export function s6BranchForSession(sessionId) {
  assertSessionId(sessionId);
  return `${S6_BRANCH_PREFIX}/${sessionId}`;
}

export function s6RemoteRefForSession(sessionId) {
  assertSessionId(sessionId);
  return `${S6_REMOTE_REF_PREFIX}${sessionId}`;
}

export function s6BrokerSocketPath(managerRoot, sessionId) {
  assertSessionId(sessionId);
  if (!managerRoot || !path.isAbsolute(managerRoot)) throw new Error("S6 broker manager root must be absolute");
  const suffix = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  // Mount a session-unique, socket-only channel directory into the non-root
  // bridge container. The short hashed component stays within macOS sockaddr
  // limits; the broker capability and fixed protocol remain the authority.
  return path.join(path.resolve(managerRoot), `b${suffix.slice(0, 10)}`, "publish.sock");
}

export class S6GitHubBroker {
  constructor({
    managerRoot,
    bridgeRoot,
    sessionId,
    platform = process.platform,
    ghCommand,
    ghRealpath,
    ghSha256,
    ghVersion,
    ghConfigDir,
    developerHome,
    securityBin,
    credentialExpectedUid,
    securityExpectedUid,
    credentialRunner = withS6GitCredentialHelper,
    gitRunner = null,
    remoteAdapter = null,
  } = {}) {
    if (!managerRoot || !path.isAbsolute(managerRoot)) throw new Error("S6 broker manager root must be absolute");
    if (!bridgeRoot || !path.isAbsolute(bridgeRoot)) throw new Error("S6 broker bridge root must be absolute");
    assertSessionId(sessionId);
    this.managerRoot = path.resolve(managerRoot);
    this.bridgeRoot = path.resolve(bridgeRoot);
    this.sessionId = sessionId;
    this.platform = platform;
    this.ghCommand = ghCommand;
    this.ghRealpath = ghRealpath;
    this.ghSha256 = ghSha256;
    this.ghVersion = ghVersion;
    this.ghConfigDir = ghConfigDir;
    this.developerHome = developerHome;
    this.securityBin = securityBin;
    this.credentialExpectedUid = credentialExpectedUid;
    this.securityExpectedUid = securityExpectedUid;
    this.credentialRunner = credentialRunner;
    this.gitRunner = gitRunner;
    this.remoteAdapter = remoteAdapter;
    this.sessionsRoot = path.join(this.managerRoot, "sessions");
    this.stateRoot = path.join(this.managerRoot, "manager-state");
    this.governanceRoot = path.join(this.managerRoot, "governance");
    this.gitHome = path.join(this.managerRoot, "git-home");
    this.brokerHooksRoot = path.join(this.managerRoot, "broker-empty-hooks");
    this.brokerTemplateRoot = path.join(this.managerRoot, "broker-empty-template");
    this.attestedShas = new Set();
    assertSafeBrokerRoot(this.managerRoot);
    this.ensureGitIsolationRoots();
    assertS6RepositoryAlias();
  }

  source() { return S6_REPOSITORY_URL; }
  repositoryAlias() { return S6_REPOSITORY_ALIAS; }

  ensureGitIsolationRoots() {
    ensurePrivateEmptyDirectory(this.brokerHooksRoot, "S6 broker hook directory");
    ensurePrivateEmptyDirectory(this.brokerTemplateRoot, "S6 broker template directory");
  }

  /**
   * Controller-owned materialization callback for DisposableWorkspaceManager.
   * The only networked operation is a no-checkout clone of the fixed URL while
   * Git may delegate to the fixed trusted helper. Candidate content is not
   * checked out until that credentialed Git subprocess has exited.
   */
  materializeWorkspace({ source, remoteName, workspacePath, sessionId, managerRoot } = {}) {
    assertS6Source(source);
    if (remoteName !== S6_REMOTE_NAME) throw new Error("S6 source remote must be origin");
    assertSessionId(sessionId);
    if (path.resolve(managerRoot || "") !== this.managerRoot || path.resolve(workspacePath || "") !== this.workspacePath(sessionId)) {
      throw new Error("S6 materialization path is not manager-owned");
    }
    const state = this.readWorkspaceState(sessionId);
    if (state.state !== "provisioning" || state.branch !== s6BranchForSession(sessionId) || state.source !== S6_REPOSITORY_URL) {
      throw new Error("S6 workspace is not in the expected provisioning state");
    }
    ensureNoSymlinkAncestors(this.managerRoot);
    ensureParentPath(workspacePath, this.sessionsRoot);
    this.withCredential(({ credentialHelper }) => {
      this.gitResult([
        "clone", "--no-checkout", "--no-local", "--no-hardlinks", "--origin", S6_REMOTE_NAME,
        S6_REPOSITORY_URL, workspacePath,
      ], this.managerRoot, { credentialHelper });
    });
    this.validateClone(workspacePath);
    const base = this.gitOutput(["rev-parse", "--verify", "refs/remotes/origin/main"], workspacePath).trim();
    assertSha(base, "canonical base commit");
    this.gitResult(["checkout", "--detach", "--no-recurse-submodules", base], workspacePath);
    this.validateTree(workspacePath, { publish: false });
    return { expectedBaseCommit: base, sourceCommit: base };
  }

  /**
   * Called by the bridge only after a successful structured git_commit. The
   * broker rechecks the current branch, graph, and policy before remembering
   * the SHA; a repo_shell --no-verify commit never enters this set.
   */
  attestCommit(sha) {
    assertSha(sha, "commit attestation");
    const validation = this.validateLocalPublishState({ requireAttestations: false });
    if (validation.head !== sha) throw new Error("only the current S6 branch HEAD may be attested");
    this.attestedShas.add(sha);
    return { attested: true, commit: sha };
  }

  async publishBranch() {
    const validation = this.validateLocalPublishState({ requireAttestations: true });
    const { record, head, base, commits } = validation;
    if (!commits.length) throw new Error("S6 publish requires at least one reviewed local commit beyond the expected base");
    const ref = s6RemoteRefForSession(this.sessionId);
    const publishState = this.readPublishState();
    return this.withCredential(({ credentialHelper }) => {
      const remoteBefore = this.readRemoteRef(record.workspacePath, ref, { credentialHelper });
      const prior = publishState?.state === "publishing" ? (publishState.priorSha || null) : (publishState?.publishedSha || null);
      if (publishState?.state === "publishing") {
        if (![prior, publishState.targetSha].includes(remoteBefore)) {
          throw new Error("unexpected remote movement during S6 publish recovery");
        }
        if (remoteBefore === publishState.targetSha) {
          if (publishState.targetSha !== head) throw new Error("pending S6 publish target differs from local HEAD");
          this.writePublishedState(head, base, "published");
          return publishEvidence(this.sessionId, head, base, ref, "recovered");
        }
      }
      if (prior && remoteBefore !== prior) throw new Error("unexpected remote movement on the S6 branch");
      if (!prior && remoteBefore !== null) throw new Error("S6 branch already exists and is not owned by this session");
      if (prior && !this.isAncestor(prior, head, record.workspacePath)) throw new Error("S6 publish is not a fast-forward");
      if (prior === head) return publishEvidence(this.sessionId, head, base, ref, "already-published");

      this.writePublishedState(head, base, "publishing", { priorSha: prior });
      const pushed = this.pushRemote(record.workspacePath, ref, { credentialHelper });
      if (pushed.oldSha !== prior || pushed.newSha !== head) {
        throw new Error("S6 push receipt did not match the recorded remote state");
      }
      const remoteAfter = this.readRemoteRef(record.workspacePath, ref, { credentialHelper });
      if (remoteAfter !== head) throw new Error("S6 remote read-back did not match local HEAD");
      this.writePublishedState(head, base, "published", { priorSha: prior });
      return publishEvidence(this.sessionId, head, base, ref, "published");
    });
  }

  recoverPublish() {
    const state = this.readPublishState();
    if (!state || state.state !== "publishing") return { recovered: false, state: state?.state || "none" };
    const validation = this.validateLocalPublishState({ requireAttestations: true });
    return this.withCredential(({ credentialHelper }) => {
      const remote = this.readRemoteRef(validation.record.workspacePath, state.remoteRef, { credentialHelper });
      if (remote === state.targetSha && state.targetSha === validation.head) {
        this.writePublishedState(state.targetSha, validation.base, "published", { priorSha: state.priorSha || null });
        return { recovered: true, state: "published", commit: state.targetSha };
      }
      if (remote !== (state.priorSha || null)) throw new Error("cannot recover S6 publish after unexpected remote movement");
      fs.rmSync(this.publishStatePath(), { force: true });
      return { recovered: true, state: "ready" };
    });
  }

  validateLocalPublishState({ requireAttestations = true } = {}) {
    const record = this.readWorkspaceState(this.sessionId);
    if (record.state !== "active") throw new Error("S6 manager session is not active");
    if (record.source !== S6_REPOSITORY_URL) throw new Error("S6 session source is not canonical homelab");
    if (record.branch !== s6BranchForSession(this.sessionId) || !BRANCH.test(record.branch)) throw new Error("S6 local branch is not the generated bridge branch");
    if (path.resolve(record.workspacePath) !== this.workspacePath(this.sessionId)) throw new Error("S6 workspace path is not manager-owned");
    if (path.resolve(record.statePath) !== path.join(this.stateRoot, `${this.sessionId}.json`)) throw new Error("S6 state path is not manager-owned");
    if (!SHA.test(record.expectedBaseCommit || "")) throw new Error("S6 expected canonical base is missing");
    if (record.coreHooksPath !== S6_GOVERNANCE_HOOKS_PATH) throw new Error("S6 reviewed external governance is not active");
    this.validateManagerGovernance(record);
    this.validateWorkspaceIdentity(record.workspacePath, record.branch);
    const base = record.expectedBaseCommit;
    const head = this.gitOutput(["rev-parse", "HEAD"], record.workspacePath).trim();
    assertSha(head, "S6 local HEAD");
    if (!this.isAncestor(base, head, record.workspacePath)) throw new Error("S6 local HEAD is not a descendant of the recorded base");
    this.restorePublishedAttestations(record, base, head);
    const commits = this.graphCommits(record.workspacePath, base, head);
    if (requireAttestations) {
      for (const sha of commits) if (!this.attestedShas.has(sha)) throw new Error("S6 publish requires every unpublished commit to have a structured-commit attestation");
    }
    this.validateTree(record.workspacePath, { publish: true });
    const changed = this.changedPaths(record.workspacePath, base, head);
    for (const name of changed) {
      this.assertPublishPath(record.workspacePath, name);
    }
    for (const sha of commits) {
      for (const name of this.commitChangedPaths(record.workspacePath, sha)) {
        this.assertPublishPath(record.workspacePath, name);
      }
    }
    return { record, base, head, commits, changed };
  }

  assertPublishPath(workspacePath, name) {
    const decision = classifyPublishPath(name);
    if (!decision.allowed) throw new Error(`${decision.reason}: ${name}`);
    const ignored = this.gitStatus(["check-ignore", "--no-index", "--quiet", "--", name], workspacePath);
    if (ignored.status === 0) throw new Error(`S6 publish refuses repository-ignored path: ${name}`);
    if (ignored.status !== 1) throw new Error(`S6 could not verify ignored state for publish path: ${name}`);
  }

  restorePublishedAttestations(record, base, head) {
    const state = this.readPublishState();
    if (!state) return;
    const trustedTarget = state.state === "published" ? state.publishedSha : state.targetSha;
    if (!SHA.test(trustedTarget || "") || !this.isAncestor(base, trustedTarget, record.workspacePath) || !this.isAncestor(trustedTarget, head, record.workspacePath)) return;
    for (const sha of this.graphCommits(record.workspacePath, base, trustedTarget)) this.attestedShas.add(sha);
  }

  validateWorkspaceIdentity(workspacePath, branch) {
    if (!fs.existsSync(workspacePath) || fs.realpathSync(workspacePath) !== fs.realpathSync(path.resolve(workspacePath))) throw new Error("S6 workspace is not a real manager-owned directory");
    const gitDir = path.join(workspacePath, ".git");
    const gitStat = fs.lstatSync(gitDir);
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error("S6 workspace Git directory is not a real directory");
    if (this.gitOutput(["branch", "--show-current"], workspacePath).trim() !== branch) throw new Error("S6 HEAD is not attached to the generated branch");
    if (this.gitOutput(["rev-parse", "--is-shallow-repository"], workspacePath).trim() !== "false") throw new Error("S6 workspace is shallow");
    if (this.gitOutput(["remote"], workspacePath).trim().split(/\r?\n/).filter(Boolean).join("\n") !== S6_REMOTE_NAME) throw new Error("S6 workspace has an unexpected remote");
    const urls = this.gitOutput(["config", "--local", "--get-all", `remote.${S6_REMOTE_NAME}.url`], workspacePath).trim().split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1 || urls[0] !== S6_REPOSITORY_URL) throw new Error("S6 origin is not the single fixed canonical URL");
    if (this.gitStatus(["config", "--local", "--get-all", `remote.${S6_REMOTE_NAME}.pushurl`], workspacePath).status === 0) throw new Error("S6 origin pushurl is not allowed");
    const fetch = this.gitOutput(["config", "--local", "--get-all", `remote.${S6_REMOTE_NAME}.fetch`], workspacePath).trim().split(/\r?\n/).filter(Boolean);
    if (fetch.length !== 1 || fetch[0] !== S6_STANDARD_FETCH_REFSPEC) throw new Error("S6 origin fetch refspec is not the standard clone refspec");
    const hookPath = this.gitOutput(["config", "--local", "--get", "core.hooksPath"], workspacePath, { disableHooks: false }).trim();
    if (hookPath !== S6_GOVERNANCE_HOOKS_PATH) throw new Error("S6 core.hooksPath is not the manager-mounted reviewed hook path");
    const keys = this.gitOutput(["config", "--local", "--name-only", "--list"], workspacePath).split(/\r?\n/).filter(Boolean);
    for (const key of keys) {
      if (/^(?:alias\.|credential\.|url\.|include|submodule\.|filter\.|http\.|protocol\.|diff\.|difftool\.|mergetool\.|core\.(?:sshCommand|gitProxy|askPass|attributesFile|fsmonitor|fsmonitorHook)|remote\.(?!origin\.(?:url|fetch)$)|remote\.origin\.pushurl)/i.test(key)) {
        throw new Error(`S6 repository-controlled Git config is not allowed: ${key}`);
      }
    }
    const status = this.gitOutput(["status", "--porcelain=v1", "--ignored", "--untracked-files=all"], workspacePath);
    if (status.trim()) throw new Error("S6 publish requires a clean worktree, index, and ignored set");
  }

  validateManagerGovernance(record) {
    const root = path.resolve(record.governanceHostRoot || "");
    if (!root || !isWithin(root, this.governanceRoot) || !path.basename(root).startsWith(`${this.sessionId}-`) || !/^[0-9a-f]{16}$/.test(path.basename(root).slice(this.sessionId.length + 1))) {
      throw new Error("S6 external governance root is not manager-owned");
    }
    const hook = path.join(root, "hooks", "pre-commit");
    const policy = path.join(root, "pre-commit-policy.mjs");
    for (const target of [hook, policy]) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || (target === hook && (stat.mode & 0o111) === 0)) throw new Error("S6 external governance file is not immutable and reviewed");
    }
    if (fs.readFileSync(hook, "utf8") !== S6_REVIEWED_HOOK_SOURCE) throw new Error("S6 external hook changed");
    if (sha256(policy) !== REVIEWED_POLICY_SHA256) throw new Error("S6 external policy helper changed");
  }

  validateTree(workspacePath, { publish = false } = {}) {
    const entries = this.treeEntries(workspacePath);
    for (const entry of entries) {
      if (entry.mode === "120000" || entry.type === "blob" && entry.mode === "120000") throw new Error(`S6 refuses symlink tree entry: ${entry.name}`);
      if (entry.mode === "160000" || entry.type === "commit") throw new Error(`S6 refuses submodule tree entry: ${entry.name}`);
      const normalized = normalizeRepositoryName(entry.name);
      if (!normalized) throw new Error(`S6 refuses invalid tree path: ${entry.name}`);
      if (publish && isHighRiskGovernancePath(normalized)) {
        // High-risk paths are rejected by the unpublished diff check. This
        // branch documents that the existing base may contain them safely.
        continue;
      }
      const decision = classifyPolicyPath(normalized);
      if (!decision.allowed && !S6_CANONICAL_PLACEHOLDER_PATHS.includes(normalized)) throw new Error(`${decision.reason}: ${normalized}`);
      const absolute = path.join(workspacePath, normalized);
      if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`S6 refuses working-tree symlink: ${normalized}`);
    }
  }

  treeEntries(workspacePath) {
    const raw = this.gitOutput(["ls-tree", "-r", "-z", "HEAD"], workspacePath);
    return raw.split("\0").filter(Boolean).map((line) => {
      const match = line.match(/^([0-9]+)\s+(\w+)\s+([0-9a-f]{40})\t([\s\S]*)$/);
      if (!match) throw new Error("S6 tree entry format is invalid");
      return { mode: match[1], type: match[2], object: match[3], name: match[4] };
    });
  }

  graphCommits(workspacePath, base, head) {
    const rows = this.gitOutput(["rev-list", "--parents", `${base}..${head}`], workspacePath).split(/\r?\n/).filter(Boolean);
    const commits = [];
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (!SHA.test(fields[0])) throw new Error("S6 commit graph contains an invalid object");
      if (fields.length !== 2) throw new Error("S6 rejects merge commits; publish history must be linear");
      commits.push(fields[0]);
    }
    return commits;
  }

  changedPaths(workspacePath, base, head) {
    return this.gitOutput(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", `${base}..${head}`], workspacePath).split("\0").filter(Boolean);
  }

  commitChangedPaths(workspacePath, sha) {
    return this.gitOutput(["diff-tree", "--no-ext-diff", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha], workspacePath).split("\0").filter(Boolean);
  }

  isAncestor(ancestor, descendant, workspacePath) {
    assertSha(ancestor, "ancestor");
    assertSha(descendant, "descendant");
    return this.gitStatus(["merge-base", "--is-ancestor", ancestor, descendant], workspacePath).status === 0;
  }

  readRemoteRef(workspacePath, ref, credential = {}) {
    assertRemoteRef(ref, this.sessionId);
    if (this.remoteAdapter?.lsRemote) {
      const value = this.remoteAdapter.lsRemote({ repository: S6_REPOSITORY_ALIAS, remote: S6_REMOTE_NAME, ref, url: S6_REPOSITORY_URL });
      return value == null || value === "" ? null : assertSha(String(value), "remote SHA");
    }
    const result = this.gitResult(["ls-remote", "--heads", S6_REMOTE_NAME, ref], workspacePath, credential);
    const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    if (lines.length !== 1) throw new Error("S6 remote returned an ambiguous branch result");
    const match = lines[0].match(/^([0-9a-f]{40})\s+(.+)$/);
    if (!match || match[2] !== ref) throw new Error("S6 remote returned an unexpected branch identity");
    return match[1];
  }

  pushRemote(workspacePath, ref, credential = {}) {
    assertRemoteRef(ref, this.sessionId);
    if (this.remoteAdapter?.push) {
      const receipt = this.remoteAdapter.push({ repository: S6_REPOSITORY_ALIAS, remote: S6_REMOTE_NAME, ref, head: this.gitOutput(["rev-parse", "HEAD"], workspacePath).trim(), url: S6_REPOSITORY_URL });
      return normalizePushReceipt(receipt);
    }
    const result = this.gitResult(["push", "--porcelain", S6_REMOTE_NAME, `HEAD:${ref}`], workspacePath, credential);
    const receipt = parsePushReceipt(`${result.stdout || ""}\n${result.stderr || ""}`, ref);
    return { ...receipt, newSha: receipt.newSha || this.gitOutput(["rev-parse", "HEAD"], workspacePath).trim() };
  }

  withCredential(callback) {
    return this.credentialRunner({
      managerRoot: this.managerRoot,
      ghCommand: this.ghCommand,
      expectedRealpath: this.ghRealpath,
      expectedSha256: this.ghSha256,
      expectedVersion: this.ghVersion,
      ghConfigDir: this.ghConfigDir,
      expectedHome: this.developerHome,
      securityBin: this.securityBin,
      platform: this.platform,
      expectedUid: this.credentialExpectedUid,
      securityExpectedUid: this.securityExpectedUid,
    }, ({ helperBin }) => {
      if (!path.isAbsolute(helperBin)) throw new Error("trusted S6 Git credential helper path is invalid");
      return callback({ credentialHelper: helperBin });
    });
  }

  gitEnvironment() {
    this.ensureGitIsolationRoots();
    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: this.gitHome,
      XDG_CONFIG_HOME: path.join(this.gitHome, "config"),
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      GIT_SSH_COMMAND: "/usr/bin/false",
      GIT_TEMPLATE_DIR: this.brokerTemplateRoot,
      GIT_OPTIONAL_LOCKS: "0",
    };
    return env;
  }

  gitStatus(args, cwd, options = {}) {
    const result = this.gitRunner
      ? this.gitRunner(args, cwd, this.gitEnvironment(options))
      : spawnSync("git", gitArgs(args, cwd, { ...options, hooksPath: this.brokerHooksRoot }), { cwd, env: this.gitEnvironment(options), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return result;
  }

  gitResult(args, cwd, credential = {}) {
    const result = this.gitStatusWithCredential(args, cwd, credential);
    if (result.status !== 0) throw new Error(`S6 Git operation failed: ${sanitizeGitError(result.stderr || result.stdout || "unknown error")}`);
    return result;
  }

  gitStatusWithCredential(args, cwd, credential = {}, options = {}) {
    const { input, ...gitOptions } = options;
    const env = this.gitEnvironment();
    return this.gitRunner
      ? this.gitRunner(args, cwd, env)
      : spawnSync("git", gitArgs(args, cwd, { ...credential, ...gitOptions, hooksPath: this.brokerHooksRoot }), { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  }

  gitOutput(args, cwd = this.workspacePath(this.sessionId), options = {}) {
    const result = this.gitStatusWithCredential(args, cwd, {}, options);
    if (result.status !== 0) throw new Error(`S6 Git inspection failed: ${sanitizeGitError(result.stderr || result.stdout || "unknown error")}`);
    return result.stdout || "";
  }

  readWorkspaceState(sessionId) {
    assertSessionId(sessionId);
    const file = path.join(this.stateRoot, `${sessionId}.json`);
    const parsed = readJson(file);
    if (!parsed || parsed.sessionId !== sessionId || parsed.kind !== "workspace") throw new Error("S6 workspace state is invalid");
    return parsed;
  }

  workspacePath(sessionId) {
    assertSessionId(sessionId);
    return path.join(this.sessionsRoot, sessionId);
  }

  publishStatePath() { return path.join(this.stateRoot, `${this.sessionId}.published.json`); }

  readPublishState() {
    const parsed = readJson(this.publishStatePath());
    if (!parsed) return null;
    if (parsed.version !== 1 || parsed.kind !== "s6-publish" || parsed.sessionId !== this.sessionId || parsed.repository !== S6_REPOSITORY_ALIAS || parsed.branch !== s6BranchForSession(this.sessionId) || parsed.remoteRef !== s6RemoteRefForSession(this.sessionId)) {
      throw new Error("S6 publish state is invalid");
    }
    if (!["publishing", "published"].includes(parsed.state) || !SHA.test(parsed.targetSha || parsed.publishedSha || "")) throw new Error("S6 publish state is invalid");
    if (parsed.state === "published" && parsed.targetSha !== parsed.publishedSha) throw new Error("S6 publish state target mismatch");
    if (parsed.priorSha !== null && parsed.priorSha !== undefined && !SHA.test(parsed.priorSha)) throw new Error("S6 publish prior SHA is invalid");
    return parsed;
  }

  writePublishedState(sha, base, state, { priorSha = null } = {}) {
    assertSha(sha, "published SHA");
    assertSha(base, "published base");
    const value = {
      version: 1,
      kind: "s6-publish",
      state,
      repository: S6_REPOSITORY_ALIAS,
      sessionId: this.sessionId,
      branch: s6BranchForSession(this.sessionId),
      remoteRef: s6RemoteRefForSession(this.sessionId),
      baseCommit: base,
      targetSha: sha,
      publishedSha: state === "published" ? sha : null,
      priorSha,
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(this.publishStatePath(), value);
  }

  validateClone(workspacePath) {
    if (fs.realpathSync(workspacePath) !== fs.realpathSync(path.resolve(workspacePath))) throw new Error("S6 clone path escaped manager root");
    if (this.gitOutput(["rev-parse", "--is-shallow-repository"], workspacePath).trim() !== "false") throw new Error("S6 GitHub clone is shallow");
    if (this.gitOutput(["remote"], workspacePath).trim() !== S6_REMOTE_NAME) throw new Error("S6 GitHub clone has an unexpected remote");
    const urls = this.gitOutput(["config", "--local", "--get-all", "remote.origin.url"], workspacePath).trim().split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1 || urls[0] !== S6_REPOSITORY_URL) throw new Error("S6 GitHub clone origin identity mismatch");
    const pushurl = this.gitStatus(["config", "--local", "--get-all", "remote.origin.pushurl"], workspacePath);
    if (pushurl.status === 0) throw new Error("S6 GitHub clone contains a pushurl");
  }
}

export class S6BrokerServer {
  constructor({ broker, socketPath } = {}) {
    if (!(broker instanceof S6GitHubBroker)) throw new Error("S6 broker server requires a broker");
    if (!socketPath || !path.isAbsolute(socketPath)) throw new Error("S6 broker socket path must be absolute");
    if (path.resolve(socketPath) !== s6BrokerSocketPath(broker.managerRoot, broker.sessionId)) throw new Error("S6 broker socket path is not the fixed session channel");
    this.broker = broker;
    this.socketPath = path.resolve(socketPath);
    this.capability = null;
    this.server = null;
  }

  listen() {
    ensureSocketParent(this.socketPath);
    if (fs.existsSync(this.socketPath)) {
      const stat = fs.lstatSync(this.socketPath);
      if (!stat.isSocket()) throw new Error("S6 broker socket collision");
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer((socket) => this.handle(socket));
    this.server.listen(this.socketPath, () => {
      fs.chmodSync(this.socketPath, 0o666);
      process.stdout.write("S6_BROKER_READY\n");
    });
    return this.server;
  }

  handle(socket) {
    let buffer = "";
    let done = false;
    const finish = () => { if (!done) { done = true; socket.end(); } };
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      if (done) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024 || !buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n"));
      try {
        const request = JSON.parse(line);
        // A connection carries exactly one request. Mark it consumed before
        // any async publish work so a peer cannot pipeline a second request
        // while the first one is holding the credential scope.
        done = true;
        const result = await dispatchS6BrokerRequest(this.broker, this, request);
        socket.end(`${JSON.stringify(result)}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ error: sanitizeGitError(error.message) })}\n`);
      }
    });
    socket.on("error", finish);
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        fs.rmSync(this.socketPath, { force: true });
        resolve();
      });
    });
  }
}

export async function dispatchS6BrokerRequest(broker, authState, request) {
  if (!(broker instanceof S6GitHubBroker) || !authState || typeof authState !== "object") throw new Error("invalid broker dispatcher state");
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid broker request");
  if (request.operation === "register") {
    if (authState.capability || Object.keys(request).sort().join(",") !== "capability,operation" || !/^[a-f0-9]{64}$/.test(String(request.capability || ""))) throw new Error("S6 broker registration is closed");
    authState.capability = request.capability;
    return { registered: true };
  }
  if (!authState.capability || !sameCapability(request.capability, authState.capability)) throw new Error("broker authentication failed");
  if (request.operation === "attest") {
    if (Object.keys(request).sort().join(",") !== "capability,operation,sha") throw new Error("invalid attest request");
    return broker.attestCommit(request.sha);
  }
  if (request.operation === "publish") {
    if (Object.keys(request).sort().join(",") !== "capability,operation") throw new Error("publish accepts no authority-bearing input");
    return broker.publishBranch();
  }
  throw new Error("unsupported S6 broker operation");
}

export function parseBrokerReady(line) {
  if (String(line || "").trim() !== "S6_BROKER_READY") throw new Error("S6 broker readiness marker is invalid");
  return true;
}

function gitArgs(args, cwd, { disableHooks = true, hooksPath = "/dev/null", credentialHelper = "" } = {}) {
  if (disableHooks && (!path.isAbsolute(hooksPath) || hooksPath === path.parse(hooksPath).root)) throw new Error("S6 broker hook directory is invalid");
  if (credentialHelper && (!path.isAbsolute(credentialHelper) || credentialHelper === path.parse(credentialHelper).root)) throw new Error("S6 trusted credential helper path is invalid");
  return [
    "--no-pager", "-c", `safe.directory=${cwd}`, "-c", "core.abbrev=40", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...(disableHooks ? ["-c", `core.hooksPath=${hooksPath}`] : []), "-c", "credential.helper=", ...(credentialHelper ? ["-c", `credential.https://github.com.helper=${credentialHelper}`] : []),
    ...args,
  ];
}

export function parsePushReceipt(output, ref) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const target = `HEAD:${ref}`;
  const matching = lines.find((line) => line.includes(target));
  if (!matching) throw new Error("S6 push did not return a fixed-branch receipt");
  const range = matching.match(/\b([0-9a-f]{40})\.\.([0-9a-f]{40})$/);
  if (range) return { oldSha: range[1], newSha: range[2] };
  if (/\[new branch\]/.test(matching)) return { oldSha: null, newSha: null };
  throw new Error("S6 push receipt was not an exact fast-forward or new-branch result");
}

function sameCapability(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left || "")) || !/^[a-f0-9]{64}$/.test(String(right || ""))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizePushReceipt(receipt) {
  if (!receipt || (receipt.oldSha !== null && !SHA.test(receipt.oldSha)) || !SHA.test(receipt.newSha || "")) throw new Error("S6 remote adapter returned an invalid push receipt");
  return { oldSha: receipt.oldSha ?? null, newSha: receipt.newSha };
}

function publishEvidence(sessionId, head, base, ref, status) {
  return {
    repository: S6_REPOSITORY_ALIAS,
    sessionId,
    branch: s6BranchForSession(sessionId),
    remoteRef: ref,
    baseCommit: base,
    commit: head,
    remoteSha: head,
    status,
  };
}

function assertSessionId(value) {
  if (!SESSION.test(String(value || ""))) throw new Error("invalid S6 session id");
}

function assertRemoteRef(ref, sessionId) {
  if (!REMOTE_REF.test(String(ref || "")) || ref !== s6RemoteRefForSession(sessionId)) throw new Error("S6 remote ref is not the generated branch ref");
}

function assertSha(value, label) {
  if (!SHA.test(String(value || ""))) throw new Error(`${label} is not a full Git SHA`);
  return String(value);
}

function assertSafeBrokerRoot(root) {
  if (path.resolve(root) === path.parse(root).root || root.includes("/volume1/docker")) throw new Error("S6 broker manager root is unsafe");
  if (!path.basename(root).startsWith("chatgpt-local-bridge-s6-")) throw new Error("S6 broker manager root identity is invalid");
  ensureNoSymlinkAncestors(root);
}

function ensureParentPath(target, parent) {
  if (!isWithin(target, parent) || path.resolve(target) === path.resolve(parent)) throw new Error("S6 path escaped manager sessions");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
}

function ensureSocketParent(socketPath) {
  const parent = path.dirname(socketPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o711);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o711) throw new Error("S6 broker socket parent must be an execute-only channel");
}

function ensurePrivateEmptyDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  fs.chmodSync(directory, 0o700);
  const verified = fs.lstatSync(directory);
  if ((verified.mode & 0o077) !== 0) throw new Error(`${label} must be private`);
  if (typeof process.getuid === "function" && verified.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
  if (fs.readdirSync(directory).length !== 0) throw new Error(`${label} must remain empty`);
}

function ensureNoSymlinkAncestors(target) {
  let current = path.resolve(target);
  const stack = [];
  while (true) {
    stack.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const item of stack.reverse()) {
    if (!fs.existsSync(item)) continue;
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink()) {
      if (process.platform === "darwin" && ["/tmp", "/var"].includes(item)) continue;
      throw new Error(`S6 path has a symlink ancestor: ${item}`);
    }
    if (!stat.isDirectory()) throw new Error(`S6 path ancestor is not a directory: ${item}`);
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }

function atomicWrite(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function sanitizeGitError(value) {
  return String(value || "unknown error")
    .replace(TOKEN_LIKE, "<redacted>")
    .replace(/https:\/\/[^\s]+/gi, "https://github.com/<redacted>")
    .slice(0, 400);
}

function runBrokerServer() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== "serve" || !args["manager-root"] || !args.session) throw new Error("usage: s6-github-broker.mjs serve --manager-root <s6-root> --session <s6-session>");
  const broker = new S6GitHubBroker({ managerRoot: args["manager-root"], bridgeRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), sessionId: args.session });
  const socketPath = s6BrokerSocketPath(broker.managerRoot, broker.sessionId);
  const server = new S6BrokerServer({ broker, socketPath });
  server.listen();
  const close = () => { server.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

function parseArgs(args) {
  const out = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item.startsWith("--")) {
      const [key, inline] = item.slice(2).split("=", 2);
      out[key] = inline ?? args[++index];
    } else out._.push(item);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { runBrokerServer(); } catch (error) { process.stderr.write(`${sanitizeGitError(error.message)}\n`); process.exitCode = 1; }
}
