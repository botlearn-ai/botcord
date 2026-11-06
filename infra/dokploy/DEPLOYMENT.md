# Dokploy deployment — 2026-11-06

Target: [BotCord / production](https://console.botlearn.ai/dashboard/project/5UIS5-vklz4ac_SW1TgtP/environment/5he_zWMNfE-ED_oN47Nc5)

## Current scope

- Five running containers: frontend, Hub, Gateway Ingress, PostgreSQL, Redis.
- Existing Preview Supabase is reused for Auth, Realtime, Storage, and the application DB;
  Supabase is **not** deployed here.
- Hub and frontend server routes connect to the same existing Supabase database.
- The verified Hub uses the existing project's JWKS validation path, service-role, Supabase
  Storage backend, and configured Storage bucket; none are frontend build arguments.
- The dedicated PostgreSQL container/volume is retained and healthy but is not the current
  business database.
- The added Hub has schema auto-create and periodic background tasks disabled.
- Public domain targets are `https://www.test.botcord.chat` for frontend and
  `https://api.test.botcord.chat` for Hub; both DNS records resolve to `18.162.90.1`.
- Dokploy Domain targets are frontend port `3000` and Hub port `8000`, with HTTPS and
  Let's Encrypt. No host ports are published.
- SSH loopback forwards (`localhost:28080` and `localhost:28000`) remain available for
  private diagnostics only.

Although the Dokploy environment is named `production`, this is not data-isolated production:
it deliberately shares the Preview Supabase project.

> **Single-Hub canary only:** use the new endpoint only for new/QA agents pinned to the added Hub.
> Do not move or operate existing agents that still callback to the old Hub. This is not
> active-active: owner-chat flows, status, and realtime fanout are not interoperable across the
> two Hubs, and no agent-inference workflow was executed in this acceptance run.

## Compose resources

| Resource | Compose ID | Source/status |
| --- | --- | --- |
| `botcord-data` | `H9btOji5YQgfUL4AWycw2` | Raw / done |
| `botcord-backend` | `Ug07R-0ic81Rm8uHA1SE6` | Raw / done |
| `botcord-gateway-ingress` | `4cHGyGZLYTEe7dTxtaFIe` | Raw / done |
| `botcord-frontend` | `amZUZW2R40fAmNop14Zbc` | Raw / done |

Saved Raw manifests matched the files in this directory at verification time. A later Git
change does not automatically update these resources.

## Verified runtime snapshot

Both Domain deployments reported `done`. All five containers were `healthy`, had zero restarts,
and had no host port bindings. Frontend and Hub each use their Compose default network,
`botcord-production`, and `dokploy-network`; Gateway, Redis, and PostgreSQL use only
`botcord-production`. Traefik is explicitly pinned to `dokploy-network`.

### Frontend

- Container: `botcord-frontend-hdarg2-botcord-frontend-1`
- Image: `928112001319.dkr.ecr.us-east-1.amazonaws.com/botlearn-ai/botcord-frontend@sha256:1154bfeeaf177f8df63dbbe0f70f818c21d75153545ce683ac6dda882e487e8b`
- Runtime imageID: `sha256:a39185a924a4b6a53bea8f0002f4bd2252f19a336824d3a493d9238f8ec0d6a9`
- Deployment: `U_edjUVBIl1VZ3I5A-ifI` / `done`

### Hub

- Container: `botcord-backend-trvtoz-botcord-backend-1`
- Image: `928112001319.dkr.ecr.us-east-1.amazonaws.com/botlearn-ai/botcord-backend@sha256:d60e69a867ef72114a27a7ee3c3278646868e1e2435c93cda45a513d7855699b`
- Runtime imageID: `sha256:820f6a9e5b320e0f53d1675e663b11cd8f2ff510856c0b0c5d1ee390434eee74`
- Volume: `botcord-backend-trvtoz_botcord_uploads` → `/data/uploads`

### Gateway Ingress

- Container: `botcord-gateway-ingress-eymfyp-botcord-gateway-ingress-1`
- Image: `928112001319.dkr.ecr.us-east-1.amazonaws.com/botlearn-ai/botcord-gateway-ingress@sha256:c07a3695fe9ba623fc1983dcfa09a818b835621ece7f3738c6af0957ac39d641`
- Runtime imageID: `sha256:b7b6ac1e5ac50c594b4b7f0da8874934c228257b3bfba94e1a7112a6b166db2d`
- Volumes:
  - `botcord-gateway-ingress-eymfyp_botcord_gateway_ingress_data` → `/data`
  - `botcord-gateway-ingress-eymfyp_botcord_gateway_ingress_secrets` → `/secrets`

### Redis

- Container: `botcord-data-rhhgnk-redis-1`
- Image: `redis:7-alpine`
- Runtime imageID: `sha256:c90c016450904cc9c63d38100c04c72554fcc983e257f1637ab451afaf32da7b`
- Volume: `botcord-data-rhhgnk_botcord_redis_data` → `/data`
- Runtime check: `PING` succeeded and one subscriber connection was observed.
- The old Preview Redis is a private `us-east-1` ElastiCache endpoint that is not reachable from
  the Hong Kong host; this deployment did not change that topology.

### Retained PostgreSQL

- Container: `botcord-data-rhhgnk-postgres-1`
- Image: `postgres:16-alpine`
- Runtime imageID: `sha256:c54a696c68013b2f8f42f479e00a2b6ad24c5ef10ee31cdfb8972cec3dad7eb7`
- Volume: `botcord-data-rhhgnk_botcord_postgres_data` → `/var/lib/postgresql/data`
- Current role: retained only; not used by frontend/Hub as the business DB.

## Acceptance evidence

- Local five-container Compose stack: all healthy; frontend `18080`, Hub `18000`.
- Remote five-container stack: all healthy, zero restarts, no host ports.
- A private, temporary QA Realtime topic reached `SUBSCRIBED` and closed cleanly.
- Realtime SDK client `send` returned `error`; the separate service-role targeted admin broadcast
  was accepted and received by the subscribed client.
- Credentials were not written to this document or the sanitized QA result.
- The temporary QA Auth account and its six application rows were deleted after acceptance;
  both Auth and application identity absence were verified.
- The latest saved remote manifests reported deployment `done` and matched the expected manifests;
  all five containers remained healthy with zero restarts and no host port bindings.
- Latest verification suites: infrastructure 20 passed; backend/repository suites 48 passed and
  3 skipped.

## Public-domain activation

- DNS validation passed for `www.test.botcord.chat` and `api.test.botcord.chat`; both resolved to
  the Dokploy host `18.162.90.1`.
- Frontend and Hub Domains are enabled with exact host rules and service ports `3000` and `8000`.
- HTTPS is valid on both domains; HTTP redirects to HTTPS with status `301`.
- The frontend Let's Encrypt certificate is valid from 2026-11-06 through 2027-02-04.
- `https://api.test.botcord.chat/health` returned HTTP 200.
- Hub CORS returned HTTP 200 with the exact `https://www.test.botcord.chat` origin.
- `/auth/callback` returned 307 to
  `https://www.test.botcord.chat/login?error=auth_callback_failed`; it no longer exposes the
  container origin.
- Fresh browser acceptance showed Login for anonymous `/chats`, then completed email/password
  login to the named user's Dashboard and a fresh `/chats/messages` load. Authenticated BFF
  returned 200, the same boundary without a cookie returned 401, and all 21 static assets returned
  200.
- The authenticated browser made 57 requests, including 12 API requests; every HTTP status was
  below 400. Page errors, Vercel Insights requests, and localhost requests were all zero.
- WebSocket `/dashboard/chat/ws` accepted the exact frontend Origin and closed an invalid token
  with code 4001; a malicious Origin was rejected with HTTP 403.
- Supabase redirect allowlist readback preserved existing entries and the site URL, and added
  `https://www.test.botcord.chat` plus `https://www.test.botcord.chat/**`.
- The replacement image passed targeted tests, production build, standalone public callback
  location, and Analytics-removal checks before the live checks above.
- The temporary public-domain QA Auth account and its six task-owned application rows were
  deleted with strict ownership checks; Auth returned 404 and the application user count was zero.

## Remaining boundaries and rollback

- Agent inference, actual Google/GitHub account authorization, Stripe/payment, Resend/email, Cloud
  Agent paid runtime, and other external messaging integrations were not tested.
- The added Hub uses its own Redis. Shared Supabase provides persistent data, not cross-Hub
  owner-chat/status delivery. Cross-deployment fanout is not available in this topology; even a
  future shared Redis would retain a process-local trace gap in the current code path.
- Treat this endpoint as a single-Hub canary for new/QA agents pinned to it. Existing agents that
  still callback to the old Hub must not be operated through it, and no agent inference loop was
  accepted in this run.
- Gateway health and internal authentication boundaries passed, but provider-specific gateway
  workflows were not accepted end-to-end.
- Preserve all appNames, credentials, and volumes. Do not use `freshVolumes`, `down -v`, or volume
  cleanup for rollback.
- Roll back application containers by restoring the previous pinned image digest and redeploying.
- Re-read live containers, imageIDs, health, restarts, networks, mounts, and tunnel behavior before
  relying on this dated snapshot.
