# ChatGPT connection status

There is deliberately no ChatGPT MCP connection in S1. Do not start a Secure
MCP Tunnel, create a ChatGPT connection, install tunnel credentials, or expose
the container endpoint. This document is a scope guard, not a setup guide.

S1 is complete when the local fork, pinned image, Compose model, structured
allowlist, and disposable proof have been reviewed. See [S1_REVIEW.md](S1_REVIEW.md)
and [OPERATIONS.md](OPERATIONS.md).

Any future transport work must separately review authentication, workspace
provisioning, credential flow, lifecycle, and failure behavior. It must not
reuse a normal user working copy or the homelab NAS. `codex_run`, Git push,
staging repositories, and persistent services are outside S1.
