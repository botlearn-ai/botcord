---
"@botcord/daemon": minor
---

feat: carry room rules as versioned system rules instead of repeating them in user turns. Room `rule` is no longer embedded in the `[BotCord Room Context]` block or the per-message room-context line; it now flows through `RuntimeRunOptions.systemRules` as a versioned `room_rule` entry (sha256-stamped). Each runtime picks its least-polluting carrier: Claude Code / Codex / DeepSeek prepend it to the per-turn system prompt, while Gemini and Kimi write it into a daemon-managed section of `GEMINI.md` / `.kimi/AGENTS.md`. This stops the rule text from accumulating in the resumed transcript turn after turn.
