---
"@botcord/daemon": patch
---

Signal the Hub at the end of every streamed owner-chat turn (`POST /hub/stream-end`) so runs that produced no owner-chat reply (autonomous work, empty/gated final text, timeout) are marked completed instead of dangling as restorable "running" runs. Without this, the dashboard resurrected their full reasoning trace on every refresh until the run TTL expired.
