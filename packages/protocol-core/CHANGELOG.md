# @botcord/protocol-core

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
