# Daemon Control Plane API Contract

**Status**: Implementation contract (Hub backend)
**Date**: 2026-04-23
**Source-of-truth design**: [`daemon-control-plane-plan.md`](./daemon-control-plane-plan.md)
**Audience**: Agent B (frontend, dashboard `/activate` + `/settings/daemons`) and Agent C (daemon + `@botcord/protocol-core`)

This document is the wire contract for the new `/daemon/*` endpoints introduced for the daemon control plane (P0 + P1 + P2 + P3 backend pieces). All routes live in `backend/hub/routers/daemon_control.py` and are registered on the main FastAPI app at the root path (no prefix beyond `/daemon`).

## 0. Conventions

- All HTTP bodies are `application/json` unless stated otherwise.
- Field names use `snake_case` on the wire (matches existing Hub conventions). The TypeScript client (`packages/protocol-core/src/daemon-client.ts`) accepts both `snake_case` and `camelCase` keys for backward compatibility.
- Timestamps are ISO 8601 strings (`...Z`) unless otherwise noted; control frames use unix milliseconds.
- Error responses use the project's standard structure: `{"detail": "...", "code"?: "...", "hint"?: null, "retryable": bool}`.
- Auth header is `Authorization: Bearer <token>`. The exact token type (Supabase user JWT vs daemon access JWT) depends on the route.

## 1. Auth Endpoints

### 1.1 `POST /daemon/auth/device-code`

Issued to a daemon to start the device-code login flow. No auth required.

**Request body**: `{}` (any optional `client_id` / `label` is ignored at this stage; label is bound at approve time).

**Response 200**:
```json
{
  "device_code": "dc_<32 hex chars>",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://botcord.chat/activate",
  "expires_in": 600,
  "interval": 5
}
```

- `device_code`: opaque secret kept by the daemon, used for polling.
- `user_code`: 8 chars, A–Z+2–9 alphabet, hyphenated as `XXXX-XXXX`. Visible to the user.
- `verification_uri`: where the user goes in a browser. Server uses `FRONTEND_BASE_URL` + `/activate`.
- `expires_in`: 600 (10 min).
- `interval`: 5 (seconds between `/device-token` polls).

### 1.2 `POST /daemon/auth/device-token`

Daemon polls this until the user approves.

**Request body**: `{ "device_code": "dc_..." }`

**Response 200 — pending**:
```json
{ "status": "pending" }
```

**Response 200 — approved (issues tokens, single-use)**:
```json
{
  "access_token": "<JWT>",
  "refresh_token": "<long random>",
  "expires_in": 3600,
  "user_id": "<uuid>",
  "daemon_instance_id": "dm_<12 hex>",
  "hub_url": "https://api.botcord.chat"
}
```

**Errors**:
- `400 invalid_device_code` — unknown `device_code`.
- `410 device_code_expired` — TTL passed.
- `403 device_code_denied` — explicitly denied by user (reserved; not exercised in P0).

After tokens are returned, the row is consumed: subsequent polls with the same `device_code` return `404`.

### 1.3 `POST /daemon/auth/device-approve`

Called by the dashboard once the logged-in user clicks "Authorize daemon".

**Auth**: Supabase user JWT (`require_user`).

**Request body**:
```json
{ "user_code": "ABCD-EFGH", "label": "MacBook Pro" }
```
(`label` optional, max 64 chars.)

**Response 200**:
```json
{
  "ok": true,
  "daemon_instance_id": "dm_...",
  "user_id": "<uuid>"
}
```

**Errors**:
- `400 invalid_user_code` — code unknown or already approved.
- `410 device_code_expired` — TTL passed.

Side effects:
- Inserts a `daemon_instances` row owned by the user.
- Generates and persists `refresh_token_hash` for the new instance.
- Writes the issued token bundle into the device_codes row, ready for the next `/device-token` poll.

### 1.4 `POST /daemon/auth/refresh`

Daemon trades a refresh token for a fresh access token.

**Auth**: none (refresh token is the credential).

**Request body**: `{ "refresh_token": "<...>" }`

**Response 200**: same shape as `/device-token` approved response. The server issues a brand-new `access_token` and **rotates** the `refresh_token` (the old one is invalidated by hash replacement).

**Errors**:
- `401 invalid_refresh_token` — unknown or revoked.
- `401 daemon_revoked` — instance has `revoked_at != NULL`.

Side effect: updates `daemon_instances.last_seen_at`.

## 2. Instance Management

All endpoints below require Supabase user JWT (`require_user`).

### 2.1 `GET /daemon/instances`

Lists the caller's daemon instances.

**Response 200**:
```json
{
  "instances": [
    {
      "id": "dm_...",
      "label": "MacBook Pro",
      "created_at": "2026-04-23T10:00:00Z",
      "last_seen_at": "2026-04-23T10:42:00Z",
      "revoked_at": null,
      "online": true
    }
  ]
}
```

`online` is computed from the in-memory WS registry (true iff a control WS is currently connected for that instance).

### 2.2 `POST /daemon/instances/{daemon_instance_id}/revoke`

Marks the refresh token invalid and pushes a signed `revoke` frame to the live WS if connected, then closes the socket with code `4403`.

**Response 200**: `{ "ok": true, "was_online": true }`

**Errors**:
- `404` — instance not found or not owned by user.

### 2.3 `POST /daemon/instances/{daemon_instance_id}/dispatch`

Dashboard-triggered control-frame send. The Hub signs the frame and pushes it to the live WS, then awaits the daemon's ack (timeout 30s).

**Request body**:
```json
{
  "type": "provision_agent",
  "params": { "name": "lazy-coder" },
  "timeout_ms": 15000
}
```

`type` must be one of: `provision_agent`, `revoke_agent`, `reload_config`, `list_agents`, `set_route`, `ping`.
`timeout_ms` is optional (default 30000, max 60000).

**Response 200** — daemon ack received:
```json
{
  "ok": true,
  "ack": {
    "id": "<request id>",
    "ok": true,
    "result": { "agentId": "ag_..." }
  }
}
```

**Errors**:
- `404` — instance not found / not owned.
- `409 daemon_offline` — no active WS for this instance.
- `504 daemon_ack_timeout` — daemon did not ack within `timeout_ms`.
- `400 unsupported_type` — `type` not in the allow-list above.

## 3. Control WebSocket — `GET /daemon/ws`

**Auth**: `Authorization: Bearer <access_token>`.

The bearer token is the daemon access JWT issued by `/device-token` / `/refresh` / `/token-paste`. It carries:
```json
{
  "sub": "<daemon_instance_id>",
  "user_id": "<uuid>",
  "daemon_instance_id": "dm_...",
  "kind": "daemon-access",
  "exp": <unix seconds>,
  "iss": "botcord-daemon"
}
```

On accept, the server:
1. Looks up `daemon_instances` by `daemon_instance_id` and ensures `revoked_at IS NULL`.
2. Registers the connection under `daemon_instance_id` (one slot per instance — opening a second WS displaces the first with close code `4001`).
3. Updates `last_seen_at`.
4. Sends a server `hello` frame:
   ```json
   { "id": "<uuid>", "type": "hello", "ts": 1745712000000, "params": {"server_time": 1745712000000}, "sig": "<base64>" }
   ```
5. Listens for inbound frames (acks + daemon-initiated events).

Auth failures close the socket immediately:
- `4401` — missing / invalid / expired token.
- `4403` — token valid but instance revoked.

### 3.1 Frame schema

Every frame is a single JSON message matching:

```ts
interface ControlFrame {
  id: string;                       // request id
  type: string;                     // see §3.2
  params?: Record<string, unknown>;
  sig?: string;                     // base64 Ed25519, required on Hub→daemon
  ts?: number;                      // unix millis (Hub→daemon always sets this)
}

interface ControlAck {
  id: string;                       // matches the request id
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
```

### 3.2 Defined `type` values

| `type` | Direction | `params` shape | Notes |
|---|---|---|---|
| `hello` | Hub→daemon | `{ server_time: number }` | Sent once on connect. No ack expected. |
| `ping` | Hub→daemon | `{}` | Daemon must ack with `{ ok: true, result: { pong: true } }`. |
| `provision_agent` | Hub→daemon | `{ name?: string, bio?: string, cwd?: string, adapter?: string, credentials?: {...} }` | `credentials` shape mirrors `ProvisionAgentParams` in `packages/protocol-core/src/control-frame.ts`. |
| `revoke_agent` | Hub→daemon | `{ agentId: string, deleteCredentials?: boolean }` | |
| `reload_config` | Hub→daemon | `{}` | Daemon re-reads `~/.botcord/daemon/config.json`. |
| `list_agents` | Hub→daemon | `{}` | Daemon acks with `{ agents: [{id, name, online}] }`. |
| `set_route` | Hub→daemon | `{ pattern: string, agentId: string }` | Adds a route binding. |
| `revoke` | Hub→daemon | `{ reason: string }` | Pushed by `/instances/{id}/revoke`. Daemon clears local user-auth and exits. |
| `agent_provisioned` | daemon→Hub | `{ agentId: string }` | Daemon-initiated event. Hub acks `{ ok: true }`. |
| `agent_revoked` | daemon→Hub | `{ agentId: string }` | Daemon-initiated event. |
| `pong` | daemon→Hub | `{}` | Optional spontaneous heartbeat. |

### 3.3 Signature

Hub→daemon frames are Ed25519-signed. Signing input is the canonical JSON of `{id, type, params, ts}` (sorted keys, no whitespace), then `Ed25519.sign(...)` on the bytes, base64-encoded.

```python
import jcs, base64
from nacl.signing import SigningKey
to_sign = jcs.canonicalize({"id": ..., "type": ..., "params": ..., "ts": ...})
sig = base64.b64encode(SigningKey(seed).sign(to_sign).signature).decode()
```

The daemon verifies with the embedded Hub control-plane public key (see §4).

Replay window: daemon must reject `abs(now - ts) > 5min` per the plan §8.3.

### 3.4 Idempotency / replay

The daemon dedupes by frame `id` (LRU of last 256). Hub does not need to dedupe inbound acks; it correlates by `id` and ignores unsolicited acks.

## 4. Hub Control-Plane Public Key

For Agent C to embed in `packages/protocol-core` (constant; do **not** modify protocol-core in this task):

```
H8lKtrtJclp+M69dh0n0avdia/kN8fy1tYUSrQFpDxY=
```

This is the default key baked into the Hub when no `BOTCORD_HUB_CONTROL_PRIVATE_KEY` is set. In production we'll override via env. The matching private key (committed only to local dev defaults — **rotate before prod**):

```
R9yHQWAP+oLdwuXW67TGSi/RWbkYPGf1a31by04W1zA=
```

Algorithm: `Ed25519` (raw 32-byte seed, base64). Public key is the standard `nacl.signing.VerifyKey` bytes, base64-encoded.

## 5. Database

Migration filename: `021_create_daemon_instances.sql`.

Tables:

```sql
create table if not exists daemon_instances (
    id                  varchar(32)  primary key,         -- dm_<12 hex>
    user_id             uuid         not null,
    label               varchar(64)  null,
    refresh_token_hash  varchar(128) not null,
    created_at          timestamptz  not null default now(),
    last_seen_at        timestamptz  null,
    revoked_at          timestamptz  null
);
create index if not exists ix_daemon_instances_user on daemon_instances (user_id);
create index if not exists ix_daemon_instances_refresh_hash on daemon_instances (refresh_token_hash);

create table if not exists daemon_device_codes (
    device_code         varchar(64)  primary key,
    user_code           varchar(16)  not null,
    user_id             uuid         null,
    daemon_instance_id  varchar(32)  null,
    expires_at          timestamptz  not null,
    approved_at         timestamptz  null,
    consumed_at         timestamptz  null,
    status              varchar(16)  not null default 'pending', -- pending | approved | consumed | denied
    issued_token_json   text         null,
    label               varchar(64)  null,
    created_at          timestamptz  not null default now(),
    constraint uq_daemon_device_codes_user_code unique (user_code)
);
create index if not exists ix_daemon_device_codes_status on daemon_device_codes (status, expires_at);
```

`refresh_token_hash` stores SHA-256 hex of the raw refresh token. `issued_token_json` is the JSON-serialized response that `/device-token` will return when the daemon next polls — wiped to `NULL` after consumption.

## 6. Configuration

New env vars added (all optional):

| Env | Default | Purpose |
|-----|---------|---------|
| `BOTCORD_HUB_CONTROL_PRIVATE_KEY` | dev key (see §4) | Base64 32-byte Ed25519 seed used to sign Hub→daemon control frames. |
| `DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS` | `3600` | Daemon access JWT TTL. |
| `DAEMON_DEVICE_CODE_TTL_SECONDS` | `600` | Device-code row TTL. |
| `DAEMON_DEVICE_CODE_INTERVAL_SECONDS` | `5` | Suggested poll interval reported to daemon. |
| `DAEMON_DISPATCH_DEFAULT_TIMEOUT_MS` | `30000` | Default ack-await timeout for `/instances/{id}/dispatch`. |

## 7. Open issues / divergences from the plan

- Frame signing canonicalization uses RFC 8785 (`jcs`), which the backend already depends on for envelope hashing. This keeps the daemon side simple (any JCS implementation works).
- The `revoke` frame type is exported as `CONTROL_FRAME_TYPES.REVOKE` in `packages/protocol-core/src/control-frame.ts`. On receipt the daemon writes `~/.botcord/daemon/auth-expired.flag`, acks, and tears down the control-plane WS — the agent data-plane channels keep running with their existing tokens (plan §6.3).
- The paste-token bootstrap from plan §11.1 P0 is intentionally not implemented. P1 device-code is the only login path; non-interactive environments must mount a pre-existing `~/.botcord/daemon/user-auth.json` (plan §6.4).
