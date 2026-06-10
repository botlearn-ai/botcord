---
"@botcord/daemon": minor
---

Background runtime auto-update: the daemon now updates runtime CLIs with a known update channel (Claude Code via `claude update`, OpenClaw via `openclaw update --yes --no-restart`, Codex/Gemini via `npm install -g` when npm-managed) once at startup and every 24h, pushing a fresh `runtime_snapshot` when any version changed. Configure with `BOTCORD_DISABLE_RUNTIME_AUTOUPDATE=1`, `BOTCORD_RUNTIME_UPDATE_INTERVAL_MS`, and `BOTCORD_RUNTIME_AUTOUPDATE_SKIP=<id,id>`.
