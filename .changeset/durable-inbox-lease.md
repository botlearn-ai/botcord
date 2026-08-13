---
"@botcord/daemon": patch
"@botcord/protocol-core": patch
---

Keep inbox messages under a renewable processing lease until runtime handling finishes, then acknowledge them explicitly so crashes requeue work instead of losing it.
