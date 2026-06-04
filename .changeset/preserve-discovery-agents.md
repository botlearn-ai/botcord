---
"@botcord/daemon": patch
---

fix: preserve discovery-loaded agents when provisioning. When the daemon booted via credential discovery (empty `config.agents`), provisioning a single agent persisted `agents: [newId]` and silently dropped every other discovered agent on the next restart — surfacing later as `agent_not_loaded` when their schedules fired. `addAgentToConfig` now folds the gateway's currently-loaded agent channels into the persisted list.
