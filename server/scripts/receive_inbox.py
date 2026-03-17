"""Minimal FastAPI inbox server for an Botcord agent.

On startup: registers agent, verifies key, registers endpoint (pointing to self).
POST /hooks/botcord_inbox/agent: verifies signature, deduplicates, sends ack, logs message, sends result.

Usage::

    python scripts/receive_inbox.py --hub http://localhost:8000 --name alice --port 8001
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import logging
import sys
from contextlib import asynccontextmanager

import httpx
import jcs
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from botcord_client import BotcordClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("inbox")

# Global state filled at startup
client: BotcordClient | None = None
_seen_msg_ids: set[str] = set()


# ------------------------------------------------------------------
# Signature verification helpers
# ------------------------------------------------------------------


def _compute_payload_hash(payload: dict) -> str:
    canonical = jcs.canonicalize(payload)
    digest = hashlib.sha256(canonical).hexdigest()
    return f"sha256:{digest}"


def _build_signing_input(env: dict) -> bytes:
    msg_type = env["type"]
    if hasattr(msg_type, "value"):
        msg_type = msg_type.value
    parts = [
        env["v"],
        env["msg_id"],
        str(env["ts"]),
        env["from"],
        env["to"],
        str(msg_type),
        env.get("reply_to") or "",
        str(env["ttl_sec"]),
        env["payload_hash"],
    ]
    return "\n".join(parts).encode()


async def _verify_incoming(env: dict) -> None:
    """Verify payload hash and Ed25519 signature of an incoming envelope."""
    assert client is not None

    # Payload hash
    expected = _compute_payload_hash(env["payload"])
    if env["payload_hash"] != expected:
        raise HTTPException(status_code=400, detail="Payload hash mismatch")

    # Fetch sender's public key from Hub
    sender_id = env["from"]
    key_id = env["sig"]["key_id"]
    key_info = await client.get_key(sender_id, key_id)
    pubkey_str: str = key_info["pubkey"]  # "ed25519:<base64>"
    pubkey_b64 = pubkey_str[len("ed25519:"):]

    # Verify Ed25519 signature
    signing_input = _build_signing_input(env)
    sig_bytes = base64.b64decode(env["sig"]["value"])
    try:
        vk = VerifyKey(base64.b64decode(pubkey_b64))
        vk.verify(signing_input, sig_bytes)
    except (BadSignatureError, Exception) as exc:
        raise HTTPException(status_code=400, detail=f"Signature verification failed: {exc}")


# ------------------------------------------------------------------
# FastAPI app
# ------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Botcord inbox server")
    parser.add_argument("--hub", default="http://localhost:8000", help="Hub URL")
    parser.add_argument("--name", default="alice", help="Agent display name")
    parser.add_argument("--port", type=int, default=8001, help="Port to listen on")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    return parser.parse_args()


args = parse_args() if "uvicorn" not in sys.modules.get("__main__", object).__class__.__name__ else parse_args()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    client = BotcordClient(args.hub)
    await client.open()

    logger.info("Registering agent '%s' with Hub at %s ...", args.name, args.hub)
    await client.register(args.name)
    logger.info("  agent_id = %s", client.agent_id)
    logger.info("  key_id   = %s", client.key_id)

    inbox_url = f"http://localhost:{args.port}/hooks"
    await client.register_endpoint(inbox_url)
    logger.info("  endpoint = %s", inbox_url)
    logger.info("Agent '%s' ready. Waiting for messages...", args.name)

    yield

    await client.close()


app = FastAPI(title="Botcord Inbox", lifespan=lifespan)


@app.post("/hooks/botcord_inbox/agent")
async def inbox(request: Request):
    """Receive a message envelope from the Hub."""
    assert client is not None
    env = await request.json()

    msg_id = env.get("msg_id", "?")
    msg_type = env.get("type", "?")
    sender = env.get("from", "?")

    # Skip signature verification for Hub-generated error receipts (unsigned)
    if sender != "hub":
        await _verify_incoming(env)

    # Dedup
    if msg_id in _seen_msg_ids:
        logger.info("  [dup] %s from %s — ignored", msg_id, sender)
        return {"status": "duplicate"}
    _seen_msg_ids.add(msg_id)

    # Log
    payload = env.get("payload", {})
    logger.info("[<<] %s from=%s type=%s payload=%s", msg_id, sender, msg_type, payload)

    # For original messages: send ack, then result
    if msg_type == "message":
        # Ack
        try:
            await client.send_receipt(
                to=sender,
                msg_type="ack",
                reply_to=msg_id,
            )
            logger.info("  [>>] ack sent for %s", msg_id)
        except Exception as exc:
            logger.warning("  [!] Failed to send ack: %s", exc)

        # Result
        result_payload = {"text": f"Received your message: {payload.get('text', '')}"}
        try:
            await client.send_receipt(
                to=sender,
                msg_type="result",
                reply_to=msg_id,
                payload=result_payload,
            )
            logger.info("  [>>] result sent for %s", msg_id)
        except Exception as exc:
            logger.warning("  [!] Failed to send result: %s", exc)

    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
