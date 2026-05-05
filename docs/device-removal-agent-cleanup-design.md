<!--
- [INPUT]: Current daemon instance revoke flow, agent unbind flow, My Bots device grouping, and daemon_agent_cleanups durable cleanup queue.
- [OUTPUT]: Product and engineering design for Remove Device, pending local bot cleanup, and agent cleanup semantics.
- [POS]: Shared design doc for frontend/backend/daemon changes around device lifecycle and bot local-state cleanup.
- [PROTOCOL]: Update when Remove Device semantics, daemon cleanup queue behavior, or Agent delete/unbind semantics change.
-->

# Device Removal and Agent Cleanup Design

## Problem

My Bots groups owned bots by `agents.daemon_instance_id`. The frontend already has a daemon revoke API and a daemon settings page can revoke a daemon, but My Bots does not yet expose Remove Device.

The current backend revoke flow only marks a daemon instance revoked and burns its refresh token. It does not detach bots from that daemon. If My Bots simply calls the existing revoke endpoint, bots keep the old `daemon_instance_id`, while revoked daemon instances are hidden from the daemon list. That creates a ghost device group: the device is gone as a daemon, but bots still point at it.

There is a second issue for offline devices. If we immediately revoke an offline daemon, it cannot connect later, so the Hub can never send local `revoke_agent` frames to clean credentials/state on that machine.

## Product Semantics

Remove Device should mean:

- Revoke or forget the local daemon host.
- Keep the user's bots as cloud identities.
- Move bots hosted by that device to `No Device` / unhosted state.
- Best-effort clean those bots from the removed machine.
- Make destructive local cleanup status explicit when the device is offline.

Remove Device must not mean "delete all bots on this device" by default. Bots have cloud identity, rooms, contacts, messages, wallet state, and subscriptions. The device is only their local host.

## Current Implementation

Already implemented:

- `daemon_instances.revoked_at` marks a daemon revoked.
- `POST /daemon/instances/{daemon_instance_id}/revoke`:
  - sets `revoked_at`
  - burns `refresh_token_hash`
  - sends a daemon-level `revoke` control frame if online
  - closes the daemon websocket
- `DaemonAgentCleanup` table stores durable pending local cleanup jobs:
  - `daemon_instance_id`
  - `agent_id`
  - `delete_credentials`
  - `delete_state`
  - `delete_workspace`
  - `status`
  - `attempts`
  - `last_error`
- `process_pending_daemon_cleanups(daemon_instance_id)` sends `revoke_agent` frames for pending cleanup jobs.
- Daemon websocket startup calls `schedule_pending_daemon_cleanups(daemon_instance_id)` after `hello`.
- Agent unbind already queues local cleanup:
  - `DELETE /api/users/me/agents/{agent_id}/binding`
  - deprecated alias: `DELETE /api/users/me/agents/{agent_id}`

Not implemented:

- Device-level remove that bulk detaches bots from a daemon.
- Device-level remove that writes `DaemonAgentCleanup` rows for every hosted bot.
- A daemon "pending removal" state that allows an offline daemon to reconnect only to drain cleanup jobs.
- Automatic final daemon revoke after all pending cleanup jobs for a removed device succeed.
- My Bots Remove Device UI.
- UI copy that distinguishes "Remove when online" from "Forget offline device anyway".

## Proposed State Model

Add a device removal state separate from `revoked_at`.

Recommended columns on `daemon_instances`:

- `removal_requested_at timestamptz null`
- `removal_reason text null`
- `cleanup_required boolean not null default false`
- `cleanup_completed_at timestamptz null`

Alternative: use a `status` enum-like string. The column approach is less invasive because existing logic already treats `revoked_at` as terminal.

Derived states:

- `active`: `revoked_at is null` and `removal_requested_at is null`
- `removal_pending`: `revoked_at is null` and `removal_requested_at is not null`
- `revoked`: `revoked_at is not null`

Important rule:

Do not set `revoked_at` for an offline device that still has pending local cleanup jobs, unless the user explicitly chooses "Forget anyway".

## Remove Device Flows

### 1. Online Device With Hosted Bots

1. User clicks Remove Device in My Bots.
2. Frontend shows confirmation:
   - device label
   - number of hosted bots
   - list of bot names or first few names
   - copy: bots will move to No Device; identities and history are kept
3. Backend endpoint performs one transaction:
   - load owned daemon instance
   - select active owned agents with `daemon_instance_id = device id`
   - run the same safety checks used by agent unbind only if the operation is actually unbinding/decommissioning bots from the user. For Remove Device, bots stay owned, so wallet/subscription checks should not block.
   - set each selected agent's `daemon_instance_id = null`
   - clear or adjust `hosting_kind` if it means "currently daemon-hosted"
   - insert `DaemonAgentCleanup` rows for each selected agent
   - set `removal_requested_at`
4. Because daemon is online, backend schedules cleanup immediately.
5. `process_pending_daemon_cleanups` sends `revoke_agent` frames.
6. When all cleanup rows for that daemon removal succeed, backend revokes the daemon:
   - set `cleanup_completed_at`
   - set `revoked_at`
   - burn refresh token
   - send daemon-level `revoke` and close websocket
7. Frontend refreshes:
   - device disappears from My Bots
   - bots appear under `No Device`

### 2. Offline Device With Hosted Bots

1. User clicks Remove Device.
2. Frontend shows stronger confirmation:
   - device is offline
   - bots will move to No Device now
   - local credentials/state cannot be cleaned until the old daemon starts again
3. Backend:
   - detaches bots from the device
   - inserts pending `DaemonAgentCleanup` rows
   - sets `removal_requested_at`
   - does not set `revoked_at`
4. My Bots should hide devices in `removal_pending` from normal device groups, but show a small "Pending device cleanup" status somewhere if needed.
5. When the daemon later starts with the old credentials:
   - Hub accepts the websocket because `revoked_at` is still null
   - Hub sends `hello`
   - Hub drains pending cleanup jobs
   - Hub finalizes revoke after cleanup succeeds

### 3. Forget Offline Device Anyway

This is the escape hatch.

Use when the user no longer has access to the machine, or does not care about local cleanup.

Backend:

- detach bots from the device
- optionally mark existing cleanup jobs as `cancelled` or `failed` with `last_error = "device forgotten before local cleanup"`
- set `revoked_at`
- burn refresh token

Frontend copy must be explicit:

"This device is offline. BotCord cannot clean local credentials or state from that machine. Forgetting it only removes Hub access."

## Agent Cleanup Semantics

There are three separate concepts and they should stay separate.

### Remove Device

Device lifecycle operation.

- Bots remain owned by the user.
- Bots move to No Device.
- Local bot credentials/state on that machine are best-effort cleaned.
- Does not cancel subscriptions or unclaim the bots.
- Should not run wallet/subscription "can unbind" blockers because bot ownership remains.

### Unbind Agent

Current implementation.

The frontend label currently says Delete Agent, but the backend behavior is unbind/decommission from current user.

Implemented behavior:

- Rejects if agent wallet is not empty.
- Rejects if active products have active subscribers.
- Rejects if pending wallet/topup/withdrawal/charge obligations exist.
- Cancels subscriptions where this agent is the subscriber.
- Queues `DaemonAgentCleanup` for local `revoke_agent`.
- Clears cloud ownership and credentials:
  - `user_id = null`
  - `claimed_at = null`
  - `is_default = false`
  - `agent_token = null`
  - `token_expires_at = null`
  - `daemon_instance_id = null`
  - new `claim_code`
- Promotes another default agent when needed.
- Removes agent owner role when the user has no remaining agents.

Not implemented as part of unbind:

- `agents.status = "deleted"`
- `deleted_at`
- hard deletion of agent row
- deletion of historical messages
- removal from rooms
- contact graph cleanup
- wallet ledger deletion
- subscription/product archival beyond current blockers and subscriber cancellation

### Hard Delete Agent

Not implemented and should be designed separately.

Hard delete needs explicit policy for:

- historical messages
- room membership and ownership transfer
- contacts and contact requests
- public profiles and discovery
- wallet ledger retention
- subscriptions and products
- files and audit records
- local daemon cleanup

Do not implement Hard Delete by expanding Remove Device.

## Backend API Proposal

Add:

```http
POST /daemon/instances/{daemon_instance_id}/remove
```

Request:

```json
{
  "forget_if_offline": false
}
```

Response:

```json
{
  "ok": true,
  "daemon_instance_id": "dm_...",
  "status": "removal_pending",
  "was_online": false,
  "detached_agents": [
    {
      "agent_id": "ag_...",
      "display_name": "Bot name"
    }
  ],
  "cleanup_jobs_queued": 2
}
```

If `forget_if_offline = true`, response status may be `revoked`.

Implementation notes:

- Reuse daemon ownership checks from `_load_owned_instance`.
- Bulk detach only active agents owned by the current user and bound to that daemon.
- Insert one cleanup row per detached agent.
- Avoid duplicate pending cleanup rows for the same daemon/agent pair if the endpoint is retried.
- Do not call existing `revoke_instance` directly until cleanup is either complete or explicitly abandoned.

## Cleanup Finalization

Extend `process_pending_daemon_cleanups` or add a follow-up helper:

1. Drain pending rows for the daemon.
2. Check whether the daemon has `removal_requested_at is not null`.
3. If there are no remaining pending rows for that daemon:
   - if all rows succeeded or cancelled due to no longer applicable, finalize removal
   - set `cleanup_completed_at`
   - call internal daemon revoke logic

The finalization helper should avoid closing the websocket before all `revoke_agent` acks are processed.

## Frontend My Bots Proposal

Add Remove Device inside `DeviceSettingsModal`.

UI behavior:

- Show danger section at bottom.
- Button label:
  - online: `Remove device`
  - offline: `Remove device...`
- Confirmation includes hosted bot count.
- Online copy: bots move to No Device and local state will be cleaned now.
- Offline copy: bots move to No Device now, local cleanup waits for the device to start again.
- Secondary offline action: `Forget anyway`.

After success:

- close modal
- refresh daemons
- refresh owned agents/session overview
- route selected bot if the current selection depended on a hidden device only if needed

My Bots grouping must not reconstruct a normal device section from agents whose old daemon is `removal_pending` or `revoked`. Since remove detaches agents, the normal case is simply `No Device`.

## Tests

Backend tests:

- online remove detaches all hosted agents and queues cleanup rows
- online remove sends `revoke_agent` frames and finalizes daemon revoke after success
- offline remove detaches agents, queues pending cleanup, does not set `revoked_at`
- reconnect after offline remove drains cleanup then revokes daemon
- forget offline device detaches agents and revokes daemon immediately
- remove device is idempotent
- remove device does not detach agents owned by another user
- remove device does not detach inactive/deleted agents unless explicitly intended

Frontend tests or build checks:

- My Bots device settings shows Remove Device
- confirmation copy changes for online/offline
- successful remove moves bots to No Device after stores refresh
- offline pending state does not show a ghost device

Daemon/plugin tests:

- `revoke_agent` deletes local credentials and state according to flags
- repeated `revoke_agent` is idempotent
- daemon-level `revoke` after cleanup clears daemon auth

## Rollout Plan

1. Backend migration for daemon removal state.
2. Backend internal helper to detach all active owned agents from a daemon and queue cleanup.
3. New remove endpoint with online/offline/forget behavior.
4. Cleanup finalization after pending rows drain.
5. Frontend BFF route and `useDaemonStore.removeDevice`.
6. My Bots `DeviceSettingsModal` UI.
7. Copy pass: rename current "Delete Agent" UI if we want it to reflect actual unbind semantics.
8. Tests across backend and frontend build.

## Open Questions

- Should pending-removal devices be visible on `/settings/daemons`, and if yes, as "Cleanup pending"?
- Should users be able to cancel pending device removal before the old daemon reconnects?
- Should Remove Device clear `hosting_kind`, or should `hosting_kind` remain as historical provenance?
- Should cleanup rows for device removal use `delete_workspace = false` by default, matching current unbind behavior?
- Should Hard Delete Agent become a separate future project with retention/audit policy?
