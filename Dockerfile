# S1 runtime image. The platform-specific digest is pinned for the audited
# linux/amd64 proof environment; update only through a new review.
FROM docker.io/library/node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de

ARG UPSTREAM_COMMIT=3c7b0c0fffa0e04f4533f871ece3da0064cf6620
LABEL org.opencontainers.image.title="chatgpt-sol-local-bridge S1" \
      org.opencontainers.image.source="https://github.com/mingrath/chatgpt-sol-local-bridge" \
      org.opencontainers.image.revision="$UPSTREAM_COMMIT" \
      org.opencontainers.image.description="Disposable non-root, no-network S1 bridge runtime"

USER root
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

WORKDIR /opt/bridge
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
  && npm cache clean --force
COPY . .

RUN groupadd --gid 10001 bridge \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/bridge --shell /usr/sbin/nologin bridge \
  && chmod 0555 .githooks/pre-commit scripts/pre-commit-policy.mjs \
  && mkdir -p /workspace/repo /state \
  && chown 10001:10001 /home/bridge /workspace/repo /state

ENV NODE_ENV=production \
    HOME=/home/bridge \
    HOST=127.0.0.1 \
    PORT=8765 \
    BRIDGE_HARDENED=true \
    BRIDGE_STATE_DIR=/state \
    BRIDGE_SCRATCH_DIR=/state/scratch \
    WORKSPACE_ROOTS=/workspace/repo \
    DEFAULT_WORKSPACE=/workspace/repo \
    INCLUDE_COMMON_WORKSPACE_ROOTS=false \
    INCLUDE_SCRATCH_ROOT=false \
    ALLOW_TOOL_ROOT_REGISTRATION=false \
    DESTRUCTIVE_APPROVAL_MODE=deny \
    ALLOW_PRIVATE_NETWORK=false \
    ALLOW_CROSS_ORIGIN_REDIRECTS=false \
    TOOL_ENV_INHERIT_SECRETS=false \
    GIT_TERMINAL_PROMPT=0 \
    NPM_CONFIG_USERCONFIG=/dev/null

USER 10001:10001
WORKDIR /workspace/repo
CMD ["node", "/opt/bridge/src/server.js"]
