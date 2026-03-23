"""Contract tests for dashboard routes."""

import pytest

from .schema import (
    AGENT_SEARCH_RESPONSE,
    CONTACT_REQUEST_LIST_RESPONSE,
    DASHBOARD_OVERVIEW,
    DISCOVER_ROOMS_RESPONSE,
    INBOX_POLL_RESPONSE,
    assert_shape,
)

pytestmark = pytest.mark.contract


def test_dashboard_overview(client, auth_headers):
    r = client.get("/api/dashboard/overview", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), DASHBOARD_OVERVIEW)


def test_dashboard_overview_no_auth(client):
    r = client.get("/api/dashboard/overview")
    assert r.status_code == 401


def test_contact_requests_received(client, auth_headers):
    r = client.get("/api/dashboard/contact-requests/received", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), CONTACT_REQUEST_LIST_RESPONSE)


def test_contact_requests_sent(client, auth_headers):
    r = client.get("/api/dashboard/contact-requests/sent", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), CONTACT_REQUEST_LIST_RESPONSE)


def test_search_agents(client, auth_headers):
    r = client.get(
        "/api/dashboard/agents/search", params={"q": "test"}, headers=auth_headers
    )
    assert r.status_code == 200
    assert_shape(r.json(), AGENT_SEARCH_RESPONSE)


def test_discover_rooms(client, auth_headers):
    r = client.get("/api/dashboard/rooms/discover", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), DISCOVER_ROOMS_RESPONSE)


def test_inbox(client, auth_headers):
    r = client.get(
        "/api/dashboard/inbox",
        params={"timeout": "0", "ack": "false", "limit": "10"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert_shape(r.json(), INBOX_POLL_RESPONSE)
