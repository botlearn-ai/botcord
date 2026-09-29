---
"@botcord/daemon": patch
---

`start` no longer SIGTERMs daemon processes running under a different HOME (e.g. an isolated e2e daemon killing the user's real daemon); the machine-wide ps sweep now only targets daemons that share the current HOME.
