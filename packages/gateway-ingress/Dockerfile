# Build + runtime image for @botcord/gateway-ingress.
#
# Build context = repo root (so we can include the sibling protocol-core
# package). Invoke from repo root:
#
#   docker build -f packages/gateway-ingress/Dockerfile \
#       -t botcord-gateway-ingress:preview .
#
# Multi-stage to keep the runtime image free of TypeScript / dev tooling.

# ───────────────────────────── build stage ──────────────────────────────────
FROM node:22-slim AS build
WORKDIR /build

# Build protocol-core first so gateway-ingress can resolve `file:../protocol-core`.
COPY packages/protocol-core/package.json packages/protocol-core/tsconfig.json packages/protocol-core/
COPY packages/protocol-core/src packages/protocol-core/src
RUN cd packages/protocol-core \
    && npm install --no-audit --no-fund \
    && npm run build

# Build gateway-ingress.
COPY packages/gateway-ingress/package.json \
     packages/gateway-ingress/tsconfig.json \
     packages/gateway-ingress/tsconfig.build.json \
     packages/gateway-ingress/
COPY packages/gateway-ingress/src packages/gateway-ingress/src
RUN cd packages/gateway-ingress \
    && npm install --no-audit --no-fund \
    && npm run build

# ─────────────────────────── runtime stage ─────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bring the compiled protocol-core in alongside its package.json (no src,
# no devDeps) so the `file:` dependency in gateway-ingress resolves.
COPY --from=build /build/packages/protocol-core/package.json packages/protocol-core/package.json
COPY --from=build /build/packages/protocol-core/dist        packages/protocol-core/dist

# gateway-ingress: just the compiled dist + its own manifest. Production
# install pulls only `ws` + the protocol-core file dep — everything else
# is dev-only.
COPY packages/gateway-ingress/package.json packages/gateway-ingress/
COPY --from=build /build/packages/gateway-ingress/dist packages/gateway-ingress/dist
RUN cd packages/gateway-ingress \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Default data dirs — operators should bind-mount real volumes here.
RUN mkdir -p /data /secrets && chmod 700 /secrets
ENV BOTCORD_INGRESS_DATA_DIR=/data \
    BOTCORD_INGRESS_SECRET_DIR=/secrets \
    BOTCORD_INGRESS_HEALTH_HOST=0.0.0.0 \
    BOTCORD_INGRESS_HEALTH_PORT=9100

EXPOSE 9100
CMD ["node", "packages/gateway-ingress/dist/cli.js"]
