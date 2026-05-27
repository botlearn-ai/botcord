# Build + runtime image for @botcord/gateway-ingress.
#
# Build context = repo root so we can include the workspace lockfile and
# the sibling `packages/protocol-core` source. Invoke from repo root:
#
#   docker build -f packages/gateway-ingress/Dockerfile \
#       -t botcord-gateway-ingress:preview .
#
# Multi-stage to keep the runtime image free of TypeScript / dev tooling.
# Uses `pnpm deploy --prod` to emit a self-contained production tree with
# workspace:^ dependencies resolved to real package contents.

# ───────────────────────────── build stage ──────────────────────────────────
FROM node:22-slim AS build
WORKDIR /repo

# Enable corepack so the pinned pnpm version from package.json is used.
RUN corepack enable

# Copy workspace manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol-core/package.json packages/protocol-core/
COPY packages/gateway-ingress/package.json packages/gateway-ingress/

# Install only the deps needed to build protocol-core + gateway-ingress.
RUN pnpm install --frozen-lockfile \
    --filter @botcord/protocol-core... \
    --filter @botcord/gateway-ingress...

# Bring in sources and build.
COPY packages/protocol-core/tsconfig.json packages/protocol-core/
COPY packages/protocol-core/src packages/protocol-core/src
COPY packages/gateway-ingress/tsconfig.json packages/gateway-ingress/
COPY packages/gateway-ingress/tsconfig.build.json packages/gateway-ingress/
COPY packages/gateway-ingress/src packages/gateway-ingress/src

RUN pnpm --filter @botcord/protocol-core build \
 && pnpm --filter @botcord/gateway-ingress build

# Emit a self-contained production tree at /deploy. `pnpm deploy` resolves
# workspace:^ refs, includes only prod deps, and inlines protocol-core's
# compiled dist into node_modules/@botcord/protocol-core.
RUN pnpm --filter @botcord/gateway-ingress deploy --prod /deploy

# ─────────────────────────── runtime stage ─────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /deploy ./

# Default data dirs — operators should bind-mount real volumes here.
RUN mkdir -p /data /secrets && chmod 700 /secrets
ENV BOTCORD_INGRESS_DATA_DIR=/data \
    BOTCORD_INGRESS_SECRET_DIR=/secrets \
    BOTCORD_INGRESS_HEALTH_HOST=0.0.0.0 \
    BOTCORD_INGRESS_HEALTH_PORT=9100

EXPOSE 9100
CMD ["node", "dist/cli.js"]
