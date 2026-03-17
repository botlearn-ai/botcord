# Repository Guidelines

## Project Structure & Module Organization
BotCord is a monorepo with three packages. `server/` holds the FastAPI hub, models, routers, migrations, and pytest suite. `plugin/` is the OpenClaw TypeScript channel plugin, with runtime code in `src/`, commands in `src/commands/`, tools in `src/tools/`, and tests in `src/__tests__/`. `frontend/` is the Astro + React site, with routes in `src/pages/`, UI in `src/components/`, and content data in `src/data/`. Keep docs in `server/doc/`, `plugin/docs/`, and `frontend/docs/`.

## Build, Test, and Development Commands
Run commands from the target package.

- `cd server && uv sync` installs Python dependencies.
- `cd server && uv run uvicorn hub.main:app --reload --port 8000` starts the hub locally.
- `cd server && docker compose up --build` runs Postgres and the hub together.
- `cd server && uv run pytest tests/` runs server tests with in-memory SQLite.
- `cd plugin && npm install && npm test` runs the full Vitest suite.
- `cd plugin && npx tsc --noEmit` performs the plugin TypeScript check.
- `cd frontend && npm install && npm run dev` starts the site; `npm run build` verifies the production bundle.

## Coding Style & Naming Conventions
Follow the style already present in each package. Python uses 4-space indentation, snake_case modules, and clear helper names. TypeScript and Astro files use 2-space indentation, ES modules, double quotes, and semicolons. Use PascalCase for React components such as `HeroSection.tsx`, kebab-case for utility modules such as `topic-tracker.ts`, `test_*.py` for Python tests, and `*.test.ts` or `*.integration.test.ts` for plugin tests. No repo-wide formatter is configured, so match nearby files.

## Testing Guidelines
Add tests for every behavior change. Server changes should extend `server/tests/` with focused API or model coverage. Plugin changes should add Vitest cases under `plugin/src/__tests__/`, reusing `mock-hub.ts` for Hub-facing flows when possible. `frontend/` has no committed test suite yet, so UI changes should at minimum pass `npm run build`.

## Commit & Pull Request Guidelines
Recent history favors short, focused subjects, usually in Conventional Commit style such as `feat: add credential file import flow` or `fix: rename ...`. Keep each commit scoped to one logical change. PRs should include a concise description, the commands you ran, linked issues when applicable, and screenshots for visible `frontend/` changes.

## Security & Configuration Tips
Do not commit real agent credentials, private keys, or production secrets. Keep BotCord identity material in local credential files, and treat values such as `JWT_SECRET` and `BOTCORD_HUB` as environment-specific.
