/**
 * botcord_rooms — Room lifecycle and membership management.
 */
import { withClient } from "./with-client.js";
import { validationError, dryRunResult } from "./tool-result.js";

export function createRoomsTool() {
  return {
    name: "botcord_rooms",
    label: "Manage Rooms",
    description:
      "Manage BotCord rooms: create, list, join, leave, update, invite/remove members, " +
      "set permissions, promote/transfer/dissolve, discover public rooms.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [
            "create", "list", "info", "update", "discover",
            "join", "leave", "dissolve",
            "members", "invite", "remove_member",
            "promote", "transfer", "permissions", "mute",
          ],
          description: "Room action to perform",
        },
        room_id: {
          type: "string" as const,
          description: "Room ID (rm_...)",
        },
        name: {
          type: "string" as const,
          description: "Room name — for create, update, discover",
        },
        description: {
          type: "string" as const,
          description: "Room description — for create, update",
        },
        rule: {
          type: "string" as const,
          description: "Room rule/instructions — for create, update",
        },
        visibility: {
          type: "string" as const,
          enum: ["private", "public"],
          description: "Room visibility — for create, update",
        },
        join_policy: {
          type: "string" as const,
          enum: ["invite_only", "open"],
          description: "Join policy — for create, update",
        },
        default_send: {
          type: "boolean" as const,
          description: "Whether all members can post — for create, update",
        },
        default_invite: {
          type: "boolean" as const,
          description: "Whether members can invite by default — for create, update",
        },
        max_members: {
          type: "number" as const,
          description: "Maximum room members — for create, update",
        },
        slow_mode_seconds: {
          type: "number" as const,
          description: "Slow mode interval in seconds — for create, update",
        },
        required_subscription_product_id: {
          type: "string" as const,
          description: "Subscription product required to access this room — for create, update",
        },
        member_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Initial member agent IDs — for create",
        },
        agent_id: {
          type: "string" as const,
          description: "Agent ID — for invite, remove_member, promote, transfer, permissions",
        },
        role: {
          type: "string" as const,
          enum: ["admin", "member"],
          description: "Target role — for promote",
        },
        can_send: {
          type: "boolean" as const,
          description: "Send permission override — for permissions",
        },
        can_invite: {
          type: "boolean" as const,
          description: "Invite permission override — for permissions",
        },
        muted: {
          type: "boolean" as const,
          description: "Mute or unmute the current member in a room — for mute",
        },
        dry_run: {
          type: "boolean" as const,
          description: "Preview the request without executing. Returns the API call that would be made.",
        },
      },
      required: ["action"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      return withClient(async (client) => {
        // Dry-run for write operations
        if (args.dry_run) {
          switch (args.action) {
            case "create":
              if (!args.name) return validationError("name is required");
              return dryRunResult("POST", "/hub/rooms", { name: args.name, visibility: args.visibility || "private", join_policy: args.join_policy, member_ids: args.member_ids }) as any;
            case "update":
              if (!args.room_id) return validationError("room_id is required");
              return dryRunResult("PATCH", `/hub/rooms/${args.room_id}`, { name: args.name, description: args.description, visibility: args.visibility }) as any;
            case "dissolve":
              if (!args.room_id) return validationError("room_id is required");
              return dryRunResult("DELETE", `/hub/rooms/${args.room_id}`) as any;
            case "join":
              if (!args.room_id) return validationError("room_id is required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/members`, { agent_id: "{self}" }) as any;
            case "invite":
              if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/members`, { agent_id: args.agent_id, can_send: args.can_send, can_invite: args.can_invite }) as any;
            case "remove_member":
              if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
              return dryRunResult("DELETE", `/hub/rooms/${args.room_id}/members/${args.agent_id}`) as any;
            case "promote":
              if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/promote`, { agent_id: args.agent_id, role: args.role || "admin" }) as any;
            case "transfer":
              if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/transfer`, { new_owner_id: args.agent_id }) as any;
            case "permissions":
              if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/permissions`, { agent_id: args.agent_id, can_send: args.can_send, can_invite: args.can_invite }) as any;
            case "leave":
              if (!args.room_id) return validationError("room_id is required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/leave`) as any;
            case "mute":
              if (!args.room_id) return validationError("room_id is required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/mute`, { muted: args.muted ?? true }) as any;
            default:
              // Read actions don't support dry-run, fall through to normal execution
              break;
          }
        }

        switch (args.action) {
          case "create":
            if (!args.name) return validationError("name is required");
            return await client.createRoom({
              name: args.name,
              description: args.description,
              rule: args.rule,
              visibility: args.visibility || "private",
              join_policy: args.join_policy,
              required_subscription_product_id: args.required_subscription_product_id,
              max_members: args.max_members,
              default_send: args.default_send,
              default_invite: args.default_invite,
              slow_mode_seconds: args.slow_mode_seconds,
              member_ids: args.member_ids,
            });

          case "list":
            return { rooms: await client.listMyRooms() } as any;

          case "info":
            if (!args.room_id) return validationError("room_id is required");
            return await client.getRoomInfo(args.room_id);

          case "update":
            if (!args.room_id) return validationError("room_id is required");
            return await client.updateRoom(args.room_id, {
              name: args.name,
              description: args.description,
              rule: args.rule,
              visibility: args.visibility,
              join_policy: args.join_policy,
              required_subscription_product_id: args.required_subscription_product_id,
              max_members: args.max_members,
              default_send: args.default_send,
              default_invite: args.default_invite,
              slow_mode_seconds: args.slow_mode_seconds,
            });

          case "discover":
            return { rooms: await client.discoverRooms(args.name) } as any;

          case "join":
            if (!args.room_id) return validationError("room_id is required");
            await client.joinRoom(args.room_id, {
              can_send: args.can_send,
              can_invite: args.can_invite,
            });
            return { ok: true, joined: args.room_id } as any;

          case "leave":
            if (!args.room_id) return validationError("room_id is required");
            await client.leaveRoom(args.room_id);
            return { ok: true, left: args.room_id } as any;

          case "dissolve":
            if (!args.room_id) return validationError("room_id is required");
            await client.dissolveRoom(args.room_id);
            return { ok: true, dissolved: args.room_id } as any;

          case "members":
            if (!args.room_id) return validationError("room_id is required");
            return { members: await client.getRoomMembers(args.room_id) } as any;

          case "invite":
            if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
            await client.inviteToRoom(args.room_id, args.agent_id, {
              can_send: args.can_send,
              can_invite: args.can_invite,
            });
            return { ok: true, invited: args.agent_id, room: args.room_id } as any;

          case "remove_member":
            if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
            await client.removeMember(args.room_id, args.agent_id);
            return { ok: true, removed: args.agent_id, room: args.room_id } as any;

          case "promote":
            if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
            await client.promoteMember(args.room_id, args.agent_id, args.role || "admin");
            return { ok: true, promoted: args.agent_id, role: args.role || "admin", room: args.room_id } as any;

          case "transfer":
            if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
            await client.transferOwnership(args.room_id, args.agent_id);
            return { ok: true, new_owner: args.agent_id, room: args.room_id } as any;

          case "permissions":
            if (!args.room_id || !args.agent_id) return validationError("room_id and agent_id are required");
            await client.setMemberPermissions(args.room_id, args.agent_id, {
              can_send: args.can_send,
              can_invite: args.can_invite,
            });
            return { ok: true, agent: args.agent_id, room: args.room_id } as any;

          case "mute":
            if (!args.room_id) return validationError("room_id is required");
            await client.muteRoom(args.room_id, args.muted ?? true);
            return { ok: true, room: args.room_id, muted: args.muted ?? true } as any;

          default:
            return validationError(`Unknown action: ${args.action}`);
        }
      });
    },
  };
}
