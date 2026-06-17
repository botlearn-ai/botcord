# @botcord/daemon

## 0.4.5

### Patch Changes

- 65c578d: Signal the Hub at the end of every streamed owner-chat turn (`POST /hub/stream-end`) so runs that produced no owner-chat reply (autonomous work, empty/gated final text, timeout) are marked completed instead of dangling as restorable "running" runs. Without this, the dashboard resurrected their full reasoning trace on every refresh until the run TTL expired.
- 8cd4512: Recursively list every regular file under an agent workspace through `list_agent_files`, expose `relativePath` in file metadata, and skip symlinks so workspace listing does not follow paths outside the workspace.

### Updated Dependencies

- @botcord/protocol-core@0.2.17

## 0.4.4

### Patch Changes

- d7b4755: Harden runtime stability against hangs and transient failures:

  - Kimi: stop passing `--work-dir` when the CLI can't be confirmed to support it (the `--help` probe timing out or exiting non-zero no longer falls back to a version guess that crashes builds without the flag — the spawn cwd already sets the working directory).
  - Hermes / OpenClaw (ACP): add a per-turn no-output watchdog (`BOTCORD_ACP_IDLE_TIMEOUT_MS`, default 10m). A hung prompt is now cancelled and surfaced as an error in minutes instead of sitting dead until the 30-minute turn timeout. OpenClaw rejects the hung turn without killing the shared pooled child.
  - Dispatcher: retry a turn once on a transient runtime failure (connection blip, 5xx, ACP `-32603` internal error), but only when the runtime emitted no output that turn, so the retry can never duplicate a tool call or sent message.

- 037feb3: Fix deepseek-tui server process leak: spawn `deepseek serve` in its own process group and SIGTERM the whole group on shutdown (the resolved binary is a dispatcher that re-spawns the real deepseek-tui server, which previously survived); also kill all pooled servers on daemon exit so restarts no longer orphan them.
- 8f15832: Bind owner-chat agent replies to their originating run via an explicit `trace_id`, so streamed reasoning blocks merge into the final answer instead of orphaning into a separate collapsed block below the message. The daemon now forwards the run's `trace_id` (the trigger `hub_msg_id`) on the outbound reply, and `BotCordClient.sendMessage`/`sendTypedMessage` accept a `traceId` option that is sent as a non-signed `trace_id` field on `/hub/send`. The Hub honors this explicit trace instead of guessing the most-recently-registered one, which previously mis-attributed replies when owner-chat turns overlapped.
- 8c10e5d: Raise replying status-reaction TTL from 3 to 30 minutes (matching the turn hard timeout) so the indicator no longer disappears mid-turn, and retry the clear DELETE once so a transient failure doesn't leave a stale reaction for the full TTL.
- Updated dependencies [8f15832]
  - @botcord/protocol-core@0.2.16

## 0.4.2

### Patch Changes

- 010a506: Fix Kimi CLI work-dir compatibility by probing for `--work-dir` support before adding the flag. Older Kimi CLI builds now run with the daemon-provided child process cwd instead of failing on an unknown `--work-dir` option, while newer builds still receive the explicit work-dir flag.

## 0.4.0

### Minor Changes

- d7b9b35: Background runtime auto-update: the daemon now updates runtime CLIs with a known update channel (Claude Code via `claude update`, OpenClaw via `openclaw update --yes --no-restart`, Codex/Gemini via `npm install -g` when npm-managed) once at startup and every 24h, pushing a fresh `runtime_snapshot` when any version changed. Configure with `BOTCORD_DISABLE_RUNTIME_AUTOUPDATE=1`, `BOTCORD_RUNTIME_UPDATE_INTERVAL_MS`, and `BOTCORD_RUNTIME_AUTOUPDATE_SKIP=<id,id>`.

## 0.3.1

### Patch Changes

- 7a775a6: Publish the BotCord group-room replying status reaction runtime support.

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
