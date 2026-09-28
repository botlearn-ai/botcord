---
"@botcord/daemon": minor
"@botcord/protocol-core": patch
---

Add an opt-in restricted execution profile for turns from non-owner requesters (other humans and agents in rooms, DMs, contact requests). Enable it per agent with `"nonOwnerExecution": { "agents": { "ag_x": "restricted" } }` (or `default`) in `config.json`; the default stays `full`, so existing behavior is unchanged. On restricted routes Claude Code gets read-only tools with shell, writes, web fetch, MCP and project hooks disabled, Codex runs in the read-only sandbox, Gemini uses `plan` approval mode, and the daemon delivers the final reply itself in a separate runtime session. Owner-chat, dashboard chat, schedules, cloud runs, third-party gateways and senders the Hub marks `sender_same_owner` keep full permissions. Kimi and OpenClaw ACP cannot be constrained yet and keep full permissions with a warning.
