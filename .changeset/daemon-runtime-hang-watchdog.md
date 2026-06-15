---
"@botcord/daemon": patch
---

Harden runtime stability against hangs and transient failures:

- Kimi: stop passing `--work-dir` when the CLI can't be confirmed to support it (the `--help` probe timing out or exiting non-zero no longer falls back to a version guess that crashes builds without the flag — the spawn cwd already sets the working directory).
- Hermes / OpenClaw (ACP): add a per-turn no-output watchdog (`BOTCORD_ACP_IDLE_TIMEOUT_MS`, default 10m). A hung prompt is now cancelled and surfaced as an error in minutes instead of sitting dead until the 30-minute turn timeout. OpenClaw rejects the hung turn without killing the shared pooled child.
- Dispatcher: retry a turn once on a transient runtime failure (connection blip, 5xx, ACP `-32603` internal error), but only when the runtime emitted no output that turn, so the retry can never duplicate a tool call or sent message.
