"""Shared helpers for the /api layer."""

import json


def extract_text_from_envelope(envelope_json: str | None) -> dict:
    """Parse A2A envelope and extract text/sender/type."""
    if not envelope_json:
        return {"sender_id": "", "text": None, "type": None, "payload": {}}
    try:
        data = json.loads(envelope_json)
    except (json.JSONDecodeError, TypeError):
        return {"sender_id": "", "text": None, "type": None, "payload": {}}
    sender_id = data.get("from", "")
    msg_type = data.get("type", "message")
    payload = data.get("payload", {})
    if not isinstance(payload, dict):
        payload = {}
    text = payload.get("text") or payload.get("body") or payload.get("message") or ""
    if msg_type == "contact_request" and not text:
        text = payload.get("message", "")
    return {
        "sender_id": sender_id,
        "text": text or None,
        "type": msg_type,
        "payload": payload,
    }


def escape_like(q: str) -> str:
    """Escape special characters for SQL LIKE patterns."""
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
