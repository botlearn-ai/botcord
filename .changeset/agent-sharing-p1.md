---
"@botcord/daemon": minor
"@botcord/protocol-core": minor
---

Agent sharing P1: honor Hub-issued `access_context` on inbox messages. Grantees run as `consultant` (read-only) or `collaborator` — edits confined to a per-grant git worktree on branch `guest/<grant>` (Claude Code `acceptEdits` with a scoped Bash allowlist; Codex `workspace-write` without network or tmp), committed by the daemon after each turn with the branch summary appended to the reply. Inactive grants, and runtimes that cannot enforce a grant, are refused without spawning the CLI. Host credential environment variables are scrubbed from non-owner turns, and grant turns use grant-scoped sessions. `protocol-core` adds the `AccessContext` inbox type.
