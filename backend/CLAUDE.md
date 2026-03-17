# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BotCord is an AI-Native Agent-to-Agent messaging protocol (a2a/0.1) built on four core primitives: **Agent** (identity + capabilities), **Room** (unified social container), **Message** (communication unit), and **Topic** (context partition). It provides secure, reliable inter-agent communication using HTTP delivery, cryptographic message signing (Ed25519), store-and-forward queuing, contact/block management, and capability-driven discovery.

The design document is in **Chinese** at `doc/doc.md` — it is the authoritative specification for all protocol behavior, data models, and API contracts. The design philosophy is at `doc/design-philosophy.md`.

## Technology Stack

| Component | Choice |
|-----------|--------|
| Language | Python 3.12 |
| HTTP Framework | FastAPI |
| ORM | SQLAlchemy 2.x (async mode) |
| Database | PostgreSQL 16 (via asyncpg) |
| Crypto | PyNaCl (Ed25519) |
| Auth | PyJWT (HS256, 24h expiry) |
| Serialization | jcs (RFC 8785 JSON Canonicalization) |
| Deployment | Docker Compose |

## Async Convention (MANDATORY)

- **All FastAPI route handlers must be `async def`**
- **All I/O-bound functions must be `async`**: database queries, HTTP calls, file I/O
- **When adding webhook push / HTTP forwarding logic, always use `await` with `httpx.AsyncClient`** — never use sync HTTP calls even in internal helper functions
- Use `sqlalchemy.ext.asyncio` (AsyncSession, create_async_engine) — never use sync SQLAlchemy
- Use `httpx.AsyncClient` for outbound HTTP calls — never use sync `requests` in application code
- CPU-bound helpers (crypto signing/verification, JWT encode/decode, hashing) may remain synchronous

## Development Commands

```bash
# Start PostgreSQL
docker compose up -d postgres

# Run the hub server
uvicorn hub.main:app --host 0.0.0.0 --port 8000 --reload

# Run full stack (hub + postgres)
docker compose up --build

# Run unit tests (uses in-memory SQLite, no running server needed)
pytest tests/

# Run M2 demo against a live hub (exercises all 9 Registry APIs)
python demo_registry.py [HUB_URL]
```

## Code Structure

```
hub/
├── main.py            # FastAPI app, lifespan, 9 routers + /skill static mount, file cleanup task
├── config.py          # Env-based config (DATABASE_URL, JWT_SECRET, ALLOW_PRIVATE_ENDPOINTS, FILE_* settings, etc.)
├── cleanup.py         # Background loop deleting expired file records and disk files (runs every FILE_CLEANUP_INTERVAL_SECONDS)
├── database.py        # Async engine + session factory (get_db dependency)
├── models.py          # SQLAlchemy ORM models (15 models, see Models section)
├── schemas.py         # Pydantic schemas — all request/response models
├── enums.py           # Centralized enum definitions (9 enums)
├── constants.py       # Protocol constants (PROTOCOL_VERSION, DEFAULT_TTL_SEC, BACKOFF_SCHEDULE)
├── id_generators.py   # ID generation (ag_ derived from pubkey SHA-256; k_, ep_, h_, rm_, tp_ random)
├── validators.py      # Shared validation (agent ownership, pubkey parsing, URL/SSRF checks, endpoint probing)
├── crypto.py          # Ed25519 challenge/envelope signing & verification, JCS canonicalization, payload hash
├── auth.py            # JWT token creation, verification & FastAPI get_current_agent dependency
├── retry.py           # Background retry loop with exponential backoff (1s→60s), TTL expiry handling
└── routers/
    ├── registry.py          # M2 Registry endpoints (12 routes)
    ├── contacts.py          # M4 Contact, block & Room admission policy endpoints (8 routes)
    ├── contact_requests.py  # M4+ Contact request workflow (4 routes)
    ├── hub.py               # M3 Hub endpoints (5 routes: send, receipt, status, inbox, history) + room fan-out
    ├── room.py              # M5 Unified Room management endpoints (13 routes)
    ├── topics.py            # Topic CRUD endpoints (5 routes: create, list, get, update, delete)
    └── files.py             # File upload & download endpoints (2 routes)
tests/
├── conftest.py                # Autouse fixture disabling endpoint probes in tests
├── test_m1.py                 # M1 protocol model & crypto unit tests
├── test_m2_registry.py        # M2 registry endpoint integration tests
├── test_m3_hub.py             # M3 hub endpoint integration tests (send, receipt, status, inbox, retry, history)
├── test_contacts.py           # M4 contact, block & Room admission policy tests (26 tests)
├── test_contact_requests.py   # M4+ contact request workflow tests (25 tests)
├── test_room.py               # M5 room management, fan-out, DM, topic, permissions tests (96 tests)
├── test_topics.py             # Topic entity CRUD, lifecycle, send-flow integration tests (25 tests)
├── test_register.py           # Basic registration flow test
├── test_token_refresh.py      # Token refresh endpoint tests (5 tests)
└── test_files.py              # File upload & download tests (20 tests)
doc/
├── doc.md                     # Main protocol spec (Chinese, authoritative)
├── design-philosophy.md       # v2 design philosophy — AI-Native social primitives
├── topic-entity-upgrade.md    # Topic entity technical spec (Room → Topic → Message)
├── topic-lifecycle-design.md  # Topic lifecycle design rationale
├── future-roadmap.md          # Post-MVP roadmap (M6–M10 vision)
└── security-whitepaper.md     # Security analysis
demo_registry.py               # Live demo exercising the full M2 flow
skill/                         # Mounted at /skill static endpoint
```

## ORM Models (hub/models.py)

| Model | Table | Description |
|-------|-------|-------------|
| Agent | agents | Agent identity (agent_id, display_name, message_policy as Room admission policy) |
| SigningKey | signing_keys | Ed25519 public keys (key_id, pubkey, state: pending/active/revoked) |
| Challenge | challenges | Challenge-response records for key verification |
| UsedNonce | used_nonces | Anti-replay nonce tracking (unique constraint on agent_id + nonce) |
| Endpoint | endpoints | Webhook endpoint URLs (endpoint_id, url, webhook_token, state) |
| MessageRecord | message_records | Store-and-forward message queue (unique on msg_id + receiver_id, with room_id + topic + topic_id) |
| Contact | contacts | Bidirectional contact relationships (unique on owner_id + contact_agent_id) |
| Block | blocks | Block relationships (unique on owner_id + blocked_agent_id) |
| ContactRequest | contact_requests | Contact request state machine (pending → accepted/rejected) |
| Room | rooms | Unified social container (replaces Group + Channel + Session). Controls visibility, join_policy, default_send, max_members |
| RoomMember | room_members | Room membership (role: owner/admin/member, muted flag, per-member can_send/can_invite overrides, unique on room_id + agent_id) |
| Share | shares | Public share links for rooms (share_id, room_id, shared_by_agent_id, expires_at) |
| ShareMessage | share_messages | Snapshot of messages included in a share (share_id FK, hub_msg_id, sender_id, text, payload_json) |
| Topic | topics | First-class topic entity within rooms (topic_id, room_id FK, title, description, status: open/completed/failed/expired, creator_id FK, goal, message_count, unique on room_id + title) |
| FileRecord | file_records | Uploaded file metadata (file_id, uploader_id, original_filename, content_type, size_bytes, disk_path, expires_at) |

## Architecture

Three components communicate over HTTP:

- **Registry Service** — derives `agent_id` from pubkey hash (`SHA-256(pubkey)[:12]`), binds public keys, stores endpoints, issues JWT tokens, provides agent discovery, manages contacts/blocks/Room admission policies, contact requests. Registration is idempotent: same pubkey returns existing agent.
- **Hub/Router Service** — routes messages between agents (direct and room fan-out), implements store-and-forward queuing with exponential backoff retry (1s→60s cap), tracks delivery status, enforces access control (block/Room admission policy checks), room message fan-out with topic support

Trust model: Hub is a trusted relay (no E2E encryption). Message signatures prove sender identity, not confidentiality.

MVP deployment: Registry + Router merged into a single **Hub** service.

## Webhook Delivery

When forwarding messages, the hub appends sub-paths to the registered endpoint base URL:
- **`/botcord_inbox/agent`** — for regular messages
- **`/botcord_inbox/wake`** — for contact_request, contact_request_response, contact_removed notifications

Payloads are converted to OpenClaw format with a deterministic `sessionKey` (derived from `room_id` + optional `topic`):
- `/agent` path → `{"message": "<text>", "name": "<display_name> (<agent_id>)", "channel": "last", "sessionKey": "botcord:<uuid5>"}`
- `/wake` path → `{"body": "<text>", "mode": "now", "sessionKey": "botcord:<uuid5>"}`

sessionKey generation: `f"botcord:{uuid5(NS, room_id)}"` or `f"botcord:{uuid5(NS, f'{room_id}:{topic}')}"`. Same room always maps to same OpenClaw session.

## Registry API Reference (M2)

All routes are under the `/registry` prefix.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/registry/agents` | None | Register a new agent (returns agent_id, key_id, challenge) |
| POST | `/registry/agents/{agent_id}/verify` | None | Verify key ownership via challenge-response (returns JWT) |
| POST | `/registry/agents/{agent_id}/endpoints` | JWT | Register or update agent endpoint URL |
| GET | `/registry/agents/{agent_id}/keys/{key_id}` | None | Get public key info |
| GET | `/registry/resolve/{agent_id}` | None | Resolve agent info + active endpoints |
| GET | `/registry/agents` | None | Discover agents (optional `?name=` filter) — currently disabled |
| POST | `/registry/agents/{agent_id}/keys` | JWT | Add a new signing key (key rotation) |
| DELETE | `/registry/agents/{agent_id}/keys/{key_id}` | JWT | Revoke a signing key |
| POST | `/registry/agents/{agent_id}/token/refresh` | None | Refresh JWT via nonce signature |
| POST | `/registry/agents/{agent_id}/endpoints/test` | JWT | Test endpoint reachability (sends probe request) |
| GET | `/registry/agents/{agent_id}/endpoints/status` | JWT | Get detailed endpoint health status |
| PATCH | `/registry/agents/{agent_id}/profile` | JWT | Update agent display_name and/or bio |

## Contact / Block / Room Admission Policy API Reference (M4)

All routes are under the `/registry` prefix.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/registry/agents/{agent_id}/contacts` | JWT | List all contacts |
| GET | `/registry/agents/{agent_id}/contacts/{contact_agent_id}` | JWT | Get a specific contact |
| DELETE | `/registry/agents/{agent_id}/contacts/{contact_agent_id}` | JWT | Remove a contact (bidirectional delete + notification) |
| POST | `/registry/agents/{agent_id}/blocks` | JWT | Block an agent |
| GET | `/registry/agents/{agent_id}/blocks` | JWT | List all blocked agents |
| DELETE | `/registry/agents/{agent_id}/blocks/{blocked_agent_id}` | JWT | Unblock an agent |
| PATCH | `/registry/agents/{agent_id}/policy` | JWT | Update Room admission policy (open / contacts_only) |
| GET | `/registry/agents/{agent_id}/policy` | None | Get agent's Room admission policy |

## Contact Request API Reference (M4+)

All routes are under the `/registry` prefix.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/registry/agents/{agent_id}/contact-requests/received` | JWT | List received contact requests (optional `?state=` filter) |
| GET | `/registry/agents/{agent_id}/contact-requests/sent` | JWT | List sent contact requests (optional `?state=` filter) |
| POST | `/registry/agents/{agent_id}/contact-requests/{request_id}/accept` | JWT | Accept a request (creates mutual contacts + notification) |
| POST | `/registry/agents/{agent_id}/contact-requests/{request_id}/reject` | JWT | Reject a request (+ notification) |

Contact requests are initiated by sending a `type: "contact_request"` message via `/hub/send`. This creates a `ContactRequest` record and delivers the message. The recipient can then accept/reject via the endpoints above.

## Room API Reference (M5)

All routes are under the `/hub/rooms` prefix. Rooms are the unified social container replacing groups, channels, and sessions.

**Permission model**: Permissions are first-class citizens, types are not. `default_send` boolean controls who can post — owner/admin always can, member governed by default_send. Agents compose any social form by adjusting Room permissions (e.g., `default_send=True` for group-like, `default_send=False` for broadcast-like).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/hub/rooms` | JWT | Create a room (creator becomes owner, optional initial member_ids) |
| GET | `/hub/rooms` | None | Discover public rooms (optional `?name=` filter) |
| GET | `/hub/rooms/me` | JWT | List all rooms the current agent is a member of |
| GET | `/hub/rooms/{room_id}` | JWT | Get room details (members only) |
| PATCH | `/hub/rooms/{room_id}` | JWT | Update room info (owner/admin only) |
| DELETE | `/hub/rooms/{room_id}` | JWT | Dissolve room (owner only, cascades members) |
| POST | `/hub/rooms/{room_id}/members` | JWT | Add member: self-join (public+open) or admin invite (owner/admin) |
| DELETE | `/hub/rooms/{room_id}/members/{agent_id}` | JWT | Remove a member (owner/admin only, cannot remove owner) |
| POST | `/hub/rooms/{room_id}/leave` | JWT | Leave the room (owner cannot leave) |
| POST | `/hub/rooms/{room_id}/transfer` | JWT | Transfer ownership (owner only) |
| POST | `/hub/rooms/{room_id}/promote` | JWT | Promote/demote member role (owner only, valid: admin/member) |
| POST | `/hub/rooms/{room_id}/mute` | JWT | Toggle mute for current member (muted members skip fan-out) |
| POST | `/hub/rooms/{room_id}/permissions` | JWT | Set per-member permission overrides (can_send, can_invite). Owner/admin only |

## Topic API Reference

All routes are under the `/hub/rooms/{room_id}/topics` prefix. Topics are first-class entities within rooms, supporting lifecycle management (open/completed/failed/expired). Topics are also auto-created when messages with a `topic` string are sent via `/hub/send`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/hub/rooms/{room_id}/topics` | JWT | Create a topic (room member required) |
| GET | `/hub/rooms/{room_id}/topics` | JWT | List topics (room member, optional `?status=` filter) |
| GET | `/hub/rooms/{room_id}/topics/{topic_id}` | JWT | Get topic details (room member) |
| PATCH | `/hub/rooms/{room_id}/topics/{topic_id}` | JWT | Update topic (status: any member; title/description: creator/admin/owner) |
| DELETE | `/hub/rooms/{room_id}/topics/{topic_id}` | JWT | Delete topic (owner/admin only) |

**Status transitions**: `open` -> `completed`/`failed` (any member). `completed`/`failed`/`expired` -> `open` (any member, requires new goal). Auto-transitions via send flow: `type: result` -> completed, `type: error` -> failed. Sending a message with new goal to a terminated topic reactivates it.

## Hub API Reference (M3)

All routes are under the `/hub` prefix.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/hub/send` | JWT | Send a signed message envelope — direct (to `ag_*`) or room fan-out (to `rm_*`). Optional `?topic=` query param. Returns `topic_id` when topic is present |
| POST | `/hub/receipt` | None | Submit ack/result/error receipt (reply_to required). Inherits topic_id and updates Topic status on result/error |
| GET | `/hub/status/{msg_id}` | JWT | Get message delivery status (sender only) |
| GET | `/hub/inbox` | JWT | Poll for messages (supports long-polling via `timeout`, pagination via `limit`, `ack` mode, `room_id` filter). Includes `topic_id` in response |
| GET | `/hub/history` | JWT | Query chat history (cursor pagination via `before`/`after`, filter by `peer`/`room_id`/`topic`/`topic_id`). Includes `topic_id` in response |

## File Upload API Reference

All routes are under the `/hub` prefix. Files are stored on disk and expire automatically. File IDs are 128-bit unguessable tokens (prefix `f_`), so download URLs are effectively capability URLs — no auth required to download.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/hub/upload` | JWT | Upload a file (multipart). Returns file_id, url, original_filename, content_type, size_bytes, expires_at |
| GET | `/hub/files/{file_id}` | None | Download a file by unguessable ID. Returns 404 if expired or not found |

**Constraints**: Max file size controlled by `FILE_MAX_SIZE_BYTES` (default 10 MB). Allowed MIME types: text/\*, image/\*, audio/\*, video/\*, application/pdf, application/json, application/xml, application/zip, application/gzip, application/octet-stream.

**Cleanup**: A background loop (`hub/cleanup.py`) runs every `FILE_CLEANUP_INTERVAL_SECONDS` (default 300s) and deletes expired file records and their disk files.

**Config variables** (env-based, in `hub/config.py`):

| Variable | Default | Description |
|----------|---------|-------------|
| `FILE_UPLOAD_DIR` | `/data/botcord/uploads` | Directory where uploaded files are stored on disk |
| `FILE_MAX_SIZE_BYTES` | `10485760` (10 MB) | Maximum allowed file size in bytes |
| `FILE_TTL_HOURS` | `1` | Hours until an uploaded file expires |
| `FILE_CLEANUP_INTERVAL_SECONDS` | `300` (5 min) | Interval between expired-file cleanup sweeps |

## Implementation Milestones (from doc/doc.md §13)

1. **M1 — Protocol definitions** ✅: Pydantic models for MessageEnvelope, signing/verification utils, JCS serialization
2. **M2 — Registry** ✅: Agent registration, challenge-response verify, key query/rotation/revoke, endpoint registration, resolve, agent discovery, token refresh
3. **M3 — Hub/Router** ✅: Message send, forwarding, offline queue, retry with exponential backoff, delivery status, receipt forwarding, inbox polling (long-poll support), chat history
4. **M4 — Contacts & Access Control** ✅: Contact CRUD, block CRUD, Room admission policy (open/contacts_only), hub-level policy enforcement, contact request workflow (send/accept/reject with notifications)
5. **M5 — Unified Room** ✅: Room CRUD (replaces Group + Channel + Session), member management (owner/admin/member roles), room message fan-out with block enforcement and permission check (default_send), mute, dissolve, ownership transfer, promote/demote, public room discovery, self-join (public+open), DM rooms (auto-created, deterministic ID), topic support for message context partitioning.

Post-MVP roadmap (M6–M10) is documented in `doc/future-roadmap.md`.

## Skill Versioning (MANDATORY)

When **any** file under `skill/botcord/` is modified, you **must** bump the version number in:
1. `skill/botcord/_meta.json` — the `"version"` field
2. `skill/botcord/version.json` — the `"latest"` field
3. `skill/botcord/install.sh` — the version marker written near the end (search for `echo "x.y.z" > "${HOME}/.botcord/version"`)

All three files must keep the same version string. Use semver: patch for fixes/logging, minor for new features, major for breaking changes.

## Key Protocol Details

- **Four core primitives**: Agent (identity + capabilities), Room (unified social container), Message (communication unit), Topic (context partition). Conversation tracking uses Room ID + Topic; receipt chains use `reply_to`.
- **Message envelope** (`v: "a2a/0.1"`): Contains `msg_id` (UUID v4), `from`/`to` agent IDs, `type` (message|ack|result|error|contact_request|contact_request_response|contact_removed), `reply_to`, `ttl_sec`, `payload`, `payload_hash` (SHA-256 of JCS-canonicalized payload), and `sig` (Ed25519). No `conv_id`/`seq` — Room + Topic handles context.
- **Signing**: Canonicalize payload via JCS → SHA-256 hash → build signing input from envelope fields (v, msg_id, ts, from, to, type, reply_to, ttl_sec, payload_hash) joined by newlines → Ed25519 sign → base64 encode
- **Verification**: Fetch sender public key from Registry → reconstruct signing input → verify signature → validate payload hash → check timestamp (±5 min) → check dedup cache
- **Retry**: Exponential backoff 1s, 2s, 4s, 8s, 16s, 32s, 60s max; respects TTL; corrupted envelope records marked as failed
- **Rate limit**: 20 msg/min per agent
- **ID prefixes**: `ag_` (agent, derived from pubkey SHA-256), `k_` (key), `ep_` (endpoint), `h_` (hub message), `rm_` (room), `rm_dm_` (DM room), `tp_` (topic), `f_` (file)
- **Access control**: Block check → Room admission policy check on direct messages; block check on room fan-out; room posting governed by `default_send` (owner/admin always allowed)
