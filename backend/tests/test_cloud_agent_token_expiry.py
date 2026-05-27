import datetime

from hub.services.cloud_agent import _agent_token_expires_at_seconds


def test_agent_token_expires_at_seconds_uses_unix_seconds() -> None:
    expires_at = datetime.datetime(2026, 5, 27, 4, 41, 28, tzinfo=datetime.timezone.utc)

    assert _agent_token_expires_at_seconds(expires_at) == int(expires_at.timestamp())


def test_agent_token_expires_at_seconds_treats_naive_as_utc() -> None:
    expires_at = datetime.datetime(2026, 5, 27, 4, 41, 28)
    expected = int(expires_at.replace(tzinfo=datetime.timezone.utc).timestamp())

    assert _agent_token_expires_at_seconds(expires_at) == expected


def test_agent_token_expires_at_seconds_accepts_none() -> None:
    assert _agent_token_expires_at_seconds(None) is None
