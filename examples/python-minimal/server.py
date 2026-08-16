#!/usr/bin/env python3
"""
chatgpt-sol-local-bridge — reference MCP server (minimal, safe-by-default).

Design rules:
  * All file access is confined to BRIDGE_WORKSPACE_ROOT (path-traversal rejected).
  * NO delete operations exist anywhere in the tool surface.
  * `shell` rejects destructive command patterns before execution.
  * Tool outputs are tail-bounded so runaway builds can't flood the chat.

Run:  python examples/server.py           # stdio (tunnel-client spawns it)
"""

import os
import re
import shlex
import subprocess
import platform
import sys
from pathlib import Path

from fastmcp import FastMCP
from mcp.types import ToolAnnotations  # official MCP SDK types

WORKSPACE_ROOT = Path(os.environ.get("BRIDGE_WORKSPACE_ROOT", ".")).resolve()
MAX_OUTPUT_CHARS = 12_000

# --- No-delete policy, layer 2: command-level denylist -----------------------
DESTRUCTIVE_PATTERNS = [
    r"\brm\b", r"\brmdir\b", r"\bunlink\b", r"\bshred\b",
    r"\bRemove-Item\b", r"\bdel\b", r"\berase\b",
    r"\bmkfs", r"\bdd\b", r"\bformat\b",
    r"git\s+(reset\s+--hard|clean\b|push\s+--force|branch\s+-D)",
    r"DROP\s+TABLE", r"TRUNCATE\s+TABLE",
    r">\s*/dev/", r"\bkill\s+-9\b",
]
_DENY = [re.compile(p, re.IGNORECASE) for p in DESTRUCTIVE_PATTERNS]

mcp = FastMCP(
    name="sol-local-bridge",
    instructions=(
        "Local workstation bridge. You may create, update, and edit files, run "
        "tests/builds and inspect the machine. You MUST NOT delete anything; if a "
        "task requires deletion, stop and ask a human to do it locally."
    ),
)

RO = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
WR = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)


def _resolve(path: str) -> Path:
    """Resolve inside the workspace; reject traversal."""
    p = (WORKSPACE_ROOT / path.lstrip("/")).resolve()
    if not str(p).startswith(str(WORKSPACE_ROOT)):
        raise ValueError(f"path escapes workspace root: {path}")
    return p


def _tail(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return f"...[truncated, showing last {MAX_OUTPUT_CHARS} chars]\n" + text[-MAX_OUTPUT_CHARS:]


def _run(cmd: list[str], cwd: Path, timeout: int = 120) -> str:
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
    )
    out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
    return f"[exit {proc.returncode}]\n" + _tail(out)


@mcp.tool(annotations=RO)
def system_info() -> str:
    """Report host platform, CPU count, and workspace root."""
    return _tail(
        f"host={platform.node()} os={platform.system()} {platform.release()} "
        f"arch={platform.machine()} cpus={os.cpu_count()} "
        f"workspace_root={WORKSPACE_ROOT}"
    )


@mcp.tool(annotations=RO)
def workspace_list(subdir: str = ".", max_entries: int = 200) -> str:
    """List a directory inside the workspace (top N entries)."""
    base = _resolve(subdir)
    if not base.is_dir():
        return f"not a directory: {subdir}"
    entries = sorted(p.name + ("/" if p.is_dir() else "") for p in base.iterdir())
    return "\n".join(entries[:max_entries])


@mcp.tool(annotations=RO)
def read_file(path: str, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    """Read a file inside the workspace."""
    p = _resolve(path)
    return _tail(p.read_text(errors="replace")[:max_chars])


@mcp.tool(annotations=RO)
def search_text(pattern: str, subdir: str = ".", max_hits: int = 50) -> str:
    """Regex search across the workspace (uses git grep when available)."""
    base = _resolve(subdir)
    try:
        return _run(["git", "grep", "-n", "-I", "-E", pattern, "--", "."], cwd=base)
    except (subprocess.SubprocessError, FileNotFoundError):
        hits = []
        for f in base.rglob("*"):
            if f.is_file() and f.stat().st_size < 1_000_000:
                for i, line in enumerate(f.read_text(errors="ignore").splitlines(), 1):
                    if re.search(pattern, line):
                        hits.append(f"{f.relative_to(base)}:{i}:{line.strip()}")
                        if len(hits) >= max_hits:
                            return "\n".join(hits)
        return "\n".join(hits) or "(no matches)"


@mcp.tool(annotations=WR)
def write_file(path: str, content: str) -> str:
    """Create or fully overwrite a file (parent dirs auto-created). Never deletes."""
    p = _resolve(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return f"wrote {p.relative_to(WORKSPACE_ROOT)} ({len(content)} chars)"


@mcp.tool(annotations=WR)
def replace_in_file(path: str, old: str, new: str) -> str:
    """Exact-string replacement in an existing file (create/update, never delete)."""
    p = _resolve(path)
    text = p.read_text()
    if old not in text:
        return "no match found; file unchanged"
    p.write_text(text.replace(old, new, 1))
    return f"updated {p.relative_to(WORKSPACE_ROOT)}"


@mcp.tool(annotations=RO)
def git_status(subdir: str = ".") -> str:
    """git status --short --branch for a project in the workspace."""
    return _run(["git", "status", "--short", "--branch"], cwd=_resolve(subdir))


@mcp.tool(annotations=RO)
def git_diff(subdir: str = ".", staged: bool = False) -> str:
    """git diff (optionally --staged) for review."""
    cmd = ["git", "diff"] + (["--staged"] if staged else [])
    return _run(cmd, cwd=_resolve(subdir))


@mcp.tool(annotations=RO)
def shell(command: str, timeout: int = 120) -> str:
    """
    Run a shell command in the workspace (tests, builds, linters, dev scripts).
    Destructive commands are REFUSED by policy — ask a human to run those locally.
    """
    for pat in _DENY:
        if pat.search(command):
            return (
                f"REFUSED by no-delete policy (matched {pat.pattern!r}).\n"
                "Add/update/edit are allowed; deletion requires a human."
            )
    return _run(["bash", "-lc", command], cwd=WORKSPACE_ROOT, timeout=timeout)


@mcp.tool(annotations=WR)
def codex_run(prompt: str, timeout: int = 600) -> str:
    """
    Delegate a task to the local Codex CLI (gpt-5.6-sol, full-access workspace).
    NOTE: consumes the ChatGPT plan's Codex usage pool, unlike other tools here.
    """
    return _run(
        ["codex", "exec", "--skip-git-repo-check",
         "--sandbox", "workspace-write", prompt],
        cwd=WORKSPACE_ROOT,
        timeout=timeout,
    )


@mcp.tool(annotations=RO)
def web_fetch(url: str, max_chars: int = 4000) -> str:
    """Fetch a URL from this machine's network (loopback/intranet reachable)."""
    import urllib.request

    with urllib.request.urlopen(url, timeout=20) as resp:  # noqa: S310 (intentional tool)
        body = resp.read(max_chars).decode("utf-8", errors="replace")
    return _tail(body)


if __name__ == "__main__":
    if not WORKSPACE_ROOT.is_dir():
        raise SystemExit(f"BRIDGE_WORKSPACE_ROOT does not exist: {WORKSPACE_ROOT}")
    print(f"[sol-local-bridge] workspace root: {WORKSPACE_ROOT}", file=sys.stderr)
    print(f"[sol-local-bridge] command: {shlex.join(['python', __file__])}", file=sys.stderr, flush=True)
    mcp.run()  # stdio transport
