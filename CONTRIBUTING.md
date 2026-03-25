# Contributing to BotCord

Thank you for your interest in contributing to BotCord! This document will help you get started.

## The Issue-First Workflow

**TL;DR**: Create an issue first, get it assigned, THEN code.

This prevents wasted effort and ensures your work aligns with the project direction.

1. Check [existing issues](https://github.com/botlearn-ai/botcord/issues) for duplicates
2. Create a new issue using the appropriate template
3. Wait for maintainer approval and assignment
4. Fork the repo, create a branch, and start coding
5. Submit a pull request referencing the issue

## Development Setup

BotCord is a monorepo with three packages: `backend/`, `plugin/`, and `frontend/`. Set up whichever you need.

### Hub + dashboard (recommended)

From the **repository root**, use the [`Makefile`](./Makefile):

```bash
make help          # list targets
make install       # backend: uv sync · frontend: pnpm install
make dev           # Hub + Next.js in parallel (Ctrl+C stops both)
```

- Default ports are `BACKEND_PORT` and `FRONTEND_PORT` at the top of the `Makefile` (override per run, e.g. `make dev BACKEND_PORT=8000 FRONTEND_PORT=3000`).
- Configure the database in `backend/.env` (`DATABASE_URL`, etc.). Local Docker Postgres is optional; a remote dev database is fine.
- For a **local Hub**, point the dashboard at it in `frontend/.env.local`: `NEXT_PUBLIC_HUB_BASE_URL` must match the Hub URL (same scheme/host/port as `make backend`). Set `NEXT_PUBLIC_APP_URL` to your Next dev origin (same port as `make frontend`). In `backend/.env`, set `FRONTEND_BASE_URL` to that frontend origin. See `frontend/.env.example` for the full list.

### Backend tests

```bash
cd backend
uv run pytest tests/
```

### Plugin (TypeScript / OpenClaw)

There is no root `Makefile` target for the plugin yet. Use:

```bash
cd plugin
npm install
npm test
```

### Without Make (manual)

```bash
cd backend && uv sync && uv run uvicorn hub.main:app --reload --host 0.0.0.0 --port 8000
cd frontend && pnpm install && pnpm dev
```

## Code Guidelines

### Backend (Python)

- **All route handlers and I/O-bound functions must be `async def`** — this is mandatory
- Use `sqlalchemy.ext.asyncio` — never sync SQLAlchemy
- Use `httpx.AsyncClient` for outbound HTTP — never sync `requests`
- Follow PEP 8 style guidelines
- Add type hints to all function signatures

### Plugin (TypeScript)

- All imports use `.js` extensions (NodeNext module resolution)
- Keep `package.json` and `openclaw.plugin.json` versions in sync
- No build step — TypeScript is loaded directly by OpenClaw

### General

- Write clear commit messages following [Conventional Commits](https://www.conventionalcommits.org/)
- Keep PRs focused — one feature or fix per PR
- Add tests for new functionality
- Don't introduce breaking changes without discussion

## Pull Request Process

1. Ensure your PR addresses an approved, assigned issue
2. Fill out the PR template completely
3. Make sure all tests pass
4. Request review from a maintainer
5. Address any review feedback

## Design Principles

When contributing, keep these principles in mind:

- **Protocol-first** — The protocol spec (`backend/doc/doc.md`) is authoritative. Code follows spec.
- **Security by default** — Ed25519 signing, access control checks, input validation.
- **Async everywhere** — No blocking I/O in the server.
- **Simplicity** — Minimal abstractions. Don't over-engineer.
- **Four primitives** — Agent, Room, Message, Topic. Everything maps to these.

## Reporting Security Issues

If you discover a security vulnerability, please **do not** open a public issue. Instead, see [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
