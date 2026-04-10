"""Tests for the i18n module — error messages, hints, and I18nHTTPException."""

from hub.i18n import (
    ERROR_MESSAGES,
    HINT_MESSAGES,
    I18nHTTPException,
    Locale,
    get_hint,
    get_message,
    resolve_service_error_hint,
)


# ---------------------------------------------------------------------------
# get_message
# ---------------------------------------------------------------------------


def test_get_message_en():
    msg = get_message("agent_not_found", Locale.EN)
    assert msg == "Agent not found"


def test_get_message_zh():
    msg = get_message("agent_not_found", Locale.ZH)
    assert "Agent" in msg or "未找到" in msg


def test_get_message_with_kwargs():
    msg = get_message("conversation_rate_limit_exceeded", Locale.EN, limit=10)
    assert "10" in msg


def test_get_message_unknown_key():
    msg = get_message("totally_nonexistent_key_xyz")
    assert msg == "totally_nonexistent_key_xyz"


# ---------------------------------------------------------------------------
# get_hint
# ---------------------------------------------------------------------------


def test_get_hint_en():
    hint = get_hint("agent_not_found", Locale.EN)
    assert hint is not None
    assert "ag_" in hint


def test_get_hint_zh():
    hint = get_hint("agent_not_found", Locale.ZH)
    assert hint is not None
    assert any(c > "\u4e00" for c in hint)  # contains Chinese characters


def test_get_hint_returns_none_for_missing_key():
    assert get_hint("totally_nonexistent_key_xyz", Locale.EN) is None


def test_get_hint_with_kwargs():
    # Hints that use format placeholders should work
    hint = get_hint("rate_limit_exceeded", Locale.EN)
    assert hint is not None


def test_all_error_messages_have_hints():
    """Every key in ERROR_MESSAGES should have a corresponding HINT_MESSAGES entry."""
    missing = set(ERROR_MESSAGES.keys()) - set(HINT_MESSAGES.keys())
    assert not missing, f"ERROR_MESSAGES keys missing hints: {missing}"


# ---------------------------------------------------------------------------
# resolve_service_error_hint
# ---------------------------------------------------------------------------


def test_resolve_insufficient_balance():
    assert resolve_service_error_hint("Insufficient balance") == "hint_insufficient_balance"


def test_resolve_amount_positive():
    assert resolve_service_error_hint("Amount must be positive") == "hint_amount_must_be_positive"


def test_resolve_recipient_not_found():
    assert resolve_service_error_hint("Recipient agent not found") == "hint_recipient_not_found"


def test_resolve_cannot_transfer_self():
    assert resolve_service_error_hint("Cannot transfer to yourself") == "hint_cannot_transfer_to_self"


def test_resolve_idempotency():
    assert resolve_service_error_hint("Idempotency conflict") == "hint_idempotency_conflict"


def test_resolve_not_found_generic():
    # "not found" substring matches hint_request_not_found
    assert resolve_service_error_hint("Topup request not found") == "hint_request_not_found"


def test_resolve_wrong_status():
    assert resolve_service_error_hint("Topup is not pending (current: completed)") == "hint_request_wrong_status"


def test_resolve_unknown_error():
    assert resolve_service_error_hint("Some completely unknown error message") is None


def test_resolve_subscription_product_not_found():
    """Specific 'Subscription product not found' must NOT match generic 'not found'."""
    assert resolve_service_error_hint("Subscription product not found") == "hint_subscription_product_not_found"


def test_resolve_subscription_not_found():
    assert resolve_service_error_hint("Subscription not found") == "hint_subscription_not_found"


def test_resolve_subscription_already_exists():
    """'Subscription already exists' must match its own hint, not the product-exists hint."""
    assert resolve_service_error_hint("Subscription already exists") == "hint_subscription_already_exists"


def test_resolve_not_authorized_archive():
    assert resolve_service_error_hint("Not authorized to archive this product") == "hint_not_authorized_archive"


def test_resolve_not_authorized_cancel():
    assert resolve_service_error_hint("Not authorized to cancel this subscription") == "hint_not_authorized_cancel"


def test_resolve_generic_not_authorized():
    """Generic 'Not authorized' without specifics uses the generic hint."""
    assert resolve_service_error_hint("Not authorized") == "hint_not_authorized_generic"


# ---------------------------------------------------------------------------
# I18nHTTPException
# ---------------------------------------------------------------------------


def test_exception_basic():
    exc = I18nHTTPException(status_code=404, message_key="agent_not_found")
    assert exc.status_code == 404
    assert exc.message_key == "agent_not_found"
    assert exc.hint_key is None
    assert exc.message_kwargs == {}


def test_exception_with_hint_key():
    exc = I18nHTTPException(
        status_code=400,
        message_key="wallet_service_error",
        hint_key="hint_insufficient_balance",
        detail="Insufficient balance",
    )
    assert exc.hint_key == "hint_insufficient_balance"
    assert exc.message_kwargs["detail"] == "Insufficient balance"


def test_exception_backward_compat():
    """Old-style raise without hint_key should still work."""
    exc = I18nHTTPException(status_code=400, message_key="rate_limit_exceeded")
    assert exc.hint_key is None
    assert exc.message_key == "rate_limit_exceeded"


# ---------------------------------------------------------------------------
# Hint catalog quality checks
# ---------------------------------------------------------------------------


def test_all_hints_have_both_locales():
    """Every hint entry should have both EN and ZH translations."""
    for key, msgs in HINT_MESSAGES.items():
        assert Locale.EN in msgs, f"HINT_MESSAGES[{key!r}] missing EN"
        assert Locale.ZH in msgs, f"HINT_MESSAGES[{key!r}] missing ZH"


def test_no_empty_hints():
    """No hint message should be empty."""
    for key, msgs in HINT_MESSAGES.items():
        for locale, text in msgs.items():
            assert text.strip(), f"HINT_MESSAGES[{key!r}][{locale}] is empty"


def test_hint_with_url_template_does_not_crash():
    """Hints containing literal {agent_id} in URLs must not crash get_hint()."""
    # These hints have {{agent_id}} (escaped) in the template
    for key in ("no_endpoint_registered", "agent_discovery_disabled", "token_expired"):
        hint = get_hint(key, Locale.EN)
        assert hint is not None
        # The literal {agent_id} should appear in the output (not substituted)
        assert "{agent_id}" in hint
