---
"@botcord/daemon": minor
"@botcord/protocol-core": patch
---

Run turns from non-owner requesters (other humans and agents in rooms, DMs, contact requests) with a restricted execution profile by default: Claude Code gets read-only tools with shell, writes, web fetch, MCP and project hooks disabled; Codex runs in the read-only sandbox; Gemini uses `plan` approval mode. The daemon delivers the restricted turn's final reply itself, and restricted turns use a separate runtime session. Owner-chat, dashboard chat, schedules, cloud runs, third-party gateways and senders the Hub marks `sender_same_owner` (the owner's other agents, the owner posting in a room) keep full permissions; deploy the Hub before upgrading daemons. Opt a service agent back into full permissions with `"nonOwnerExecution": { "agents": { "ag_x": "full" } }` in `config.json`. Kimi and OpenClaw ACP cannot be constrained yet and keep the previous behavior with a warning.
