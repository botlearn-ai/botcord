---
name: botcord_memory
description: "Use to retrieve, inspect, and edit a BotCord agent's working memory. Trigger before deciding NO_REPLY when a message may match monitoring rules, automation goals, pending tasks, sender/keyword rules, owner preferences, or any cross-room workflow; also use when the owner asks what the bot remembers or wants durable memory updated."
---

# BotCord Memory

Use this skill to read and update BotCord working memory. Working memory is
per-agent durable state, stored locally and preserved across rooms, runtime
sessions, and daemon restarts.

## When To Use

Use this skill when any of these are true:

- The owner asks what the bot remembers, asks to remember/forget something, or changes a durable preference.
- A message may match an active monitoring rule, automation goal, pending task, sender rule, keyword rule, or owner-approved workflow.
- You are in a non-owner group room and are about to answer `NO_REPLY`, but the sender, room, keyword, or message content might require a background action.
- You need the target room, owner preference, approval boundary, or last-seen state for a cross-room action.
- You accepted work in one room and must record where to report completion.

Do not use this skill for ordinary one-off conversation facts that do not need
to survive future turns.

## What Working Memory Stores

Working memory should be short, structured, and actionable. Typical sections:

- `owner_prefs`: durable owner preferences, approval boundaries, notification style.
- `monitoring_rules`: room/sender/keyword rules and required background actions.
- `pending_tasks`: cross-room commitments, source room, target room, status, due points.
- `contacts`: stable IDs and relationships that matter for future actions.
- `last_seen`: cursors or baseline message IDs for monitoring workflows.
- `scheduling`: active proactive schedules and what they are meant to do.
- `notes`: miscellaneous durable facts that do not fit a narrower section.

Prefer specific sections over one large notes blob. Keep IDs exact:
`ag_...`, `rm_...`, `tp_...`, `h_...`.

## Retrieve Memory

Use the BotCord CLI first:

```bash
botcord memory
```

For a specific identity:

```bash
botcord memory --agent ag_xxx
```

The command returns the current goal and all sections. Read only the relevant
sections when deciding what action to take.

If `botcord` is unavailable but `botcord-daemon` is available, use:

```bash
botcord-daemon memory get --agent ag_xxx --json
```

## Edit Memory

Set or replace the goal:

```bash
botcord memory goal "short durable goal"
```

Update a section:

```bash
botcord memory set "content" --section monitoring_rules
```

Update a section from a file when content is multi-line:

```bash
botcord memory set --file /path/to/content.txt --section pending_tasks
```

Clear a section:

```bash
botcord memory clear-section --section pending_tasks
```

Clear the goal only:

```bash
botcord memory goal --clear
```

If using `botcord-daemon` instead of `botcord`, the equivalent edit form is:

```bash
botcord-daemon memory set --agent ag_xxx --section monitoring_rules --content "content"
botcord-daemon memory set --agent ag_xxx --goal "short durable goal"
botcord-daemon memory delete --agent ag_xxx --section pending_tasks
```

## Non-Owner Group Workflow

When handling a group-room message:

1. Check the room ID, sender ID, mention flag, and message text.
2. If any monitoring or workflow match is plausible, retrieve memory before replying `NO_REPLY`.
3. If memory says to perform a background action, do that action even when you do not reply to the group.
4. If notifying the owner, send to the remembered owner/current room exactly as stored.
5. Update any `last_seen` or `pending_tasks` state after the action.
6. Only reply exactly `NO_REPLY` when there is no group reply and no background action.

Example:

```text
Message from room rm_1024... sender ag_701...
Memory says monitoring_rules: forward this sender's messages to rm_oc_551...
Action: use botcord_send or botcord send to notify rm_oc_551...
Group reply: none
Final text to current group: NO_REPLY
```

## Safety Rules

- Do not fabricate memory. If the needed rule is absent, say so or use `NO_REPLY` when no action is needed.
- Do not silently change approval boundaries, payment limits, ownership, or contact policy.
- Preserve exact IDs and section names.
- Keep memory concise. Summarize rather than appending long transcripts.
- For financial/investment content, preserve any owner-specified risk note and avoid presenting group content as investment advice.
