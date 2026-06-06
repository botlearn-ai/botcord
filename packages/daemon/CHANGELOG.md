# @botcord/daemon

## 0.3.0

### Minor Changes

- d634461: feat: carry room rules as versioned system rules instead of repeating them in user turns. Room `rule` is no longer embedded in the `[BotCord Room Context]` block or the per-message room-context line; it now flows through `RuntimeRunOptions.systemRules` as a versioned `room_rule` entry (sha256-stamped). Each runtime picks its least-polluting carrier: Claude Code / Codex / DeepSeek prepend it to the per-turn system prompt, while Gemini and Kimi write it into a daemon-managed section of `GEMINI.md` / `.kimi/AGENTS.md`. This stops the rule text from accumulating in the resumed transcript turn after turn.

### Patch Changes

- 41abf76: fix(daemon): refresh stale JWT on 401 for typing/stream-block control requests

  `typing()` and `streamBlock()` in the BotCord channel called `ensureToken()` +
  raw `fetch()`, bypassing `hubFetch`'s 401→refresh retry. When a token was
  invalidated (e.g. a Hub JWT secret rotation) but not yet expired, `ensureToken()`
  kept returning the stale token, so presence/streaming pings 401'd in a loop until
  the next actual message send happened to refresh it — the conversation showed no
  typing indicator or live stream. Both now route through a shared
  `postControlWithRefresh` helper that refreshes the token once and retries on 401.

- 60954ca: fix(daemon): show usage/rate-limit errors as a calm message with reset time

  Quota-exhaustion errors from the Claude Code / Codex / Gemini runtimes were
  delivered through the generic runtime-error path — wrapped as
  `⚠️ Runtime error: … (exit code 1) [error_ref: …]`, and for Codex sometimes a
  raw JSON blob — which buried the one thing the user needs: when access comes
  back. The dispatcher now detects usage/rate-limit exhaustion and surfaces a
  clean line that lifts the runtime's own reset time verbatim (so the timezone /
  window stays correct), e.g. "Claude Code usage limit reached — resets at 2pm
  (America/New_York)." or "Codex usage limit reached — resets in 3h 42m." The
  `error_ref` is still attached to the message payload for diagnostics.

- 90178c0: fix: preserve discovery-loaded agents when provisioning. When the daemon booted via credential discovery (empty `config.agents`), provisioning a single agent persisted `agents: [newId]` and silently dropped every other discovered agent on the next restart — surfacing later as `agent_not_loaded` when their schedules fired. `addAgentToConfig` now folds the gateway's currently-loaded agent channels into the persisted list.
