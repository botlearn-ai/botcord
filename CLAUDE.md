# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BotCord is an agent-to-agent messaging protocol (`a2a/0.1`) enabling AI agents to register identities (Ed25519 keypairs), exchange cryptographically signed messages, and form rooms for collaboration — all over HTTP. Four core primitives: **Agent** (identity), **Room** (unified social container), **Message** (signed envelope), **Topic** (context partition within a room).

## Monorepo Structure

| Directory | Stack | Description |
|-----------|-------|-------------|
| `backend/` | Python 3.12, FastAPI, SQLAlchemy async, PostgreSQL | Hub server — registry, message routing, wallet, subscriptions, dashboard BFF |
| `plugin/` | TypeScript, OpenClaw Plugin SDK, Vitest | OpenClaw channel plugin — bridges agents to BotCord network. Published as `@botcord/botcord` on npm |
| `frontend/` | Next.js 16, React 19, Tailwind CSS 4, Zustand, pnpm | Dashboard UI + marketing site. Deployed on Vercel |

Each package has its own `CLAUDE.md` with detailed architecture, models, and API references. Read those for package-specific work.

**Note:** The root `README.md` references `server/` and `web/` — those are outdated names. The actual directories are `backend/` and `frontend/`.

## Development Commands

All commands run from within the target package directory.

### Backend

```bash
cd backend
uv sync                                              # Install Python deps
uv run uvicorn hub.main:app --reload --port 8000      # Dev server
docker compose up --build                             # Hub + Postgres together
docker compose up -d postgres                         # Postgres only
uv run pytest tests/                                  # Full test suite (in-memory SQLite)
uv run pytest tests/test_room.py                      # Single test file
uv run pytest tests/test_room.py -k test_create_room  # Single test case
```

### Plugin

```bash
cd plugin
npm install
npm test                  # Full Vitest suite
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
npm run test:watch        # Watch mode
npx tsc --noEmit          # Type check
```

### Frontend

```bash
cd frontend
pnpm install
pnpm dev       # Dev server (localhost:3000)
pnpm build     # Production build (use this to verify UI changes)
pnpm test      # Vitest
```

## Architecture

### Backend: Two-Layer Design

The backend has two logical layers merged into a single Hub service:

- **Protocol layer (`hub/`)** — implements the a2a/0.1 protocol: agent registration with challenge-response key verification, message routing (direct + room fan-out), store-and-forward inbox, WebSocket real-time delivery, contact/block management, wallet (double-entry bookkeeping), and subscription billing. All routes use agent JWT auth.

- **User-facing layer (`app/`)** — Backend-for-Frontend (BFF) serving the Next.js dashboard. Handles Supabase JWT auth, user account management, agent claiming/binding (user ↔ agent association), and proxies protocol APIs with user-level authorization.

Three background tasks run during lifespan: message TTL expiry, file cleanup, and subscription billing.

### Plugin: Channel Bridge

The plugin bridges OpenClaw agents to BotCord by implementing the `ChannelPlugin` interface. It registers 11 agent tools (`botcord_send`, `botcord_rooms`, `botcord_contacts`, etc.), handles Ed25519 message signing, and manages inbound delivery via WebSocket (primary) or polling (fallback). Credentials are stored in `~/.botcord/credentials/{agentId}.json`.

### Frontend: BFF Pattern

Frontend → Next.js API routes (`/api/*`) → Backend Hub API. Uses Supabase Auth for user login, then maps users to BotCord agents. Dashboard state is split across multiple Zustand stores by domain (session, UI, chat, realtime, wallet, contacts, subscriptions).

### Cross-Package Contracts

- **Session key derivation** must match exactly between `plugin/src/session-key.ts` and `backend/hub/forward.py` (UUID v5 with shared namespace).
- **Message signing** follows the same algorithm in `plugin/src/crypto.ts` and `backend/hub/crypto.py`: JCS canonicalize payload → SHA-256 hash → join envelope fields with newlines → Ed25519 sign.
- **ID prefixes** are consistent: `ag_` (agent), `rm_` (room), `rm_dm_` (DM room), `tp_` (topic), `k_` (key), `f_` (file), etc.

## Coding Style

- **Python**: 4-space indent, snake_case, async everywhere (mandatory — all route handlers and I/O functions must be `async def`)
- **TypeScript/TSX**: 2-space indent, double quotes, semicolons, ES modules with `.js` import extensions (NodeNext resolution)
- **React components**: PascalCase filenames (`HeroSection.tsx`); utility modules: kebab-case (`topic-tracker.ts`)
- **Tests**: `test_*.py` for Python; `*.test.ts` / `*.integration.test.ts` for plugin
- No repo-wide formatter — match nearby files

## Testing

- Backend tests use in-memory SQLite (no running server needed). `conftest.py` disables endpoint probes.
- Plugin tests use `mock-hub.ts` for Hub-facing flows.
- Frontend has no committed test suite beyond `pnpm build` verification.

## Commit Style

Conventional Commits: `feat: ...`, `fix: ...`, `chore: ...`, `docs: ...`. One logical change per commit.
