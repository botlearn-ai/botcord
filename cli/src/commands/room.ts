import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";

function makeClient(globalHub?: string, globalAgent?: string): BotCordClient {
  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  return new BotCordClient({
    hubUrl: globalHub || creds.hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
    token: creds.token,
    tokenExpiresAt: creds.tokenExpiresAt,
  });
}

export async function roomCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  const sub = args.subcommand;

  if (args.flags["help"] || !sub) {
    console.log(`Usage: botcord room <subcommand> [options]

Subcommands:
  create        Create a new room
  get <id>      Get room info
  list          List my rooms
  discover      Discover public rooms
  update        Update room settings
  dissolve      Dissolve a room
  join          Join a room
  leave         Leave a room
  add-member    Add a member to a room
  remove-member Remove a member
  transfer      Transfer room ownership
  promote       Change member role
  mute          Mute/unmute room
  permissions   Set member permissions
  topic         Manage room topics`);
    if (!sub && !args.flags["help"]) process.exit(1);
    return;
  }

  // Handle topic subcommand tree
  if (sub === "topic") {
    await topicSubcommand(args, globalHub, globalAgent);
    return;
  }

  const client = makeClient(globalHub, globalAgent);

  switch (sub) {
    case "create": {
      const name = args.flags["name"];
      if (!name || typeof name !== "string") outputError("--name is required");
      const params: Record<string, unknown> = { name };
      if (typeof args.flags["description"] === "string") params.description = args.flags["description"];
      if (typeof args.flags["visibility"] === "string") params.visibility = args.flags["visibility"];
      if (typeof args.flags["join-policy"] === "string") params.join_policy = args.flags["join-policy"];
      if (typeof args.flags["max-members"] === "string") params.max_members = parseInt(args.flags["max-members"], 10);
      if (typeof args.flags["members"] === "string") params.member_ids = args.flags["members"].split(",");
      const result = await client.createRoom(params as any);
      outputJson(result);
      break;
    }

    case "get": {
      const roomId = args.positionals[0] || args.flags["room"];
      if (!roomId || typeof roomId !== "string") outputError("room_id is required");
      const result = await client.getRoomInfo(roomId);
      outputJson(result);
      break;
    }

    case "list": {
      const result = await client.listMyRooms();
      outputJson(result);
      break;
    }

    case "discover": {
      const name = typeof args.flags["name"] === "string" ? args.flags["name"] : undefined;
      const result = await client.discoverRooms(name);
      outputJson(result);
      break;
    }

    case "update": {
      const roomId = args.flags["room"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      const params: Record<string, unknown> = {};
      if (typeof args.flags["name"] === "string") params.name = args.flags["name"];
      if (typeof args.flags["description"] === "string") params.description = args.flags["description"];
      if (typeof args.flags["visibility"] === "string") params.visibility = args.flags["visibility"];
      if (typeof args.flags["join-policy"] === "string") params.join_policy = args.flags["join-policy"];
      const result = await client.updateRoom(roomId, params as any);
      outputJson(result);
      break;
    }

    case "dissolve": {
      const roomId = args.flags["room"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      await client.dissolveRoom(roomId);
      outputJson({ dissolved: true, room_id: roomId });
      break;
    }

    case "join": {
      const roomId = args.flags["room"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      await client.joinRoom(roomId);
      outputJson({ joined: true, room_id: roomId });
      break;
    }

    case "leave": {
      const roomId = args.flags["room"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      await client.leaveRoom(roomId);
      outputJson({ left: true, room_id: roomId });
      break;
    }

    case "add-member": {
      const roomId = args.flags["room"];
      const agentId = args.flags["id"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      if (!agentId || typeof agentId !== "string") outputError("--id is required");
      await client.inviteToRoom(roomId, agentId);
      outputJson({ added: true, room_id: roomId, agent_id: agentId });
      break;
    }

    case "remove-member": {
      const roomId = args.flags["room"];
      const agentId = args.flags["id"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      if (!agentId || typeof agentId !== "string") outputError("--id is required");
      await client.removeMember(roomId, agentId);
      outputJson({ removed: true, room_id: roomId, agent_id: agentId });
      break;
    }

    case "transfer": {
      const roomId = args.flags["room"];
      const newOwner = args.flags["id"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      if (!newOwner || typeof newOwner !== "string") outputError("--id is required");
      await client.transferOwnership(roomId, newOwner);
      outputJson({ transferred: true, room_id: roomId, new_owner: newOwner });
      break;
    }

    case "promote": {
      const roomId = args.flags["room"];
      const agentId = args.flags["id"];
      const role = args.flags["role"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      if (!agentId || typeof agentId !== "string") outputError("--id is required");
      if (role !== "admin" && role !== "member") outputError("--role must be 'admin' or 'member'");
      await client.promoteMember(roomId, agentId, role);
      outputJson({ promoted: true, room_id: roomId, agent_id: agentId, role });
      break;
    }

    case "mute": {
      const roomId = args.flags["room"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      const muted = args.flags["muted"] !== "false";
      await client.muteRoom(roomId, muted);
      outputJson({ room_id: roomId, muted });
      break;
    }

    case "permissions": {
      const roomId = args.flags["room"];
      const agentId = args.flags["id"];
      if (!roomId || typeof roomId !== "string") outputError("--room is required");
      if (!agentId || typeof agentId !== "string") outputError("--id is required");
      const permissions: { can_send?: boolean; can_invite?: boolean } = {};
      if (typeof args.flags["can-send"] === "string") permissions.can_send = args.flags["can-send"] === "true";
      if (typeof args.flags["can-invite"] === "string") permissions.can_invite = args.flags["can-invite"] === "true";
      await client.setMemberPermissions(roomId, agentId, permissions);
      outputJson({ updated: true, room_id: roomId, agent_id: agentId, ...permissions });
      break;
    }

    default:
      outputError(`unknown subcommand: ${sub}`);
  }
}

async function topicSubcommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  // The topic action is the first positional after "topic" was consumed as subcommand
  const action = args.positionals[0];

  if (args.flags["help"] || !action) {
    console.log(`Usage: botcord room topic <action> [options]

Actions:
  list      --room <id> [--status <status>]
  create    --room <id> --title <title> [--description <text>] [--goal <text>]
  get       --room <id> --topic-id <id>
  update    --room <id> --topic-id <id> [--title ...] [--status ...] [--goal ...]
  delete    --room <id> --topic-id <id>`);
    if (!action && !args.flags["help"]) process.exit(1);
    return;
  }

  const client = makeClient(globalHub, globalAgent);
  const roomId = args.flags["room"];
  if (!roomId || typeof roomId !== "string") outputError("--room is required");

  switch (action) {
    case "list": {
      const status = typeof args.flags["status"] === "string" ? args.flags["status"] : undefined;
      const result = await client.listTopics(roomId, status);
      outputJson(result);
      break;
    }

    case "create": {
      const title = args.flags["title"];
      if (!title || typeof title !== "string") outputError("--title is required");
      const params: { title: string; description?: string; goal?: string } = { title };
      if (typeof args.flags["description"] === "string") params.description = args.flags["description"];
      if (typeof args.flags["goal"] === "string") params.goal = args.flags["goal"];
      const result = await client.createTopic(roomId, params);
      outputJson(result);
      break;
    }

    case "get": {
      const topicId = args.flags["topic-id"];
      if (!topicId || typeof topicId !== "string") outputError("--topic-id is required");
      const result = await client.getTopic(roomId, topicId);
      outputJson(result);
      break;
    }

    case "update": {
      const topicId = args.flags["topic-id"];
      if (!topicId || typeof topicId !== "string") outputError("--topic-id is required");
      const params: { title?: string; description?: string; status?: string; goal?: string } = {};
      if (typeof args.flags["title"] === "string") params.title = args.flags["title"];
      if (typeof args.flags["description"] === "string") params.description = args.flags["description"];
      if (typeof args.flags["status"] === "string") params.status = args.flags["status"];
      if (typeof args.flags["goal"] === "string") params.goal = args.flags["goal"];
      const result = await client.updateTopic(roomId, topicId, params);
      outputJson(result);
      break;
    }

    case "delete": {
      const topicId = args.flags["topic-id"];
      if (!topicId || typeof topicId !== "string") outputError("--topic-id is required");
      await client.deleteTopic(roomId, topicId);
      outputJson({ deleted: true, room_id: roomId, topic_id: topicId });
      break;
    }

    default:
      outputError(`unknown topic action: ${action}`);
  }
}
