# @botcord/protocol-core

## 0.5.0

### Minor Changes

- 0897993: Execute the Hub's per-message decision (`InboxMessage.hub_decision`): whether the message wakes the agent and how far it may make the agent act (full / collaborator / read-only / refused). Local `nonOwnerExecution` can only tighten it. Messages without a Hub decision keep the previous behavior.

## 0.4.0

### Minor Changes

- ecc1f6c: Honor the Hub's Team room `space_context` on inbox messages: in organization rooms, requests from anyone but the agent's owner run with the restricted (read-only) profile regardless of local route config (grantees still follow their `access_context` role), and runtimes that cannot enforce restriction refuse the turn instead of running with full permissions. `protocol-core` adds the `SpaceContext` inbox type.

## 0.3.0

### Minor Changes

- 1865498: Agent sharing P1: honor Hub-issued `access_context` on inbox messages. Grantees run as `consultant` (read-only) or `collaborator` — edits confined to a per-grant git worktree on branch `guest/<grant>` (Claude Code `acceptEdits` with a scoped Bash allowlist; Codex `workspace-write` without network or tmp), committed by the daemon after each turn with the branch summary appended to the reply. Inactive grants, and runtimes that cannot enforce a grant, are refused without spawning the CLI. Host credential environment variables are scrubbed from non-owner turns, and grant turns use grant-scoped sessions. `protocol-core` adds the `AccessContext` inbox type.

### Patch Changes

- a31f5ca: Add an opt-in restricted execution profile for turns from non-owner requesters (other humans and agents in rooms, DMs, contact requests). Enable it per agent with `"nonOwnerExecution": { "agents": { "ag_x": "restricted" } }` (or `default`) in `config.json`; the default stays `full`, so existing behavior is unchanged. On restricted routes Claude Code gets read-only tools with shell, writes, web fetch, MCP and project hooks disabled, Codex runs in the read-only sandbox, Gemini uses `plan` approval mode, and the daemon delivers the final reply itself in a separate runtime session. Owner-chat, dashboard chat, schedules, cloud runs, third-party gateways and senders the Hub marks `sender_same_owner` keep full permissions. Kimi and OpenClaw ACP cannot be constrained yet and keep full permissions with a warning.

## 0.2.20

### Patch Changes

- c91719b: Embed the production Hub control signing public key in the default trust ring so daemons without `BOTCORD_HUB_CONTROL_PUBLIC_KEYS` configuration accept control frames (wake_agent, provision_agent, …) from the rotated production signer.

## 0.2.19

### Patch Changes

- 637d893: Keep inbox messages under a renewable processing lease until runtime handling finishes, then acknowledge them explicitly so crashes requeue work instead of losing it.
- afd1bc7: Support staged Hub control signing-key rotation by resolving a multi-key trust
  ring in protocol-core and accepting frames signed by any trusted key in the
  daemon. Runtime snapshots attest that ring using privacy-safe fingerprints, and
  the legacy singular public-key configuration remains compatible.

## 0.2.18

### Patch Changes

- c46b7f7: Correlate REST 401 recovery, token refresh coordination diagnostics, and control-request retries with one privacy-safe request ID.
- 1c04014: Coordinate token generations across in-process clients that share agent credentials, serialize refreshes, and expose privacy-safe auth diagnostics.

## 0.2.17

### Patch Changes

- 8cd4512: Add `relativePath` to daemon runtime file metadata so dashboard and API consumers can distinguish workspace file paths while keeping daemon-issued file ids opaque.

## 0.2.16

### Patch Changes

- 8f15832: Bind owner-chat agent replies to their originating run via an explicit `trace_id`, so streamed reasoning blocks merge into the final answer instead of orphaning into a separate collapsed block below the message. The daemon now forwards the run's `trace_id` (the trigger `hub_msg_id`) on the outbound reply, and `BotCordClient.sendMessage`/`sendTypedMessage` accept a `traceId` option that is sent as a non-signed `trace_id` field on `/hub/send`. The Hub honors this explicit trace instead of guessing the most-recently-registered one, which previously mis-attributed replies when owner-chat turns overlapped.
