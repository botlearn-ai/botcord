# syntax=docker/dockerfile:1

FROM node:24-slim AS dependencies
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace

FROM dependencies AS builder

# NEXT_PUBLIC_* values are intentionally public and are embedded in browser
# bundles by Next.js. Do not add server secrets or database credentials here.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_HUB_BASE_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_BETA_GATE_ENABLED=false
ARG NEXT_PUBLIC_GA_ID=
ARG SHOW_MESSAGE_STATUS=true

ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_HUB_BASE_URL=${NEXT_PUBLIC_HUB_BASE_URL} \
    NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_BETA_GATE_ENABLED=${NEXT_PUBLIC_BETA_GATE_ENABLED} \
    NEXT_PUBLIC_GA_ID=${NEXT_PUBLIC_GA_ID} \
    SHOW_MESSAGE_STATUS=${SHOW_MESSAGE_STATUS} \
    NEXT_TELEMETRY_DISABLED=1

RUN node -e 'for (const name of ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_HUB_BASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) { if (!process.env[name]) throw new Error(`Missing required public build variable: ${name}`); }'

COPY . .
RUN pnpm build

FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
