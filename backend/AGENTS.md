# Repository Guidelines

## Project Structure & Module Organization
BotCord is a monorepo with three packages: `backend/`, `plugin/`, and `frontend/`. This package, `backend/`, contains the FastAPI hub in `hub/`, reusable code in `app/`, Alembic migrations in `migrations/`, helper scripts in `scripts/`, and backend documentation in `doc/`. Tests live in `tests/`. Shared or cross-package documentation belongs in the repo-level `docs/` directory, while plugin-specific docs stay under `plugin/docs/`.

## Build, Test, and Development Commands
Run commands from `backend/`.

- `uv sync`: install Python dependencies from `pyproject.toml` and `uv.lock`.
- `uv run uvicorn hub.main:app --reload --port 8000`: start the FastAPI hub locally.
- `docker compose up --build`: run Postgres and the hub together for local integration work.
- `uv run pytest tests/`: run the backend test suite against in-memory SQLite.

For monorepo work outside this package: `cd plugin && npm test` runs plugin tests, and `cd frontend && npm run build` verifies the site build.

## Coding Style & Naming Conventions
Use 4-space indentation in Python files and follow the existing local style. Prefer descriptive helper names and snake_case for modules, functions, and variables. Name tests `test_*.py`. No repo-wide formatter is enforced, so match surrounding code before introducing new patterns.

For neighboring packages, TypeScript and TSX use 2-space indentation, ES modules, double quotes, and semicolons. React components use PascalCase such as `HeroSection.tsx`; utility modules use kebab-case such as `topic-tracker.ts`.

## Testing Guidelines
Every behavior change should include tests. Extend `tests/` with focused API, service, or model coverage. Keep tests small and direct, and prefer fixtures that reflect real request flows. Run `uv run pytest tests/` before submitting changes. Frontend changes should at minimum pass `npm run build`; plugin changes should add Vitest coverage under `plugin/src/__tests__/`.

## Commit & Pull Request Guidelines
Use short, focused commit messages, usually in Conventional Commit style, for example `feat: add credential import flow` or `fix: rename session field`. Keep each commit scoped to one logical change. PRs should include a brief description, linked issues when applicable, commands run, and screenshots for visible frontend updates.

## Security & Configuration Tips
Never commit real agent credentials, private keys, or production secrets. Keep local identity material in untracked credential files, and treat settings such as `JWT_SECRET` and `BOTCORD_HUB` as environment-specific.
