# Cloud Gateway Ingress — Operations Runbook

This document is the operator-facing companion to
`docs/cloud-gateway-ingress-remediation-plan.md`. It covers deploying,
rotating secrets for, and migrating data into the
`@botcord/gateway-ingress` service.

## 1. Environment Variables

### 1.1 Ingress service (`@botcord/gateway-ingress`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOTCORD_INGRESS_HUB_URL` | `http://localhost:9000` | Hub base URL (no trailing slash) the ingress calls for `ensure-running` / `touch`. |
| `BOTCORD_INGRESS_SECRET` | _required_ | Shared secret. Must equal Hub's `CLOUD_GATEWAY_INGRESS_SECRET`. |
| `BOTCORD_INGRESS_DATA_DIR` | `~/.botcord/gateway-ingress/data` | Root for `connections/`, `state/`, `events/`, `deliveries/` JSON. |
| `BOTCORD_INGRESS_SECRET_DIR` | `~/.botcord/gateway-ingress/secrets` | Per-gateway secret blobs (mode 0600). |
| `BOTCORD_INGRESS_HEALTH_PORT` | `9100` | HTTP `/healthz` + `/status` port. `0` disables. |
| `BOTCORD_INGRESS_HEALTH_HOST` | `127.0.0.1` | Health bind host. |
| `BOTCORD_INGRESS_SETUP_PORT` | `9101` | Internal setup HTTP port for Hub→ingress proxy. `0` disables. |
| `BOTCORD_INGRESS_SETUP_HOST` | `127.0.0.1` | Setup bind host. |
| `BOTCORD_INGRESS_RUNTIME_ENDPOINT` | _(unset)_ | Optional override for the runtime WS endpoint Hub advertises. |
| `BOTCORD_INGRESS_DEDUPE_CAPACITY` | `1024` | Per-gateway dedupe ring buffer. |
| `BOTCORD_INGRESS_DEBUG` | _(unset)_ | Set to `1` to enable debug logs. |

### 1.2 Hub side (`backend/`)

| Variable | Purpose |
| --- | --- |
| `CLOUD_GATEWAY_INGRESS_BASE_URL` | Base URL Hub uses to reach ingress (e.g. `http://gateway-ingress:9101`). When unset, cloud-agent gateway routes return 503. |
| `CLOUD_GATEWAY_INGRESS_SECRET` | Shared secret. Must equal `BOTCORD_INGRESS_SECRET`. |

## 2. Process Management

### 2.1 Start the service

```bash
cd packages/gateway-ingress
npm run build
node dist/cli.js start    # or: node dist/cli.js (default subcommand)
```

The CLI registers `SIGINT` / `SIGTERM` for graceful shutdown.

### 2.2 Healthcheck endpoints

The health server exposes two routes on `BOTCORD_INGRESS_HEALTH_PORT`:

- `GET /healthz` — `200` when the service has finished boot.
- `GET /status` — JSON snapshot including `connections.running[]` (gateway
  ids actively polling/listening) and last-error counters per provider.

Recommended container probe:

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 9100 }
  initialDelaySeconds: 5
readinessProbe:
  httpGet: { path: /status, port: 9100 }
  periodSeconds: 10
```

## 3. Rotating the Ingress Shared Secret

`BOTCORD_INGRESS_SECRET` (ingress) and `CLOUD_GATEWAY_INGRESS_SECRET` (Hub)
must match exactly. The MVP does not accept two secrets at once, so
rotation requires a brief synchronous swap:

1. Generate the new secret: `openssl rand -hex 32`.
2. Deploy the new secret to BOTH ingress and Hub in the same change
   window. Ingress goes first so it is ready to accept the Hub's first
   authenticated call with the new value.
3. Restart ingress, then restart Hub.
4. Verify: from a Hub host, hit any cloud-agent gateway route (e.g.
   `POST /api/agents/<cloud-agent>/gateways/wechat/login/start`).
   A successful 200 (or a benign 4xx like `login_missing`) confirms the
   secret is wired through. A 5xx mentioning `cloud_gateway_ingress_unavailable`
   means the secrets do not match — re-check both sides.
5. Once verified, destroy the old secret in your secret manager and any
   scratch files.

If ingress and Hub must roll independently (no shared window),
temporarily disable cloud-agent gateway writes by unsetting
`CLOUD_GATEWAY_INGRESS_BASE_URL` on Hub. Hub will return 503 for
cloud-agent gateway routes (read paths still work via the mirror); local
daemon gateways are unaffected.

## 4. Rotating Per-Gateway Provider Credentials

Provider credentials (Telegram bot token, WeChat botToken, Feishu
appSecret) are scoped to a single gateway connection.

- **Self-service path:** In the dashboard, ask the user to delete the
  existing gateway and re-run setup. This guarantees no two pollers
  ever own the same credential (a hard constraint for Telegram
  `getUpdates` offsets).
- **Telegram-only fast path:** `PATCH /api/agents/<agent>/gateways/<id>`
  with `{"bot_token": "<new>"}` rotates in place — ingress validates
  via `getMe`, swaps the secret, and resumes polling.

Never edit `BOTCORD_INGRESS_SECRET_DIR/*.json` by hand while ingress is
running.

## 5. One-shot Migration From Cloud Daemon

Phase 3 transferred ownership of cloud-agent third-party gateways from
the cloud daemon (`~/.botcord/daemon/gateways/<id>.json`) to ingress.
Any residual data on the cloud daemon host can be lifted with:

```bash
node dist/cli.js migrate \
    --daemon-data-dir   ~/.botcord/daemon/gateways  \
    --daemon-config     ~/.botcord/daemon/config.json
```

This is a **dry-run** by default — re-run with `--apply` to commit.

Flags:

| Flag | Purpose |
| --- | --- |
| `--daemon-data-dir <path>` | Source secret + state directory (also via `$BOTCORD_DAEMON_DATA_DIR`). |
| `--daemon-config <path>` | Daemon `config.json` (holds `thirdPartyGateways` profile metadata such as `appId`, `domain`, `allowedSenderIds`). |
| `--apply` | Actually write to ingress store/secrets. Omit for dry-run. |
| `--force` | Overwrite ingress connection if it already exists. |
| `--delete-after` | After a successful `--apply`, delete the daemon-side secret + state files. No-op without `--apply`. |
| `--quiet` | Suppress per-row logs (summary still printed). |

Recommended workflow:

1. Run dry-run first and read the planned migrations:
   ```bash
   node dist/cli.js migrate --daemon-data-dir … --daemon-config …
   ```
2. Cross-check the printed `plan migrate` lines against the daemon's
   gateway list. Secrets are rendered as `[REDACTED len=N]` so the log
   output is safe to share for review.
3. Run with `--apply` (no `--delete-after`) on the same inputs.
   Verify the ingress side has picked them up (`GET /status`).
4. After 24h of clean operation, run again with `--apply --delete-after`
   to remove the daemon-side residue. Alternatively `rm` the daemon
   files manually once you have confirmed migration.

**Rollback:** Before running `--delete-after`, the daemon-side files
are untouched. If anything is wrong on the ingress side, restore by
deleting the ingress connection (Hub `DELETE` route) and re-running
migrate from the still-present daemon source.

## 6. Monitoring

Watch the following signals:

- `GET /status` — `connections.running[]` should equal the count of
  active gateways in the Hub mirror. A diff usually means a provider
  adapter failed to start; check ingress logs for `runner.startOne failed`.
- `GET /status` — per-gateway `lastError` rate. A single noisy gateway
  surfaces as `adapter_start_failed` warnings flowing into Hub's
  `agent_gateway_connections.last_error`.
- Hub logs filtered to `cloud-gateway setup event` with
  `setup_owner=gateway-ingress` — should see one log per setup phase
  (`started` / `ok` / `error`). A flood of `error` outcomes means
  ingress is unreachable or rejecting the shared secret.
- Telegram-specific: a 401/403 from `getMe` means the bot token was
  revoked upstream; ingress flips status to `error` and emits a warning
  the Hub mirrors into `last_error`.
