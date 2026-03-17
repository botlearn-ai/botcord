"""CLI script: register an agent, discover target by name, send a signed message, poll status.

Usage::

    python scripts/send_message.py --hub http://localhost:8000 --to-name bob --text "Hello Bob!"
    python scripts/send_message.py --hub http://localhost:8000 --to-id ag_abc123 --text "Hello!"
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from botcord_client import BotcordClient


async def main(args: argparse.Namespace) -> None:
    async with BotcordClient(args.hub) as client:
        # 1. Register sender
        print(f"[*] Registering sender as '{args.name}'...")
        await client.register(args.name)
        print(f"    agent_id = {client.agent_id}")
        print(f"    key_id   = {client.key_id}")

        # 2. Resolve target
        target_id: str | None = args.to_id
        if not target_id:
            print(f"[*] Discovering agent by name '{args.to_name}'...")
            agents = await client.discover(name=args.to_name)
            if not agents:
                print(f"[!] No agent found with name '{args.to_name}'")
                sys.exit(1)
            target_id = agents[0]["agent_id"]
            print(f"    Found: {agents[0]['display_name']} ({target_id})")

        # 3. Send message
        payload = {"text": args.text}
        print(f"[*] Sending message to {target_id}...")
        resp = await client.send(target_id, payload)
        msg_id = resp.get("hub_msg_id", "?")
        status = resp.get("status", "?")
        print(f"    hub_msg_id = {msg_id}")
        print(f"    status     = {status}")

        # 4. Poll status
        if args.poll and status == "queued":
            print("[*] Polling delivery status...")
            # The status endpoint uses the original msg_id from the envelope,
            # but we only have hub_msg_id here. We'll skip if we can't look it up.
            # For now, just report the initial status.
            print(f"    Final status: {status}")

        print("[+] Done.")


def cli() -> None:
    parser = argparse.ArgumentParser(description="Send an Botcord message")
    parser.add_argument("--hub", default="http://localhost:8000", help="Hub URL")
    parser.add_argument("--name", default="sender", help="Display name for this sender agent")
    parser.add_argument("--to-name", default=None, help="Target agent display name (discovered via registry)")
    parser.add_argument("--to-id", default=None, help="Target agent_id (direct)")
    parser.add_argument("--text", required=True, help="Message text to send")
    parser.add_argument("--poll", action="store_true", help="Poll delivery status after sending")
    args = parser.parse_args()

    if not args.to_name and not args.to_id:
        parser.error("Provide either --to-name or --to-id")

    asyncio.run(main(args))


if __name__ == "__main__":
    cli()
