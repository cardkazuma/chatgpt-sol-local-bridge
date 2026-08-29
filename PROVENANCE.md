# S1 provenance

This is a local, detached fork/work area. It has not been pushed to GitHub and
it does not modify a canonical checkout.

## Source

- Upstream: `https://github.com/mingrath/chatgpt-sol-local-bridge.git`
- Audited upstream commit: `3c7b0c0fffa0e04f4533f871ece3da0064cf6620`
- Local `HEAD`: the same exact commit, with S1 changes left reviewable as a
  working-tree diff.
- The upstream `HEAD`/`main` ref was verified against that commit before the
  local fork was created.

## Dependencies

Direct runtime and development dependencies are exact-version entries in
`package.json`; `package-lock.json` is npm lockfile version 3 and was generated
with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.
The lockfile was installed with `npm ci --ignore-scripts --no-audit --no-fund`.

Review hashes:

```text
package-lock.json                         37fbf72f726a888ac8dde223b542ef533123a9ef1ecd9a32159ec55cef05ea67
scripts/pre-commit-policy.mjs             e051fa3873aff3299b30590a3d6c54a901cbff31dbeafcd625e9c69cf6a42b2f
.githooks/pre-commit                      d4293a6592e095195fbdbce202055053d043fc5d26a45b680205bfa3fc45b373
```

The reviewed Git governance code pins the policy-helper hash above. Dependency
installation runs lifecycle scripts disabled; the Docker build also installs
with scripts disabled.

## Runtime image

- Base: `docker.io/library/node:22.14.0-bookworm-slim`
- Reviewed linux/amd64 image digest:
  `sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de`
- Runtime image tag: `chatgpt-sol-local-bridge:s1-pinned`
- Build arg `UPSTREAM_COMMIT` records the audited source commit in the image
  label.

The runtime image excludes the retained upstream desktop/Office/web source and
operator-service/docs/test material that S1 does not need. The source fork
still retains those files for audit comparison, but all tool registration paths
are gated by the S1 catalog.

## Validation provenance

The following checks were run in this local fork:

- `npm run lint` — pass.
- `npm test` — 39 of 39 tests pass.
- `docker compose config -q` — pass inside the disposable host proof.
- `node scripts/s1-host-proof.mjs` — container exit 0, 13 of 13 adversarial
  categories pass, host credential/outside sentinels unchanged.

No NAS path, `/volume1/docker`, existing homelab checkout, production service,
ChatGPT connection, Secure MCP Tunnel, GitHub staging repository, credential,
or persistent service was accessed or changed by S1.
