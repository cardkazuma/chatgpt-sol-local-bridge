# chatgpt-sol-local-bridge

**Drive your development workstation from ChatGPT (web, desktop, or mobile) using GPT-5.6 Sol as the orchestration brain — with your local filesystem, git, tests, dev servers, and browser exposed as private MCP tools over OpenAI's Secure MCP Tunnel.**

Your machine keeps **zero open inbound ports**. ChatGPT reaches your tools through a client you run, which connects **outbound-only** to OpenAI, pulls queued MCP work, executes it locally, and returns the result.

---

## Table of Contents

1. [Why This Approach Exists](#1-why-this-approach-exists-the-rationale)
2. [What It Is and What It's For](#2-what-it-is-and-what-its-for)
3. [Setup Guide](#3-setup-guide)
4. [The No-Delete Safety Policy](#4-the-no-delete-safety-policy)
5. [Reference Tool Surface](#5-reference-tool-surface)
6. [Honest Limits & Cost Model](#6-honest-limits--cost-model)
7. [Troubleshooting](#7-troubleshooting)
8. [References](#8-references)

---

## 1. Why This Approach Exists (The Rationale)

Modern ChatGPT plans (Plus / Pro / Business) include two **separately metered** usage pools:

| Pool | What draws from it |
|---|---|
| **ChatGPT messages** | Conversations in ChatGPT web / desktop / mobile — including tool calls to connected MCP apps |
| **Codex usage** | Codex CLI, Codex IDE extension, Codex cloud tasks (weekly + 5-hour windows) |

This separation is **documented product design, not a bug or an exploit**. It leads to a practical consequence:

> If the *orchestrating model* runs inside ChatGPT (e.g. **GPT-5.6 Sol with High reasoning**), and the *work* is executed by local tools over the Secure MCP Tunnel, the orchestration consumes your ChatGPT message allowance — **your Codex weekly quota stays untouched** for when you genuinely need Codex CLI / cloud tasks.

Why you would actually want this in daily work:

- **🕹️ Delegate from anywhere.** Start a task from your phone on the train; the agent edits code, runs tests, and drives the browser on your workstation at home. Typing chat commands is enough — you are not the execution bottleneck anymore.
- **💸 No API billing.** The brain is your existing ChatGPT subscription. Tunnel transport carries no per-token API charges.
- **🔒 Security teams can sign off.** Outbound-only HTTPS to `api.openai.com:443`. No public endpoint, no inbound firewall rule, no VPN change, no third-party connectivity vendor.
- **🧠 A model you don't pay twice for.** "Sol High" (GPT-5.6 Sol, High reasoning effort) handles architecture-level reasoning; the *machine* supplies ground truth (files, git state, test output, screenshots) instead of the model hallucinating it.
- **🔀 Composable.** The same tunnel is reachable from ChatGPT, Codex, and the Responses API — one private tool server, multiple OpenAI surfaces.
- **🧯 Blast radius is your policy.** The MCP server — code *you* own and run — decides what is allowed. This repo ships a strict default: **create / update / edit, never delete** (see [§4](#4-the-no-delete-safety-policy)).

> [!IMPORTANT]
> **This is not "unlimited free compute."** ChatGPT messages have their own plan limits, and heavier reasoning efforts consume them faster (Ultra burns the fastest). Delegating to a local `codex_run` tool consumes the Codex pool like any Codex CLI run. Honest numbers live in [§6](#6-honest-limits--cost-model).

---

## 2. What It Is and What It's For

### Architecture

```
┌──────────────────────┐   HTTPS    ┌─────────────────────────┐
│  ChatGPT web/desktop │◄──────────►│   OpenAI-hosted tunnel  │
│  /mobile app         │            │   endpoint (control +   │
│                      │            │   work queue)           │
│  Brain: GPT-5.6 Sol  │            └───────────▲─────────────┘
│  (High reasoning)    │                        │ outbound long-poll
└──────────────────────┘                        │ (HTTPS :443 only)
                                     ┌──────────┴──────────────┐
                                     │  tunnel-client          │
                                     │  (runs on YOUR machine, │
                                     │  no inbound ports)      │
                                     └──────────┬──────────────┘
                                                │ stdio / loopback HTTP
                                     ┌──────────▼──────────────┐
                                     │  local MCP server       │
                                     │  (YOUR code, YOUR rules)│
                                     │                         │
                                     │  • workspace_*  git_*   │
                                     │  • read_file  apply_patch│
                                     │  • test / lint / build  │
                                     │  • process_*  shell     │
                                     │  • dom_cdp (browser)    │
                                     │  • codex_run (optional) │
                                     │  • system_info  vision  │
                                     └─────────────────────────┘
```

### Components

| Component | Where it runs | What it does |
|---|---|---|
| **ChatGPT** (Developer Mode app) | OpenAI/cloud | The conversational brain. You chat; it plans and calls tools. |
| **Secure MCP Tunnel endpoint** | OpenAI-hosted | Holds the queue of MCP requests for your tunnel identity. Created in Platform settings. |
| **`tunnel-client`** | Your machine | Open-source agent that authenticates to OpenAI with an API key, long-polls for work, forwards JSON-RPC to your MCP server, posts responses back. |
| **Local MCP server** | Your machine | Your tool implementations and — critically — your **authorization policy**. This is the only component with filesystem/shell access. |
| **Local Codex CLI** *(optional)* | Your machine | A `codex_run` tool lets ChatGPT hand off heavy implementation to Codex CLI (`codex exec`). Costs Codex pool — see [§6](#6-honest-limits--cost-model). |

### Purpose

- Turn any workstation (desktop at the office, Mac mini at home, cloud VM) into a **remotely operable development agent** reachable from a chat box.
- Give non-local collaborators a controlled way to run *reversible* operations (edit, build, test, inspect) on a machine they don't have SSH access to.
- Keep **all code and data on-prem**: only tool descriptions, arguments, and results traverse OpenAI.

---

## 3. Setup Guide

### 3.1 Prerequisites

| Requirement | Details |
|---|---|
| ChatGPT plan | Plus / Pro / Business / Enterprise with **Developer Mode** available |
| Platform permissions | Tunnel permissions are **org-level**, granted by an org owner / RBAC admin: **Read + Manage** to create the tunnel, **Read + Use** on the key that runs `tunnel-client`. ⚠️ New role grants can take **up to 30 minutes** to propagate. |
| ChatGPT Developer Mode | A **separate grant** from Platform roles. On Enterprise/Edu a workspace admin must enable it; then the user switches it on in **Settings → Security and login**. Having one grant gives you neither the other — this double-approval is the #1 setup blocker. |
| Runtime API key | Platform API key scoped with Tunnels **Read + Use** |
| Local toolchain | Python 3.11+ (for the reference server) or any MCP SDK; `git`; optional `codex` CLI v0.147+ logged in via `codex login` (ChatGPT auth) |

### 3.2 Install `tunnel-client`

**macOS / Linux (Homebrew):**

```bash
brew install openai/tools/tunnel-client
```

**Windows / other:** download the latest release binary from
<https://github.com/openai/tunnel-client/releases>

Sanity check:

```bash
tunnel-client help quickstart
```

### 3.3 Create the tunnel endpoint (one-time, in Platform settings)

1. Open <https://platform.openai.com/settings/organization/tunnels> with the **correct organization** selected in the top-left switcher.
2. **Create tunnel** → note the `tunnel_id` (looks like `tunnel_0123...`).
3. **Associate the tunnel** with:
   - the Platform organization that owns it, **and**
   - the **ChatGPT workspace** that should see it, **and**
   - any organization Codex / Responses API will call from.
   A tunnel linked only to a *personal* organization will **not** appear in an Enterprise/Edu workspace — this is the #2 setup blocker.
4. Create a runtime API key with Tunnels **Read + Use** and export it:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
```

### 3.4 Run the local MCP server (this repo's reference implementation)

```bash
git clone <this-repo> && cd chatgpt-sol-local-bridge
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r examples/requirements.txt

# Point it at the workspace it's allowed to touch:
export BRIDGE_WORKSPACE_ROOT="$HOME/projects"

# stdio mode (recommended — tunnel-client spawns it as a child process):
python examples/server.py
```

The server enforces the **no-delete policy** and confines all file access to `BRIDGE_WORKSPACE_ROOT`. See [§4](#4-the-no-delete-safety-policy).

### 3.5 Register the profile and validate

**stdio server** (client spawns it for you):

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile local-bridge \
  --tunnel-id tunnel_0123... \
  --mcp-command "/abs/path/to/.venv/bin/python /abs/path/to/examples/server.py"
```

**HTTP server** (you run it yourself on loopback):

```bash
tunnel-client init \
  --profile local-bridge-http \
  --tunnel-id tunnel_0123... \
  --mcp-server-url "http://127.0.0.1:8000/mcp"
```

Validate, then run:

```bash
tunnel-client doctor --profile local-bridge --explain   # tells you *why* each check passes/fails
tunnel-client run    --profile local-bridge             # keep this alive while you test
```

`--explain` is your friend — it prints the reason behind every doctor check. Health, readiness and metrics live at `/healthz`, `/readyz`, `/metrics`, with a **loopback-only** admin UI at `/ui`.

### 3.6 Connect ChatGPT to the tunnel

1. In ChatGPT, enable **Developer Mode** (Settings → Security and login, if not already granted by your admin).
2. Go to **Settings → Plugins** (or <https://chatgpt.com/plugins>) → **＋ create app**.
3. Under **Connection**, choose **Tunnel**.
4. Pick your tunnel from the list — or paste the `tunnel_id` directly.
5. Save; ChatGPT discovers the tools from your running MCP server. (If the client isn't polling, discovery looks like a broken connector rather than a stopped process — check `tunnel-client run`.)

### 3.7 Smoke test

In the ChatGPT conversation with the app enabled:

- Model picker → **5.6 Sol**, effort → **High**.
- Prompt:

  > Use `system_info` to report the host, then `workspace_list` to show what's in the workspace root. Do not modify anything.

Then a write-path test in a scratch project:

  > In project `scratch`, create `hello.py` printing "pong", run it with `shell`, and show me `git_status`.

Verify the guardrail:

  > Delete `hello.py`.

Expected: refusal — the tool surface has no delete operation, and `shell` rejects destructive commands. ✅ Bridge verified.

### 3.8 (Optional) Wire in the Codex CLI relay

To let ChatGPT delegate heavy lifting to the local Codex installation:

```bash
brew install --cask codex   # or your platform's method
codex login                 # ChatGPT auth
codex exec --sandbox read-only --skip-git-repo-check "Reply with exactly: PONG"
```

The reference server already exposes `codex_run` pointing at that binary. Remember: **every `codex_run` call spends Codex-pool quota** measured under `limit_id: codex` (visible in `~/.codex/sessions/**/rollout-*.jsonl`).

---

## 4. The No-Delete Safety Policy

The house rule — **"Full access, but never delete. Adds, updates, and edits are fine. If something must be removed, ask a human first."** — is implemented in three layers:

**Layer 1 — the tool surface simply has no delete operation.**
There is no `fs_delete`, no `process_kill` on PIDs it didn't spawn, no destructive git verbs. You cannot call what does not exist.

**Layer 2 — command-level denylist in `shell`.**
Even the generic shell rejects destructive patterns before execution:

```python
DESTRUCTIVE_PATTERNS = [
    r"\brm\b", r"\brmdir\b", r"\bunlink\b", r"\bshred\b",
    r"\bRemove-Item\b", r"\bdel\b", r"\berase\b",
    r"\bmkfs", r"\bdd\b", r"\bformat\b",
    r"git\s+(reset\s+--hard|clean\b|push\s+--force|branch\s+-D)",
    r"DROP\s+TABLE", r"TRUNCATE\s+TABLE",
]
```

**Layer 3 — MCP tool annotations.**
Every tool declares truthful hints (`readOnlyHint` / `destructiveHint`) so the ChatGPT client prompts you before consequential calls.

When something genuinely needs deleting, the human runs it locally, or you extend the policy with an out-of-band approval step. Nothing in the repo grants the agent that power by default.

> [!WARNING]
> "No-delete" is a safety *policy*, not a sandbox. For stronger containment run the server inside a container/VM, on a dedicated user account, or behind OS-level sandboxing — and never give it credentials to production systems.

---

## 5. Reference Tool Surface

The minimal server in [`examples/server.py`](examples/server.py) implements a starter subset. A full workstation bridge typically grows toward:

| Tool family | Purpose |
|---|---|
| `workspace_list / workspace_open / workspace_snapshot` | Multi-project registry, structure view, cheap snapshots |
| `read_file` / `search_text` / `apply_patch` | Read code, project-wide search, batched multi-file edits |
| `git_status` / `git_diff` / `git_log` | Working-tree review before/after changes |
| `project_dev` / `test` / `lint` / `typecheck` / `build` | Run the project's own scripts from chat |
| `process_start` / `process_logs` / `process_stop`, `shell` | Real CLI execution with stdout/stderr capture and tailing |
| `codex_run` | Delegate implement/review to local Codex CLI *(spends Codex pool)* |
| `dom_cdp` | Drive Chrome via CDP: navigate, inspect DOM, click/type, execute JS, screenshot |
| `vision` | Capture screen / window / region (+ OCR) |
| `web_fetch` | HTTP requests from the machine's network identity |
| `system_info` / `health` | CPU, RAM, disk, process, backend status |
| `clipboard`, `notification`, `scheduler`, `screen_record`, `audio` | Desktop glue (platform-dependent) |
| Windows-only: `accessibility`, `input_event`, `window`, `office`, `file_dialog` | UI Automation, raw input, window management, Office COM, native dialogs |

Design rules that keep the bridge maintainable:

- **Tools are thin.** They wrap the same commands a human would run (`git`, `pytest`, `npm test`). No magic.
- **Everything is relative to `BRIDGE_WORKSPACE_ROOT`** and path-traversal is rejected.
- **Output is bounded** (tail N lines) so a runaway build can't flood the conversation.

---

## 6. Honest Limits & Cost Model

This section exists so nobody oversells the setup internally:

| Claim you may hear | Reality |
|---|---|
| "Codex quota stays at 100%" | True **only while** the brain is ChatGPT chat and you never call `codex_run`. Any Codex CLI usage (relay or direct) is metered under the Codex pool — we verified `limit_id: "codex"` in local session telemetry. |
| "It's unlimited/free" | No. ChatGPT messages are plan-limited too, and **higher reasoning efforts burn the allowance faster** (Ultra ≫ High). The win is *pool separation and no API bill*, not infinity. |
| "It's a quota bypass / a bug" | No. Two products, two documented rate-limit pools, one subscription. OpenAI can resize either pool at any time. |
| "Tunnel transport is free" | Yes — the tunnel carries tool calls; you're not billed API tokens for them. |
| "CLI/harness can do the same" | No. `codex exec`, or any CLI harness authenticated via the Codex/ChatGPT OAuth path, is metered as the **Codex** pool. The chat pool is reachable only through first-party ChatGPT surfaces (web / desktop / mobile). That's exactly why the tunnel + web UI combo exists. |

**Operational limits to plan around:**

- `tunnel-client run` must stay alive; a stopped client looks like a broken connector (use `systemd`, `launchd`, or a supervised process for always-on).
- Streamed tool results are supported, but huge outputs should still be bounded.
- Dev-mode apps are built for development; mind your workspace's data policies before pointing it at real codebases.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Tunnels access required" in Platform settings | Tunnel roles are **org-level**, not project-level | Org owner/RBAC admin grants Tunnels **Read** (+**Manage** to create). Wait up to 30 min for propagation. |
| Tunnel not listed in ChatGPT | Tunnel associated with a Platform org but not the **ChatGPT workspace**; or missing Tunnels **Use** | Edit associations; Enterprise/Edu may need an account-team-assisted link. |
| Discovery/tool calls fail | `tunnel-client` not running or not connected | `tunnel-client doctor --profile <name> --explain`; keep `run` alive. |
| Can view tunnel, can't edit | Have **Read**, missing **Manage** | Request the role upgrade. |
| Tool times out against big outputs | Unbounded stdout | All tools tail-limit output; raise limits deliberately, not globally. |

---

## 8. References

- OpenAI guide: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- Tunnel client source & releases: [openai/tunnel-client](https://github.com/openai/tunnel-client)
- Announcement: [Connect private MCP servers to OpenAI products](https://developers.openai.com/blog/connect-private-mcp-servers-to-openai-products)
- Platform tunnel management: <https://platform.openai.com/settings/organization/tunnels>
- ChatGPT apps: <https://chatgpt.com/plugins>
- Codex CLI: `codex doctor` for local diagnostics

---

## License

MIT — copy it, adapt it, share it with your team. The guardrail policy is the part worth keeping.
