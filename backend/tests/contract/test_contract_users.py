"""Contract tests for user & agent routes."""

import pytest

from .schema import (
    BIND_TICKET_RESPONSE,
    RESET_TICKET_RESPONSE,
    USER_AGENTS_RESPONSE,
    USER_PROFILE,
    assert_shape,
)

pytestmark = pytest.mark.contract


def test_get_me(client, user_headers):
    r = client.get("/api/users/me", headers=user_headers)
    assert r.status_code == 200
    assert_shape(r.json(), USER_PROFILE)


def test_get_me_no_auth(client):
    r = client.get("/api/users/me")
    assert r.status_code == 401


def test_get_my_agents(client, user_headers):
    r = client.get("/api/users/me/agents", headers=user_headers)
    assert r.status_code == 200
    assert_shape(r.json(), USER_AGENTS_RESPONSE)


def test_bind_ticket(client, user_headers):
    r = client.post("/api/users/me/agents/bind-ticket", headers=user_headers)
    assert r.status_code == 200
    assert_shape(r.json(), BIND_TICKET_RESPONSE)


def test_credential_reset_ticket(client, user_headers):
    r = client.post("/api/users/me/agents/ag_agent001/credential-reset-ticket", headers=user_headers)
    assert r.status_code == 200
    assert_shape(r.json(), RESET_TICKET_RESPONSE)
