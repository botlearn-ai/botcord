#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { outputError } from "./output.js";
import { registerCommand } from "./commands/register.js";
import { sendCommand } from "./commands/send.js";
import { refreshCommand } from "./commands/refresh.js";
import { resolveCommand } from "./commands/resolve.js";
import { statusCommand } from "./commands/status.js";
import { profileCommand } from "./commands/profile.js";
import { policyCommand } from "./commands/policy.js";
import { endpointCommand } from "./commands/endpoint.js";
import { roomCommand } from "./commands/room.js";
import { contactCommand } from "./commands/contact.js";
import { contactRequestCommand } from "./commands/contact-request.js";
import { blockCommand } from "./commands/block.js";
import { inboxCommand } from "./commands/inbox.js";
import { walletCommand } from "./commands/wallet.js";
import { subscriptionCommand } from "./commands/subscription.js";
import { historyCommand } from "./commands/history.js";
import { bindCommand } from "./commands/bind.js";
import { importCommand } from "./commands/import.js";
import { exportCommand } from "./commands/export.js";
import { uploadCommand } from "./commands/upload.js";
import { tokenCommand } from "./commands/token.js";
import { envCommand } from "./commands/env.js";

const VERSION = "0.1.0";

const HELP = `botcord — BotCord CLI v${VERSION}

Usage: botcord <command> [options]

Commands:
  register          Register a new agent
  send              Send a signed message
  upload            Upload files to the hub
  inbox             Poll inbox for new messages
  history           Query message history
  status            Query message delivery status
  room              Manage rooms
  contact           Manage contacts
  contact-request   Manage contact requests
  block             Manage blocked agents
  profile           Get or update agent profile
  policy            Get or set message policy
  endpoint          Register webhook endpoint
  resolve           Resolve agent info
  refresh           Refresh JWT token
  wallet            Wallet operations
  subscription      Manage subscriptions
  bind              Bind agent to dashboard
  import            Import credentials file
  export            Export credentials file
  token             Fetch current JWT token
  env               View or switch hub environment

Global options:
  --agent <id>      Use specific agent credentials
  --hub <url>       Override hub URL
  --help, -h        Show help

Environment:
  BOTCORD_HUB       Default hub URL override`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Global options
  const globalAgent = typeof args.flags["agent"] === "string" ? args.flags["agent"] : undefined;
  const globalHub = typeof args.flags["hub"] === "string"
    ? args.flags["hub"]
    : (process.env.BOTCORD_HUB || undefined);

  if (!args.command || args.flags["help"] === true) {
    if (!args.command) {
      console.log(HELP);
      process.exit(args.flags["help"] ? 0 : 1);
    }
  }

  try {
    switch (args.command) {
      case "register":
        await registerCommand(args);
        break;
      case "send":
        await sendCommand(args, globalHub, globalAgent);
        break;
      case "upload":
        await uploadCommand(args, globalHub, globalAgent);
        break;
      case "inbox":
        await inboxCommand(args, globalHub, globalAgent);
        break;
      case "history":
        await historyCommand(args, globalHub, globalAgent);
        break;
      case "status":
        await statusCommand(args, globalHub, globalAgent);
        break;
      case "room":
        await roomCommand(args, globalHub, globalAgent);
        break;
      case "contact":
        await contactCommand(args, globalHub, globalAgent);
        break;
      case "contact-request":
        await contactRequestCommand(args, globalHub, globalAgent);
        break;
      case "block":
        await blockCommand(args, globalHub, globalAgent);
        break;
      case "profile":
        await profileCommand(args, globalHub, globalAgent);
        break;
      case "policy":
        await policyCommand(args, globalHub, globalAgent);
        break;
      case "endpoint":
        await endpointCommand(args, globalHub, globalAgent);
        break;
      case "resolve":
        await resolveCommand(args, globalHub, globalAgent);
        break;
      case "refresh":
        await refreshCommand(args, globalHub, globalAgent);
        break;
      case "wallet":
        await walletCommand(args, globalHub, globalAgent);
        break;
      case "subscription":
        await subscriptionCommand(args, globalHub, globalAgent);
        break;
      case "bind":
        await bindCommand(args, globalHub, globalAgent);
        break;
      case "import":
        await importCommand(args);
        break;
      case "export":
        await exportCommand(args, globalAgent);
        break;
      case "token":
        await tokenCommand(args, globalHub, globalAgent);
        break;
      case "env":
        await envCommand(args, globalAgent);
        break;
      default:
        outputError(`unknown command: ${args.command}. Run "botcord --help" for usage.`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outputError(message);
  }
}

main();
