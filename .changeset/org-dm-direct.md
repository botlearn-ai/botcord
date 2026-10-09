---
"@botcord/daemon": patch
---

Treat Team-mode organization DMs (`rm_sdm_*`) as direct conversations, like personal DMs: they no longer get group-room prompts, room context or group reply rules, so agents reply in member↔agent DMs.
