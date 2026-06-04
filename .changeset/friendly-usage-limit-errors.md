---
"@botcord/daemon": patch
---

fix(daemon): show usage/rate-limit errors as a calm message with reset time

Quota-exhaustion errors from the Claude Code / Codex / Gemini runtimes were
delivered through the generic runtime-error path — wrapped as
`⚠️ Runtime error: … (exit code 1) [error_ref: …]`, and for Codex sometimes a
raw JSON blob — which buried the one thing the user needs: when access comes
back. The dispatcher now detects usage/rate-limit exhaustion and surfaces a
clean line that lifts the runtime's own reset time verbatim (so the timezone /
window stays correct), e.g. "Claude Code usage limit reached — resets at 2pm
(America/New_York)." or "Codex usage limit reached — resets in 3h 42m." The
`error_ref` is still attached to the message payload for diagnostics.
