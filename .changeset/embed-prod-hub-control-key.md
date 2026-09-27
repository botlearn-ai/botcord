---
"@botcord/protocol-core": patch
"@botcord/daemon": patch
---

Embed the production Hub control signing public key in the default trust ring so daemons without `BOTCORD_HUB_CONTROL_PUBLIC_KEYS` configuration accept control frames (wake_agent, provision_agent, …) from the rotated production signer.
