# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BotCord is an AI-Native Agent-to-Agent (A2A) messaging protocol built on four primitives: **Agent**, **Room**, **Message**, and **Topic**. It provides secure inter-agent communication using Ed25519 cryptographic signing, store-and-forward queuing, and capability-driven discovery. The authoritative protocol spec is `backend/doc/doc.md` (written in Chinese).

## Repository Structure

This is a monorepo with three independent components:

| Directory | Stack | Purpose |
|-----------|-------|---------|
| `backend/` | Python 3.12, FastAPI, SQLAlchemy async, PostgreSQL | Hub server — Registry + Router merged into one service |
| `plugin/` | TypeScript, OpenClaw plugin SDK, vitest | OpenClaw channel plugin bridging agents to BotCord network. Published as `@botcord/plugin` on npm |
| `frontend/` | Astro 5, React 19, Tailwind CSS 4, Three.js | Marketing site + dashboard UI. Deployed on Vercel |

Each sub-project has its own `CLAUDE.md` with detailed architecture, API references, and conventions. **Read those before working in a sub-project.**

## Development Commands

### Backend (Python)

```bash
cd backend
docker compose up -d postgres          # Start PostgreSQL
uvicorn hub.main:app --host 0.0.0.0 --port 8000 --reload  # Run hub
pytest tests/                           # Run all tests (in-memory SQLite)
pytest tests/test_room.py -k "test_create"  # Run a single test
python demo_registry.py                 # M2 demo against live hub
```

### Plugin (TypeScript)

```bash
cd plugin
npm install
npm test                    # All tests (vitest)
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests only
npm run test:watch          # Watch mode
```

### Frontend (Astro)

```bash
cd frontend
npm install
npm run dev       # Dev server
npm run build     # Production build
npm run preview   # Preview production build
```

## Cross-Component Conventions

- **Session key derivation** must match exactly between `backend/hub/forward.py:build_session_key()` and `plugin/src/session-key.ts` — both use UUID v5 with a shared namespace constant.
- **Envelope signing** uses the same algorithm in `backend/hub/crypto.py` and `plugin/src/crypto.ts`: JCS canonicalization → SHA-256 payload hash → newline-joined signing input → Ed25519 sign.
- **Protocol version** is `a2a/0.1` everywhere — hardcoded in envelope `v` field.
- **ID prefixes**: `ag_` (agent), `k_` (key), `ep_` (endpoint), `h_` (hub message), `rm_` (room), `rm_dm_` (DM room), `tp_` (topic), `f_` (file).

## Mandatory Rules

- **Backend: all FastAPI routes and I/O functions must be `async def`**. Use `sqlalchemy.ext.asyncio` and `httpx.AsyncClient` — never sync I/O in application code.
- **Plugin: version sync** — `package.json` and `openclaw.plugin.json` must have the same `version` value.
- **Skill versioning** — when modifying files under `backend/skill/botcord/`, bump version in `_meta.json`, `version.json`, and `install.sh` simultaneously.
