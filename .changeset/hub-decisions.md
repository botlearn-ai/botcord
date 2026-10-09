---
"@botcord/daemon": minor
"@botcord/protocol-core": minor
---

Execute the Hub's per-message decision (`InboxMessage.hub_decision`): whether the message wakes the agent and how far it may make the agent act (full / collaborator / read-only / refused). Local `nonOwnerExecution` can only tighten it. Messages without a Hub decision keep the previous behavior.
