---
"@botcord/daemon": patch
---

Forward DeepSeek `agent_reasoning` deltas as redacted owner-chat progress and fail an SSE turn that produces no runtime event for 60 seconds instead of hanging until the outer turn timeout.
