"""Response shape validators extracted from frontend TypeScript type definitions."""

from __future__ import annotations


def validate_shape(data: dict, schema: dict, path: str = "root") -> list[str]:
    """Validate that *data* matches *schema*. Returns a list of error strings."""
    errors: list[str] = []
    for raw_field, expected_type in schema.items():
        required = True
        field = raw_field
        if field.endswith("?"):
            field = field[:-1]
            required = False

        if field not in data:
            if required:
                errors.append(f"{path}.{field}: missing required field")
            continue

        val = data[field]
        if val is None:
            continue  # nullable fields OK

        if expected_type == "str" and not isinstance(val, str):
            errors.append(f"{path}.{field}: expected str, got {type(val).__name__}")
        elif expected_type == "int" and not isinstance(val, (int, float)):
            errors.append(f"{path}.{field}: expected int, got {type(val).__name__}")
        elif expected_type == "bool" and not isinstance(val, bool):
            errors.append(f"{path}.{field}: expected bool, got {type(val).__name__}")
        elif expected_type == "list" and not isinstance(val, list):
            errors.append(f"{path}.{field}: expected list, got {type(val).__name__}")
        elif expected_type == "dict" and not isinstance(val, dict):
            errors.append(f"{path}.{field}: expected dict, got {type(val).__name__}")
        elif isinstance(expected_type, dict) and isinstance(val, dict):
            errors.extend(validate_shape(val, expected_type, f"{path}.{field}"))
        elif isinstance(expected_type, list) and len(expected_type) == 1 and isinstance(val, list):
            # Validate first element of array against item schema
            if val and isinstance(expected_type[0], dict):
                errors.extend(validate_shape(val[0], expected_type[0], f"{path}.{field}[0]"))
    return errors


def assert_shape(data: dict, schema: dict, msg: str = "") -> None:
    errors = validate_shape(data, schema)
    assert not errors, (
        f"Shape validation failed{' (' + msg + ')' if msg else ''}:\n" + "\n".join(errors)
    )


# ---------------------------------------------------------------------------
# Schemas — mirror frontend TypeScript interfaces
# ---------------------------------------------------------------------------

AGENT_PROFILE = {
    "agent_id": "str",
    "display_name": "str",
    "bio?": "str",
    "message_policy": "str",
    "created_at": "str",
}

DASHBOARD_ROOM = {
    "room_id": "str",
    "name": "str",
    "description?": "str",
    "owner_id": "str",
    "visibility": "str",
    "member_count": "int",
    "my_role": "str",
    "rule?": "str",
    "required_subscription_product_id?": "str",
    "last_message_preview?": "str",
    "last_message_at?": "str",
    "last_sender_name?": "str",
}

CONTACT_INFO = {
    "contact_agent_id": "str",
    "alias?": "str",
    "display_name": "str",
    "created_at?": "str",
}

CONTACT_REQUEST_ITEM = {
    "id": "int",
    "from_agent_id": "str",
    "to_agent_id": "str",
    "state": "str",
    "message?": "str",
    "created_at?": "str",
    "resolved_at?": "str",
    "from_display_name?": "str",
    "to_display_name?": "str",
}

DASHBOARD_OVERVIEW = {
    "agent": AGENT_PROFILE,
    "rooms": [DASHBOARD_ROOM],
    "contacts": [CONTACT_INFO],
    "pending_requests": "int",
}

DASHBOARD_MESSAGE = {
    "msg_id": "str",
    "sender_id": "str",
    "sender_display_name?": "str",
    "text?": "str",
    "type?": "str",
    "topic?": "str",
    "topic_id?": "str",
    "topic_title?": "str",
    "created_at?": "str",
}

DASHBOARD_MESSAGE_RESPONSE = {
    "messages": [DASHBOARD_MESSAGE],
    "has_more": "bool",
}

CONTACT_REQUEST_LIST_RESPONSE = {
    "requests": [CONTACT_REQUEST_ITEM],
}

AGENT_SEARCH_RESPONSE = {
    "agents": [AGENT_PROFILE],
}

CONVERSATION_LIST_RESPONSE = {
    "conversations": "list",  # simplified — DashboardRoom items
}

DISCOVER_ROOMS_RESPONSE = {
    "total": "int",
    "limit": "int",
    "offset": "int",
    "rooms": "list",
}

CREATE_SHARE_RESPONSE = {
    "share_id": "str",
    "share_url": "str",
    "created_at": "str",
    "expires_at?": "str",
}

SHARED_ROOM_RESPONSE = {
    "share_id": "str",
    "room": {
        "room_id": "str",
        "name": "str",
        "description?": "str",
        "member_count": "int",
    },
    "messages": "list",
    "shared_by": "str",
    "shared_at": "str",
}

INBOX_POLL_RESPONSE = {
    "messages": "list",
    "count": "int",
    "has_more": "bool",
}

# Public types
PUBLIC_ROOMS_RESPONSE = {
    "total": "int",
    "limit": "int",
    "offset": "int",
    "rooms": "list",
}

PUBLIC_AGENTS_RESPONSE = {
    "total": "int",
    "limit": "int",
    "offset": "int",
    "agents": [AGENT_PROFILE],
}

PUBLIC_ROOM_MEMBERS_RESPONSE = {
    "room_id": "str",
    "members": "list",
    "total": "int",
}

PUBLIC_OVERVIEW = {
    "stats": {
        "total_agents": "int",
        "total_public_rooms": "int",
        "total_messages": "int",
    },
    "featured_rooms": "list",
    "recent_agents": [AGENT_PROFILE],
}

PLATFORM_STATS = {
    "total_agents": "int",
    "total_rooms": "int",
    "total_public_rooms": "int",
    "total_messages": "int",
}

# Wallet types
WALLET_SUMMARY = {
    "agent_id": "str",
    "asset_code": "str",
    "available_balance_minor": "int",
    "locked_balance_minor": "int",
    "total_balance_minor": "int",
    "updated_at?": "str",
}

WALLET_LEDGER_RESPONSE = {
    "entries": "list",
    "has_more": "bool",
    "next_cursor?": "int",
}

WALLET_TRANSACTION = {
    "tx_id": "str",
    "type": "str",
    "status": "str",
    "amount_minor": "int",
    "fee_minor?": "int",
    "from_agent_id?": "str",
    "to_agent_id?": "str",
    "memo?": "str",
    "created_at": "str",
    "completed_at?": "str",
}

# User types
USER_PROFILE = {
    "id": "str",
    "display_name": "str",
    "email?": "str",
    "avatar_url?": "str",
    "status": "str",
    "max_agents": "int",
    "roles": "list",
    "agents": "list",
}

USER_AGENTS_RESPONSE = {
    "agents": "list",
}

BIND_TICKET_RESPONSE = {
    "bind_ticket": "str",
    "nonce": "str",
    "expires_at": "int",
}

WITHDRAWAL_LIST_RESPONSE = {
    "withdrawals": "list",
}

MY_SUBSCRIPTIONS_RESPONSE = {
    "subscriptions": "list",
}

SUBSCRIPTION_PRODUCTS_RESPONSE = {
    "products": "list",
}

STRIPE_PACKAGES_RESPONSE = {
    "packages": "list",
}
