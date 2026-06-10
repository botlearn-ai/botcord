---
"@botcord/daemon": patch
---

Fix deepseek-tui server process leak: spawn `deepseek serve` in its own process group and SIGTERM the whole group on shutdown (the resolved binary is a dispatcher that re-spawns the real deepseek-tui server, which previously survived); also kill all pooled servers on daemon exit so restarts no longer orphan them.
