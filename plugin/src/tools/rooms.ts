/**
 * botcord_rooms — Room lifecycle and membership management.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { getConfig as getAppConfig } from "../runtime.js";

export function createRoomsTool() {
  return {
    name: "botcord_rooms",
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
            "promote", "transfer", "permissions",
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
      },
      required: ["action"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      const cfg = getAppConfig();
      if (!cfg) return { error: "No configuration available" };
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) return { error: singleAccountError };

      const acct = resolveAccountConfig(cfg);
      if (!isAccountConfigured(acct)) {
        return { error: "BotCord is not configured." };
      }

      const client = new BotCordClient(acct);

      try {
        switch (args.action) {
          case "create":
            if (!args.name) return { error: "name is required" };
            return await client.createRoom({
              name: args.name,
              description: args.description,
              rule: args.rule,
              visibility: args.visibility || "private",
              join_policy: args.join_policy,
              default_send: args.default_send,
            });

          case "list":
            return await client.listMyRooms();

          case "info":
            if (!args.room_id) return { error: "room_id is required" };
            return await client.getRoomInfo(args.room_id);

          case "update":
            if (!args.room_id) return { error: "room_id is required" };
            return await client.updateRoom(args.room_id, {
              name: args.name,
              description: args.description,
              rule: args.rule,
              visibility: args.visibility,
              join_policy: args.join_policy,
              default_send: args.default_send,
            });

          case "discover":
            return await client.discoverRooms(args.name);

          case "join":
            if (!args.room_id) return { error: "room_id is required" };
            await client.joinRoom(args.room_id);
            return { ok: true, joined: args.room_id };

          case "leave":
            if (!args.room_id) return { error: "room_id is required" };
            await client.leaveRoom(args.room_id);
            return { ok: true, left: args.room_id };

          case "dissolve":
            if (!args.room_id) return { error: "room_id is required" };
            await client.dissolveRoom(args.room_id);
            return { ok: true, dissolved: args.room_id };

          case "members":
            if (!args.room_id) return { error: "room_id is required" };
            return await client.getRoomMembers(args.room_id);

          case "invite":
            if (!args.room_id || !args.agent_id) return { error: "room_id and agent_id are required" };
            await client.inviteToRoom(args.room_id, args.agent_id);
            return { ok: true, invited: args.agent_id, room: args.room_id };

          case "remove_member":
            if (!args.room_id || !args.agent_id) return { error: "room_id and agent_id are required" };
            await client.removeMember(args.room_id, args.agent_id);
            return { ok: true, removed: args.agent_id, room: args.room_id };

          case "promote":
            if (!args.room_id || !args.agent_id) return { error: "room_id and agent_id are required" };
            await client.promoteMember(args.room_id, args.agent_id, args.role || "admin");
            return { ok: true, promoted: args.agent_id, role: args.role || "admin", room: args.room_id };

          case "transfer":
            if (!args.room_id || !args.agent_id) return { error: "room_id and agent_id are required" };
            await client.transferOwnership(args.room_id, args.agent_id);
            return { ok: true, new_owner: args.agent_id, room: args.room_id };

          case "permissions":
            if (!args.room_id || !args.agent_id) return { error: "room_id and agent_id are required" };
            await client.setMemberPermissions(args.room_id, args.agent_id, {
              can_send: args.can_send,
              can_invite: args.can_invite,
            });
            return { ok: true, agent: args.agent_id, room: args.room_id };

          default:
            return { error: `Unknown action: ${args.action}` };
        }
      } catch (err: any) {
        return { error: `Room action failed: ${err.message}` };
      }
    },
  };
}
