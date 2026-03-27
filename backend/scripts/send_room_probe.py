"""
[INPUT]: 依赖 botcord_client.py 复用已存在 agent 身份与签名逻辑，依赖 Hub `/hub/send` 向指定 room 发真实协议消息。
[OUTPUT]: 对外提供 send_room_probe CLI，支持固定 agent 身份向目标 room 连续发送调试消息。
[POS]: backend/scripts 的房间消息联通性探针，用于验证 Python `/hub/send`、Hub 入库与后续 realtime 链路。
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time

from botcord_client import BotcordClient


DEFAULT_HUB = "https://api.botcord.chat"
DEFAULT_AGENT_ID = "ag_5a9359894bc8"
DEFAULT_ROOM_ID = "rm_acafdfb5175b"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send one or more real Hub room messages using an existing agent identity."
    )
    parser.add_argument("--hub", default=os.getenv("BOTCORD_HUB", DEFAULT_HUB), help="Hub base URL")
    parser.add_argument(
        "--agent-id",
        default=os.getenv("BOTCORD_AGENT_ID", DEFAULT_AGENT_ID),
        help="Sender agent_id",
    )
    parser.add_argument(
        "--room-id",
        default=os.getenv("BOTCORD_ROOM_ID", DEFAULT_ROOM_ID),
        help="Target room_id",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("BOTCORD_AGENT_TOKEN"),
        help="Existing agent JWT; defaults to BOTCORD_AGENT_TOKEN",
    )
    parser.add_argument(
        "--key-id",
        default=os.getenv("BOTCORD_KEY_ID"),
        help="Active signing key_id; defaults to BOTCORD_KEY_ID",
    )
    parser.add_argument(
        "--private-key-b64",
        default=os.getenv("BOTCORD_PRIVATE_KEY_B64"),
        help="Base64-encoded Ed25519 private key; defaults to BOTCORD_PRIVATE_KEY_B64",
    )
    parser.add_argument(
        "--text",
        default="room probe",
        help="Message body prefix; sequence number and timestamp are appended automatically",
    )
    parser.add_argument("--count", type=int, default=1, help="How many messages to send")
    parser.add_argument(
        "--interval-sec",
        type=float,
        default=0.0,
        help="Sleep duration between sends when count > 1",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    missing = []
    if not args.token:
        missing.append("BOTCORD_AGENT_TOKEN / --token")
    if not args.key_id:
        missing.append("BOTCORD_KEY_ID / --key-id")
    if not args.private_key_b64:
        missing.append("BOTCORD_PRIVATE_KEY_B64 / --private-key-b64")
    if args.count < 1:
        raise SystemExit("--count must be >= 1")
    if args.interval_sec < 0:
        raise SystemExit("--interval-sec must be >= 0")
    if missing:
        joined = ", ".join(missing)
        raise SystemExit(
            "Missing required signing identity. This script needs a real agent token "
            f"plus signing key material: {joined}"
        )


async def main(args: argparse.Namespace) -> None:
    async with BotcordClient(args.hub) as client:
        client.attach_identity(
            agent_id=args.agent_id,
            key_id=args.key_id,
            token=args.token,
            private_key_b64=args.private_key_b64,
        )

        for index in range(args.count):
            suffix = time.strftime("%Y-%m-%d %H:%M:%S")
            text = f"{args.text} #{index + 1} @ {suffix}" if args.count > 1 else f"{args.text} @ {suffix}"
            response = await client.send(args.room_id, {"text": text})
            print(
                f"[{index + 1}/{args.count}] hub_msg_id={response.get('hub_msg_id')} "
                f"status={response.get('status')} room_id={args.room_id} text={text}"
            )
            if index + 1 < args.count and args.interval_sec > 0:
                await asyncio.sleep(args.interval_sec)


def cli() -> None:
    args = parse_args()
    validate_args(args)
    asyncio.run(main(args))


if __name__ == "__main__":
    cli()
