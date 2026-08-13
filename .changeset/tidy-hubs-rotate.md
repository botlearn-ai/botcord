---
"@botcord/daemon": patch
"@botcord/protocol-core": patch
---

Support staged Hub control signing-key rotation by resolving a multi-key trust
ring in protocol-core and accepting frames signed by any trusted key in the
daemon. Runtime snapshots attest that ring using privacy-safe fingerprints, and
the legacy singular public-key configuration remains compatible.
