# syntax=docker/dockerfile:1.7
#
# BotCord cloud-agent sandbox image.
#
# Layers in two stages:
#   1) builder  — compiles @botcord/protocol-core and @botcord/daemon from
#                 monorepo source. Output lives under /opt/botcord/.
#   2) runtime  — Ubuntu 24.04 / glibc 2.39 (required for the deepseek-tui
#                 prebuilt binary), Node 20, the built daemon, and globally
#                 installed deepseek-tui.
#
# Build from the repo root so the build context contains packages/protocol-core
# and packages/daemon:
#   docker build -f e2b/e2b.Dockerfile -t botcord-cloud-agent:dev .

# ===========================================================================
# Stage 1 — builder
# ===========================================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /build

# protocol-core: install deps, then COPY src and build. Splitting the COPY
# lets Docker cache `npm install` across source-only edits.
COPY packages/protocol-core/package.json packages/protocol-core/tsconfig*.json /build/protocol-core/
RUN cd /build/protocol-core \
 && npm install --no-audit --no-fund --ignore-scripts
COPY packages/protocol-core/src /build/protocol-core/src
RUN cd /build/protocol-core && npm run build

# daemon: depends on protocol-core via `file:../protocol-core`. Lay the
# directory tree out the same way (so the relative path resolves), then
# install + build.
COPY packages/daemon/package.json packages/daemon/tsconfig*.json /build/daemon/
RUN cd /build/daemon \
 && npm install --no-audit --no-fund --ignore-scripts
COPY packages/daemon/src /build/daemon/src
RUN cd /build/daemon && npm run build

# ===========================================================================
# Stage 2 — runtime
# ===========================================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    NODE_MAJOR=20 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    BOTCORD_HOME=/home/agent/.botcord

# Base toolchain + tini for PID-1 duties.
# deepseek-tui prebuilt binary needs glibc 2.39 which Ubuntu 24.04 provides.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        tini \
        bash \
        python3 \
        python3-pip \
        gnupg \
        passwd \
 && rm -rf /var/lib/apt/lists/*

# Node 20 via NodeSource. We register the repo manually and pin the priority
# above the distro's own `nodejs` package so apt picks the NodeSource build
# instead of Ubuntu Noble's bundled 18.x (which lacks npm).
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    chmod a+r /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 1001\n' \
      > /etc/apt/preferences.d/nodesource; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*; \
    node --version; \
    npm --version

# deepseek-tui (downloads matching prebuilt Rust binary from GitHub Releases).
RUN npm install -g --no-audit --no-fund deepseek-tui@0.8.39

# Pull built daemon + protocol-core from the builder. node_modules is included
# because `file:` workspace deps cannot be resolved later.
RUN mkdir -p /opt/botcord
COPY --from=builder /build/protocol-core /opt/botcord/protocol-core
COPY --from=builder /build/daemon        /opt/botcord/daemon

# Expose botcord-daemon as a PATH-resolvable command. The dist entry already
# has a `#!/usr/bin/env node` shebang.
RUN chmod +x /opt/botcord/daemon/dist/index.js \
 && ln -s /opt/botcord/daemon/dist/index.js /usr/local/bin/botcord-daemon

# Non-root user — E2B sandboxes and most container runtimes expect this.
RUN useradd -m -s /bin/bash -u 1001 agent \
 && mkdir -p ${BOTCORD_HOME} \
 && chown -R agent:agent /home/agent

COPY --chown=root:root e2b/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /home/agent

# tini reaps zombies and forwards signals from the orchestrator (E2B / docker)
# to the daemon process.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD []
