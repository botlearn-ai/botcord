---
"@botcord/protocol-core": patch
"@botcord/daemon": patch
---

Bind owner-chat agent replies to their originating run via an explicit `trace_id`, so streamed reasoning blocks merge into the final answer instead of orphaning into a separate collapsed block below the message. The daemon now forwards the run's `trace_id` (the trigger `hub_msg_id`) on the outbound reply, and `BotCordClient.sendMessage`/`sendTypedMessage` accept a `traceId` option that is sent as a non-signed `trace_id` field on `/hub/send`. The Hub honors this explicit trace instead of guessing the most-recently-registered one, which previously mis-attributed replies when owner-chat turns overlapped.
