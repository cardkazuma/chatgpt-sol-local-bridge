# Security model

## Trust assumptions

The bridge is a high-authority local agent. Its MCP caller, local user account, configured workspaces, optional browser profile, and optional Codex CLI are all trusted to the extent described here.

The no-delete layer prevents common accidental destructive actions and creates a reviewable human-confirmation step. It is not a kernel/OS security boundary. Generic shell access, project scripts, browser sessions, interpreters, and delegated agents can express side effects in ways no regex can enumerate.

For sensitive work, run under a dedicated unprivileged OS account in a VM/container or snapshot-capable workspace, with explicit filesystem/network policy and no production credentials.

## Authority controls

- `WORKSPACE_ROOTS` is configured outside MCP; only the dedicated `BRIDGE_SCRATCH_DIR` is added automatically.
- Bridge approvals, audit logs, process metadata, and state are not included in file-tool roots.
- `workspace_add_root` is disabled unless `ALLOW_TOOL_ROOT_REGISTRATION=true`.
- Existing and not-yet-created paths are canonicalized component-by-component through real parents; dangling/static symlink escapes are rejected.
- JavaScript pathname checks cannot eliminate hostile same-workspace TOCTOU races; use an OS sandbox/native `openat`-style helper when untrusted local processes can mutate path ancestors concurrently.
- Symlink escapes and string-prefix collisions are rejected.
- OS/credential paths such as `.ssh`, `.aws`, `.kube`, keychains, `/etc`, system directories, and Windows credential storage are denied.
- `process_stop` accepts only bridge-created stable IDs and verifies process identity to reduce PID-reuse risk.

## Destructive approvals

Blocked actions produce an exact, hash-bound, single-use token with an expiry. `confirm_destructive` executes the stored operation, not new arguments supplied during confirmation.

Modes:

- `deny` (code default): previews may be created but destructive execution is disabled.
- `chat`: matches the original workflow; the model asserts that the human explicitly said yes.
- `external`: calls an absolute, non-symlink `APPROVAL_VERIFIER_COMMAND` pinned by `APPROVAL_VERIFIER_SHA256`, with `verify <token> <fingerprint>`. That verifier must query an independently controlled human-approval channel and expose no approval-creation operation to the bridge account.

A same-user file or approval CLI is not independent because unrestricted shell authority could invoke it. Neither mode replaces backups/snapshots.

## Network controls

`web_fetch` permits only HTTP(S), rejects URL-embedded credentials, bounds response size, revalidates redirects, and blocks private/link-local/special addresses unless explicitly allowed. Use `WEB_FETCH_ALLOW_HOSTS` instead of global `ALLOW_PRIVATE_NETWORK=true` where possible.

`dom_cdp`, accessibility, low-level input, and window tools are intentionally high-risk and marked destructive to the MCP client. Keyword gates catch obvious Delete/Trash/Close actions, but coordinate clicks, script evaluation, and key input cannot be semantically proven safe. A signed-in browser profile contains sensitive sessions; use a dedicated profile whenever feasible.

## MCP listener

- Default: `127.0.0.1:8765`.
- Non-loopback binds are refused. External exposure must use a separately reviewed TLS/auth proxy while the bridge remains loopback-only.
- Host-header validation protects loopback use from DNS rebinding.
- `MCP_TOKEN` is useful for direct local clients only after verifying that your tunnel profile supplies the same Authorization header. The documented no-auth local tunnel profile assumes loopback trust.

## Secrets

Service installers load `CONTROL_PLANE_API_KEY` from a regular, non-symlink, user-owned secret file. Unix permissions must be `0600`; Windows setup applies a user-only ACL. Secrets are not embedded in plist/unit/task command lines, and audit arguments redact token/password/key-like fields.

The tunnel control-plane key is excluded from the MCP server environment. The runtime file is still readable by the same OS account, so unrestricted shell authority can reach it by path; use a separate tunnel identity/account, OS sandbox, or credential broker when that threat matters. Shell/project/Codex children receive a filtered environment: secret-like names (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY`, credentials, and known provider keys) are removed by default. Use `TOOL_ENV_ALLOWLIST` only for values a project genuinely requires, or `TOOL_ENV_INHERIT_SECRETS=true` only after accepting the broader exposure. A credential broker remains preferable to long-lived environment secrets.

## Audit

Tool start/completion/failure events are redacted and hash-chained in JSONL under:

```text
~/.chatgpt-sol-local-bridge/audit/
```

The chain helps detect accidental or offline edits but is not tamper-proof against a malicious process running as the same user. Export logs to an external append-only collector for stronger evidence.

## Reporting

Do not file live credentials, tunnel IDs paired with keys, private logs, or sensitive tool outputs in a public issue. Revoke exposed Platform keys immediately.
