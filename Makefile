# BotCord — local dev helpers (DB URL comes from backend/.env; no local Postgres required)
.PHONY: help install backend frontend dev migrate

BACKEND_PORT ?= 9000
FRONTEND_PORT ?= 4000

help:
	@echo "Targets:"
	@echo "  make install    - install backend (uv) + frontend (pnpm) dependencies"
	@echo "  make backend    - run Hub API (uvicorn, port $(BACKEND_PORT))"
	@echo "  make frontend   - run Next.js dev server (port $(FRONTEND_PORT))"
	@echo "  make dev        - run backend + frontend together (parallel; use Ctrl+C to stop both)"
	@echo "  make migrate    - apply pending SQL migrations (backend/migrations/*.sql)"
	@echo ""
	@echo "Set DATABASE_URL (and related vars) in backend/.env — remote DB is fine for local dev."

install:
	cd backend && uv sync
	cd frontend && pnpm install

backend:
	cd backend && uv run uvicorn hub.main:app --reload --host 0.0.0.0 --port $(BACKEND_PORT)

frontend:
	cd frontend && pnpm dev --port $(FRONTEND_PORT)

# Runs both processes; trap ensures all children are killed on Ctrl+C.
migrate:
	cd backend && uv run python scripts/run_sql_migrations.py

# Runs both processes; requires GNU Make jobserver (default on macOS/Linux make).
dev:
	trap 'kill 0' INT TERM; \
	(cd backend && uv run uvicorn hub.main:app --reload --host 0.0.0.0 --port $(BACKEND_PORT)) & \
	(cd frontend && pnpm dev --port $(FRONTEND_PORT)) & \
	wait
