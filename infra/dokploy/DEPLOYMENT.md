# Dokploy deployment — 2026-11-06

Target: [BotCord / production](https://console.botlearn.ai/dashboard/project/5UIS5-vklz4ac_SW1TgtP/environment/5he_zWMNfE-ED_oN47Nc5)

## Test deployment pipeline

All four Compose resources now use GitHub Provider: `botlearn-ai/botcord`, provider
`DokployForBotLearn`, Auto Deploy disabled. The verified source tag is
`dokploy-test-6f108dde6bb77fea980558e3e45bb578cad306ee`.

- [Verified complete CI deployment](https://github.com/botlearn-ai/botcord/actions/runs/42201483086)
- [Verified PR checks](https://github.com/botlearn-ai/botcord/actions/runs/42201491463)
- [Implementation PR](https://github.com/botlearn-ai/botcord/pull/1130)

Main pushes use this pipeline after checks; PR events do not deploy. The manual PR entry
now deploys the whole Dokploy test stack. Existing production releases remain unchanged.
Vercel Git Preview builds are skipped; production builds and CLI releases remain enabled.
ECR credentials use existing automatic refresh; no additional renewal task was retained.

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
| `botcord-data` | `H9btOji5YQgfUL4AWycw2` | GitHub / done |
| `botcord-backend` | `Ug07R-0ic81Rm8uHA1SE6` | GitHub / done |
| `botcord-gateway-ingress` | `4cHGyGZLYTEe7dTxtaFIe` | GitHub / done |
| `botcord-frontend` | `amZUZW2R40fAmNop14Zbc` | GitHub / done |

Each resource clones its path in `infra/dokploy/` from the fixed commit tag. A later Git
change does not deploy until CI updates the source tag and image digests. The Provider
migration preserved appNames, runtime environment values, Domains, and volumes.

Latest completed deployment IDs: data `MOSqgoQn42C1wSdJ0gVTp`, backend `WaWe9YOcJX3Ub4n2fHz-T`, gateway `bkIOXCU8nMlx_VzA2fWpQ`, frontend `fRkVJAyVbFkWWhba-PE23`.

## Verified runtime snapshot

Both Domain deployments reported `done`. All five containers were `healthy`, had zero restarts,
and had no host port bindings. Frontend and Hub each use their Compose default network,
`botcord-production`, and `dokploy-network`; Gateway, Redis, and PostgreSQL use only
`botcord-production`. Traefik is explicitly pinned to `dokploy-network`.

### Frontend

- Container: `botcord-frontend-hdarg2-botcord-frontend-1`
- Image: `928112001319.dkr.ecr.us-east-1.amazonaws.com/botlearn-ai/botcord-frontend@sha256:41d124b70c1b4b964969dbd83b8296fb621a01d12e88f337f351406f54b45487`
- Runtime imageID: `sha256:33f22600d6f791bf38fde1e565fd304a4c86d7a34dc3dd5ae80f15f565e9f206`
- Source revision: `6f108dde6bb77fea980558e3e45bb578cad306ee`

### Hub

- Container: `botcord-backend-trvtoz-botcord-backend-1`
- Image: `928112001319.dkr.ecr.us-east-1.amazonaws.com/botlearn-ai/botcord-backend@sha256:bac01e97999f9cf0c6d2daf947f299b170cac643e4fe6119585e3dae5e6605ff`
- Runtime imageID: `sha256:9babf3a0b538bcbe2cb393503e469982423696ee8e135724fd8d25f0c9ebc060`
- Volume: `botcord-backend-trvtoz_botcord_uploads` → `/data/uploads`
- Source revision: `6f108dde6bb77fea980558e3e45bb578cad306ee`

### Gateway Ingress

- Container: `botcord-gateway-ingress-eymfyp-botcord-gateway-ingress-1`
- Image: `928112001319.dkr.ecr.us-east-1.amazonaws.com/botlearn-ai/botcord-gateway-ingress@sha256:08eb4937655aadf04fe0346b54d31d5ee6950703d9c60c0536e650e8021360fb`
- Runtime imageID: `sha256:7135b8d4fda48fce5060aefc9ca7796704fad5456cb934202391c207ce3b9d89`
- Volumes:
  - `botcord-gateway-ingress-eymfyp_botcord_gateway_ingress_data` → `/data`
  - `botcord-gateway-ingress-eymfyp_botcord_gateway_ingress_secrets` → `/secrets`
- Source revision: `6f108dde6bb77fea980558e3e45bb578cad306ee`

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
- Latest full local suites: infrastructure 45 passed; backend 1810 passed / 59 skipped;
  frontend 839 passed / 1 skipped. PR checks and the complete CI deployment also passed.
- After the CI rebuild, all five containers were independently read back healthy, with zero
  restarts and no host ports. The three app images carried the expected source revision.
  Homepage, 21 static assets, healths, exact-origin CORS and canonical auth callback were rechecked.
  The real-login evidence below predates this equivalent-application-source rebuild.

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
