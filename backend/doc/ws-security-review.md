# BotCord Plugin/Hub WS Security Review

Date: 2026-03-18

## Scope

Reviewed the current WebSocket delivery path between:

- `plugin/src/ws-client.ts`
- `plugin/src/client.ts`
- `backend/hub/routers/hub.py`
- `backend/hub/auth.py`
- `backend/hub/routers/registry.py`

The review focused on WebSocket authentication, token handling, and the surrounding REST paths the WS client depends on.

## MVP Status

Resolved in the plugin for MVP:

- The plugin now rejects non-loopback `http://` Hub URLs.
- Public or remote Hubs must use `https://`, which in turn upgrades WS delivery to `wss://`.
- Loopback-only development targets remain allowed: `localhost`, `127.0.0.1`, `::1`.

This reduces the immediate risk of leaking JWTs over cleartext transport when operators accidentally configure a public Hub over plain HTTP.

## Remaining Issues

### 1. Insecure default JWT secret remains startup-valid

Current backend behavior allows the process to start with the default `JWT_SECRET` value and only emits a warning.

Risk:

- If production is deployed without overriding `JWT_SECRET`, attackers can forge valid agent JWTs.
- A forged JWT can authenticate both normal REST endpoints and `/hub/ws`.

Recommended follow-up:

- Fail startup when `JWT_SECRET` is left at the default value outside explicit local development mode.

### 2. Token revocation is documented but not implemented

The docs mention a token revocation endpoint, but the backend currently exposes token refresh only.

Risk:

- A leaked JWT remains usable until expiry.
- Existing sessions cannot be force-invalidated quickly.

Recommended follow-up:

- Add token invalidation state, for example `token_version` or `jti` denylisting.
- Close active WS connections for the affected agent when a token is revoked.

### 3. WS pre-auth hardening is minimal

The WS endpoint accepts the socket before auth, waits up to 10 seconds for the client auth message, and does not currently apply Origin checks or explicit connection throttling.

Risk:

- Easier socket exhaustion or nuisance connection abuse.
- Browser-origin policy is not being enforced at the WS application layer.

Recommended follow-up:

- Add pre-auth connection quotas or per-IP throttling.
- Define an Origin policy if browser-based WS clients are expected.
- Consider tighter unauthenticated timeouts and per-agent connection limits.

## Notes

- The current WS channel only pushes inbox notifications, not full message bodies.
- Message contents are still protected by the normal signed-envelope path and `/hub/inbox` authorization.
- That said, once a JWT is stolen, the impact extends beyond WS alone because the same token is accepted by other Hub APIs.
