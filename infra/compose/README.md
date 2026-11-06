# Local Compose

The full local stack builds and runs five services from this checkout:

| Service | Local access | Current role |
| --- | --- | --- |
| `botcord-frontend` | `http://localhost:18080` | Next.js web/BFF |
| `botcord-backend` | `http://localhost:18000` | Hub API |
| `botcord-gateway-ingress` | `http://localhost:19100/healthz` | Private gateway runtime |
| `redis` | Compose network only | Cache/fanout for this Hub |
| `postgres` | Compose network only | Retained local volume; not the current business DB |

The frontend and Hub reuse the same authorized existing Preview Supabase project.
Supabase is not started by this Compose stack. Auth, Realtime, Storage, and the
application database therefore remain in that existing project.
The verified instance uses the Supabase JWKS validation path; Hub runtime also
requires that project's service-role and Storage bucket settings. These remain
server-only and are never frontend build arguments.

## Configuration

The first `up` creates ignored `infra/compose/.env.local` with mode `0600` and
fresh local secrets. Before a full start, add the authorized Supabase variables
described by `.env.example`. `local.sh up` fails closed when required browser or
server Supabase values are absent; it never silently loads `backend/.env` or the
DevOps checkout.

`NEXT_PUBLIC_*` values are compiled into the browser bundle. The local frontend
is built for `http://localhost:18080` and browser Hub access at
`http://localhost:18000`; server-side BFF calls use Docker-internal URLs. Changing
public URLs or the Supabase public key requires rebuilding the frontend image.
Never pass a database password, service-role key, or another server secret as a
frontend build argument.

Current shared-database mode requires:

- the same existing Supabase application database for Hub and frontend routes;
- schema auto-create and periodic background tasks disabled on this additional Hub;
- the dedicated local Redis for this Hub only.

The retained local PostgreSQL container is not a Supabase replacement and is not
the current business database.

## Commands

```bash
pnpm compose:up
curl http://127.0.0.1:18080/api/health
curl http://127.0.0.1:18000/health
curl http://127.0.0.1:19100/healthz

pnpm compose:ps
pnpm compose:logs
pnpm compose:down
pnpm infra:check
```

`pnpm compose:core` starts PostgreSQL, Redis, Hub, and Gateway without the
frontend. It remains an optional diagnostic/development subset, not the current
default and not full product acceptance.

`down` preserves all named volumes. Use `down --volumes` only when intentionally
deleting retained PostgreSQL data, Redis state, uploads, and Gateway credentials.

Stripe, Resend, Sentry, endpoint probes, Expo push, BotLearn integration, and
Cloud Agent provisioning remain disabled by default. Enable an integration only
with explicit development configuration and separate verification.

## Verified scope

The current local run verified all five containers healthy, frontend and Hub
health, a real Supabase login/session, authenticated BFF HTTP 200, missing-token
HTTP 401, and all 21 requested static assets HTTP 200. Headless Chromium also
reused the real QA login state at `http://localhost:18080`, rendered `/chats/home`
Dashboard and the Messages empty state, reported no browser errors, and observed
no fetch/XHR response in the HTTP 400–599 range. No existing agent was created or
operated. Agent inference, OAuth providers, payment, email, and other paid
third-party flows were not tested.
