import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { commandExists, runCommand, startProcess } from "../lib/exec.js";
import { denyDeleteMessage, inspectDestructive, queueDestructive } from "../lib/policy.js";
import { assertInWorkspace, currentWorkspace, resolveUserPath } from "../lib/paths.js";
import { fail, json } from "../lib/text.js";

const NAMES = ["test", "lint", "typecheck", "build", "dev"];

export function registerProject(server) {
  for (const name of NAMES) {
    server.registerTool(`project_${name}`, {
      title: `Project ${name}`,
      description: `Detect and run the project's ${name} command across Node, Python, Rust, or Go projects. Pass command to override detection.`,
      inputSchema: {
        cwd: z.string().optional(),
        command: z.string().optional().describe("Explicit command override; destructive commands still require confirmation"),
      },
      annotations: {
        readOnlyHint: ["test", "lint", "typecheck"].includes(name),
        destructiveHint: false,
        openWorldHint: false,
      },
    }, async ({ cwd, command } = {}, extra) => {
      try {
        const root = assertInWorkspace(cwd ? resolveUserPath(cwd) : currentWorkspace() || process.cwd(), { write: name === "build" || name === "dev" });
        const picked = command || detectCommand(root, name);
        if (!picked) return fail(`no ${name} command detected; pass command explicitly`);
        const inspection = inspectDestructive(picked);
        if (inspection.destructive) {
          return fail(denyDeleteMessage(queueDestructive({ kind: name === "dev" ? "process_start" : "shell", command: picked, cwd: root, matches: inspection.matches })));
        }
        if (name === "dev") return json(startProcess(picked, { cwd: root }));
        return json({ command: picked, ...(await runCommand(picked, { cwd: root, timeoutMs: 300_000, signal: extra?.signal })) });
      } catch (error) {
        return fail(error.message);
      }
    });
  }
}

export function detectCommand(root, name) {
  const packageCommand = detectPackageCommand(root, name);
  if (packageCommand) return packageCommand;
  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "pytest.ini")) || fs.existsSync(path.join(root, "requirements.txt"))) {
    const prefix = fs.existsSync(path.join(root, "uv.lock")) && commandExists("uv") ? "uv run " : "";
    const recipes = {
      test: `${prefix}pytest`,
      lint: commandExists("ruff") || prefix ? `${prefix}ruff check .` : null,
      typecheck: commandExists("mypy") || prefix ? `${prefix}mypy .` : commandExists("pyright") ? "pyright" : null,
      build: commandExists("python") ? "python -m build" : "python3 -m build",
      dev: null,
    };
    if (recipes[name]) return recipes[name];
  }
  if (fs.existsSync(path.join(root, "Cargo.toml")) && commandExists("cargo")) {
    return { test: "cargo test", lint: "cargo clippy --all-targets --all-features", typecheck: "cargo check", build: "cargo build", dev: "cargo run" }[name];
  }
  if (fs.existsSync(path.join(root, "go.mod")) && commandExists("go")) {
    return { test: "go test ./...", lint: "go vet ./...", typecheck: "go vet ./...", build: "go build ./...", dev: "go run ." }[name];
  }
  return null;
}

function detectPackageCommand(root, name) {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
  catch { return null; }
  const scripts = pkg.scripts || {};
  if (!scripts[name]) {
    const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (name === "typecheck" && dependencies.typescript && commandExists("npx")) return "npx --no-install tsc --noEmit";
    return name === "test" && scripts.test ? packageRun(root, "test") : null;
  }
  return packageRun(root, name);
}

function packageRun(root, script) {
  if ((fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) && commandExists("bun")) return `bun run ${script}`;
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml")) && commandExists("pnpm")) return `pnpm run ${script}`;
  if (fs.existsSync(path.join(root, "yarn.lock")) && commandExists("yarn")) return `yarn ${script}`;
  return `npm run ${script} --silent`;
}
