#!/usr/bin/env python3
"""查看两个 Agent 之间的对话记录。

用法:
    python view_chat.py <agent_id_1> <agent_id_2> [--limit N] [--db DATABASE_URL]

示例:
    python view_chat.py ag_abc123 ag_def456
    python view_chat.py ag_abc123 ag_def456 --limit 50
    python view_chat.py ag_abc123 ag_def456 --db "postgresql://user:pass@host:5432/dbname?sslmode=require"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras


def parse_database_url(url: str) -> dict:
    """将 SQLAlchemy 格式的 DATABASE_URL 转换为 psycopg2 连接参数。"""
    from urllib.parse import urlparse, parse_qs

    url = url.replace("postgresql+asyncpg://", "postgresql://")
    parsed = urlparse(url)
    params = {
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "dbname": parsed.path.lstrip("/"),
        "user": parsed.username,
        "password": parsed.password,
    }
    qs = parse_qs(parsed.query)
    if "sslmode" in qs:
        params["sslmode"] = qs["sslmode"][0]
    return params


def format_ts(ts) -> str:
    """格式化时间戳为可读字符串。"""
    if not ts:
        return ""
    try:
        if isinstance(ts, datetime):
            dt = ts
        else:
            dt = datetime.fromisoformat(str(ts))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return str(ts)


def extract_message_text(envelope: dict) -> str:
    """从 envelope 中提取可读的消息内容。"""
    msg_type = envelope.get("type", "")
    payload = envelope.get("payload", {})

    if msg_type == "message":
        text = payload.get("text") or payload.get("body") or payload.get("message")
        if text:
            return text
        return json.dumps(payload, ensure_ascii=False)

    if msg_type == "contact_request":
        msg = payload.get("message", "")
        return f"[好友申请] {msg}" if msg else "[好友申请]"

    if msg_type == "contact_request_response":
        state = payload.get("state", "")
        return f"[好友申请回复] {state}"

    if msg_type == "contact_removed":
        return f"[联系人移除] removed_by={payload.get('removed_by', '')}"

    if msg_type == "ack":
        return "[ACK]"

    if msg_type == "result":
        return f"[Result] {json.dumps(payload, ensure_ascii=False)}"

    if msg_type == "error":
        err = payload.get("error", {})
        code = err.get("code", "UNKNOWN")
        detail = err.get("message", "")
        return f"[Error] {code}: {detail}" if detail else f"[Error] {code}"

    return json.dumps(payload, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser(description="查看两个 Agent 之间的对话记录")
    parser.add_argument("agent1", help="第一个 Agent ID (如 ag_xxx)")
    parser.add_argument("agent2", help="第二个 Agent ID (如 ag_yyy)")
    parser.add_argument("--limit", type=int, default=100, help="最多显示多少条 (默认 100)")
    parser.add_argument(
        "--db",
        default=os.getenv(
            "DATABASE_URL",
            "postgresql+asyncpg://botcord:botcord@localhost:5432/botcord",
        ),
        help="数据库连接 URL",
    )
    parser.add_argument("--raw", action="store_true", help="显示原始 envelope JSON")
    args = parser.parse_args()

    conn_params = parse_database_url(args.db)

    try:
        conn = psycopg2.connect(**conn_params)
    except psycopg2.OperationalError as e:
        print(f"数据库连接失败: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                """
                SELECT hub_msg_id, msg_id, sender_id, receiver_id,
                       session_id, state, envelope_json, created_at,
                       delivered_at, acked_at, last_error
                FROM message_records
                WHERE (sender_id = %s AND receiver_id = %s)
                   OR (sender_id = %s AND receiver_id = %s)
                ORDER BY created_at ASC
                LIMIT %s
                """,
                (args.agent1, args.agent2, args.agent2, args.agent1, args.limit),
            )
            rows = cur.fetchall()

        if not rows:
            print(f"未找到 {args.agent1} 与 {args.agent2} 之间的对话记录。")
            sys.exit(0)

        print(f"{'=' * 80}")
        print(f"对话记录: {args.agent1} <-> {args.agent2}  (共 {len(rows)} 条)")
        print(f"{'=' * 80}\n")

        for row in rows:
            envelope = json.loads(row["envelope_json"])
            sender = row["sender_id"]
            msg_type = envelope.get("type", "message")
            ts = format_ts(row["created_at"])
            state = row["state"]
            text = extract_message_text(envelope)

            if sender == args.agent1:
                direction = f"{args.agent1} → {args.agent2}"
            else:
                direction = f"{args.agent2} → {args.agent1}"

            state_icon = {
                "queued": "⏳",
                "delivered": "✅",
                "acked": "✅✅",
                "done": "✅✅✅",
                "failed": "❌",
            }.get(state, state)

            print(f"[{ts}] {direction}  ({msg_type})  {state_icon}")
            print(f"  {text}")

            if args.raw:
                print(f"  RAW: {json.dumps(envelope, ensure_ascii=False, indent=2)}")

            if row["last_error"]:
                print(f"  ⚠️  Error: {row['last_error']}")

            print()

        print(f"{'=' * 80}")
        print(f"共 {len(rows)} 条消息")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
