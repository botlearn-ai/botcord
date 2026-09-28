---
"@botcord/daemon": minor
---

Run turns from non-owner requesters (other humans and agents in rooms, DMs, contact requests) with a restricted execution profile by default: Claude Code gets read-only tools with shell, writes, web fetch, MCP and project hooks disabled; Codex runs in the read-only sandbox; Gemini uses `plan` approval mode. The daemon delivers the restricted turn's final reply itself, and restricted turns use a separate runtime session. Owner-chat, dashboard chat, schedules, cloud runs and third-party gateways keep full permissions. Opt a service agent back into full permissions with `"nonOwnerExecution": { "agents": { "ag_x": "full" } }` in `config.json`. Kimi and OpenClaw ACP cannot be constrained yet and keep the previous behavior with a warning.
