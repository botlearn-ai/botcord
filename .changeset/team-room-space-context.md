---
"@botcord/daemon": minor
"@botcord/protocol-core": minor
---

Honor the Hub's Team room `space_context` on inbox messages: in organization rooms, requests from anyone but the agent's owner run with the restricted (read-only) profile regardless of local route config (grantees still follow their `access_context` role), and runtimes that cannot enforce restriction refuse the turn instead of running with full permissions. `protocol-core` adds the `SpaceContext` inbox type.
