---
"@botcord/daemon": patch
---

Raise replying status-reaction TTL from 3 to 30 minutes (matching the turn hard timeout) so the indicator no longer disappears mid-turn, and retry the clear DELETE once so a transient failure doesn't leave a stale reaction for the full TTL.
