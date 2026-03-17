# Repository Guidelines

## Project Structure & Module Organization
`index.ts` is the plugin entry point and registers the channel, tools, commands, CLI, and webhook route. Core implementation lives in `src/`: protocol and config helpers (`types.ts`, `config.ts`, `crypto.ts`), runtime and transport code (`client.ts`, `channel.ts`, `poller.ts`, `ws-client.ts`, `webhook-handler.ts`), tool handlers in `src/tools/`, and CLI/command handlers in `src/commands/`. Tests live in `src/__tests__/`. Supporting docs are in `docs/`, and packaged skill assets are in `skills/`.

## Build, Test, and Development Commands
There is no required build step for local OpenClaw use; the plugin loads TypeScript sources directly.

- `npm install` installs dependencies.
- `npm test` runs the full Vitest suite.
- `npm run test:unit` runs non-integration tests only.
- `npm run test:integration` runs HTTP/webhook and client integration tests.
- `npx tsc --noEmit` performs a strict TypeScript check before opening a PR.

## Coding Style & Naming Conventions
Use TypeScript with ES modules and strict typing. Match the existing style: 2-space indentation, double quotes, semicolons, and trailing commas in multiline literals and calls. Prefer descriptive factory-style names such as `createWebhookHandler`, `createRoomsTool`, and `resolveAccountConfig`. Keep new files in `src/` named by concern (`topic-tracker.ts`, `notify.ts`) and reserve `*.test.ts` / `*.integration.test.ts` for tests.

## Testing Guidelines
Vitest is the only test framework in this repo. Put unit tests in `src/__tests__/` with names like `config.test.ts`; use `*.integration.test.ts` when the test starts a mock server or exercises real HTTP boundaries. Reuse `src/__tests__/mock-hub.ts` for Hub-facing client coverage. Add or update tests for config resolution, signing/verification, and transport behavior whenever those paths change.

## Commit & Pull Request Guidelines
Recent history follows short, lowercase commit subjects, usually Conventional Commit style such as `fix: ...` or `docs: ...`. Keep commits focused on one change. If you touch release metadata, sync versions in both `package.json` and `openclaw.plugin.json`. PRs should include a concise description, test evidence (`npm test`, targeted suites, or `tsc --noEmit`), and any config or protocol changes reviewers need to verify.

## Security & Configuration Tips
Never commit real `privateKey`, `publicKey`, or `webhookToken` values. Use placeholder IDs like `ag_xxx` and keep live credentials in local OpenClaw config, not in repository files.
