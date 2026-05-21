# syntax=docker/dockerfile:1.7
#
# BotCord cloud-agent sandbox image.
#
# Single-stage build: the E2B template builder (CLI 2.x / SDK) does not yet
# support multi-stage Dockerfiles, so the build toolchain ends up in the final
# image. The extra ~150MB is acceptable inside an E2B sandbox.
#
# Base is Ubuntu 24.04 / glibc 2.39 — required by the deepseek-tui prebuilt
# binary the npm wrapper downloads.
#
# Build context is the repo root so the COPYs below can reach
# packages/protocol-core and packages/daemon:
#   docker build -f e2b/e2b.Dockerfile -t botcord-cloud-agent:dev .
#
# E2B build (publishes the template):
#   cd <repo root>
#   e2b template create botcord-cloud-agent-dev3 \
#       -d e2b/e2b.Dockerfile \
#       -c "/usr/bin/tini -- /usr/local/bin/entrypoint.sh"

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    NODE_MAJOR=20 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    BOTCORD_HOME=/home/agent/.botcord

# Base toolchain + tini for PID-1 duties.
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
        libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/*

# Node 20 via NodeSource. Manually register the repo with an APT pin so apt
# picks NodeSource's `nodejs` (with npm) instead of Ubuntu Noble's bundled
# 18.x package (no npm).
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

# deepseek-tui (npm wrapper downloads the matching prebuilt Rust binary).
RUN npm install -g --no-audit --no-fund deepseek-tui@0.8.39

# Build @botcord/protocol-core + @botcord/daemon from monorepo source. Layout
# under /opt/botcord matches the `file:../protocol-core` workspace path the
# daemon's package.json points at.
RUN mkdir -p /opt/botcord

COPY packages/protocol-core/package.json /opt/botcord/protocol-core/package.json
COPY packages/protocol-core/tsconfig.json /opt/botcord/protocol-core/tsconfig.json
RUN cd /opt/botcord/protocol-core \
 && npm install --no-audit --no-fund --ignore-scripts
COPY packages/protocol-core/src /opt/botcord/protocol-core/src
RUN cd /opt/botcord/protocol-core && npm run build

COPY packages/daemon/package.json /opt/botcord/daemon/package.json
COPY packages/daemon/tsconfig.json /opt/botcord/daemon/tsconfig.json
COPY packages/daemon/tsconfig.build.json /opt/botcord/daemon/tsconfig.build.json
RUN cd /opt/botcord/daemon \
 && npm install --no-audit --no-fund --ignore-scripts
COPY packages/daemon/src /opt/botcord/daemon/src
RUN cd /opt/botcord/daemon && npm run build

# Expose botcord-daemon as a PATH-resolvable command (dist entry already has
# `#!/usr/bin/env node`).
RUN chmod +x /opt/botcord/daemon/dist/index.js \
 && ln -s /opt/botcord/daemon/dist/index.js /usr/local/bin/botcord-daemon

# Non-root user — E2B sandboxes and most container runtimes expect this.
# Ubuntu 24.04 ships a default `ubuntu` user at uid 1000/1001, so pick 1100
# to avoid the collision.
RUN useradd -m -s /bin/bash -u 1100 agent \
 && mkdir -p ${BOTCORD_HOME} \
 && chown -R agent:agent /home/agent

COPY --chown=root:root e2b/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /home/agent

# tini reaps zombies and forwards signals from E2B / docker to the daemon.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD []
