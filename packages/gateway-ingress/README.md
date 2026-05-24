# @botcord/gateway-ingress

Always-on observer service for Cloud Agent third-party connectivity.

See [`docs/cloud-gateway-ingress-technical-design.md`](../../docs/cloud-gateway-ingress-technical-design.md) for the full design. The MVP delivers:

- A pluggable provider runner (Phase 2 ships **Telegram** `getUpdates` polling).
- A durable inbound queue + dedupe + cursor store backed by flat JSON files
  under `~/.botcord/gateway-ingress/data/`.
- A Hub client that calls the Hub's thin lifecycle API
  (`/internal/cloud-gateway/agents/{agent_id}/ensure-running`, `runtime`, `touch`).
- A runtime session manager that opens a payload-opaque WebSocket to the
  cloud daemon and dispatches normalized `gateway_inbound` frames.
- An orchestrator that owns dedupe → ensure-running → deliver → ack →
  outbound-complete bookkeeping.

## Quick start

```bash
cd packages/gateway-ingress
npm install
npm run build

export BOTCORD_INGRESS_HUB_URL=https://hub.botcord.chat
export BOTCORD_INGRESS_SECRET=...   # matches Hub's CLOUD_GATEWAY_INGRESS_SECRET
export BOTCORD_INGRESS_DATA_DIR=~/.botcord/gateway-ingress/data
export BOTCORD_INGRESS_SECRET_DIR=~/.botcord/gateway-ingress/secrets

npx botcord-gateway-ingress
```

The Hub needs three env vars on its side:

```bash
ALLOW_PRIVATE_ENDPOINTS=true
CLOUD_GATEWAY_INGRESS_SECRET=<shared-secret>
CLOUD_GATEWAY_RUNTIME_ENDPOINT=wss://hub.botcord.chat/cloud-gateway/runtime
```

## Config

| Env var | Default | Description |
|---------|---------|-------------|
| `BOTCORD_INGRESS_HUB_URL` | `http://localhost:9000` | Hub base URL |
| `BOTCORD_INGRESS_SECRET` | _required_ | Bearer matching Hub's `CLOUD_GATEWAY_INGRESS_SECRET` |
| `BOTCORD_INGRESS_DATA_DIR` | `~/.botcord/gateway-ingress/data` | Durable queue + state JSON |
| `BOTCORD_INGRESS_SECRET_DIR` | `~/.botcord/gateway-ingress/secrets` | Per-gateway secret files (mode 0600) |
| `BOTCORD_INGRESS_HEALTH_PORT` | `9100` | `/healthz` + `/status` HTTP port (0 disables) |
| `BOTCORD_INGRESS_HEALTH_HOST` | `127.0.0.1` | Health server bind host |
| `BOTCORD_INGRESS_RUNTIME_ENDPOINT` | _hub-supplied_ | Override the runtime WS endpoint Hub advertises (useful with a relay) |
| `BOTCORD_INGRESS_DEDUPE_CAPACITY` | `1024` | Ring-buffer size per gateway |
| `BOTCORD_INGRESS_DEBUG` | _unset_ | Set to `1` to log `debug()` messages |

## Storage layout

```
<BOTCORD_INGRESS_DATA_DIR>/
├── connections/<gateway_id>.json   GatewayConnection rows
├── state/<gateway_id>.json         cursor + dedupe ring + activity
├── events/<event_id>.json          InboundEvent (durable queue)
└── deliveries/<delivery_id>.json   OutboundDelivery
```

Provider secrets live separately under `BOTCORD_INGRESS_SECRET_DIR`:

```
<BOTCORD_INGRESS_SECRET_DIR>/<gateway_id>.json   {"botToken":"..."}
```

The split mirrors the daemon-side `daemon/gateways/` convention so the same
ops playbook works for ingress.

## Tests

```bash
npm test
```

Vitest exercises:

- Storage durability + dedupe across reloads
- Hub client (mocked fetch) — header shape, runtime endpoint override, error mapping
- Telegram provider (mocked fetch + abort signal) — getUpdates polling, allowlist, send
- Orchestrator end-to-end with a fake runtime socket — dedupe, ensure-running,
  ack, outbound complete → provider send → delivered, requeue on socket close
- Service graph wiring (`buildIngressService`) — full inbound → delivered loop
