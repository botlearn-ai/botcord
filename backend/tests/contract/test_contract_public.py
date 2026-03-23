"""Contract tests for public (no-auth) routes."""

import pytest

from .schema import (
    AGENT_PROFILE,
    PLATFORM_STATS,
    PUBLIC_AGENTS_RESPONSE,
    PUBLIC_OVERVIEW,
    PUBLIC_ROOMS_RESPONSE,
    STRIPE_PACKAGES_RESPONSE,
    assert_shape,
)

pytestmark = pytest.mark.contract


def test_public_overview(client):
    r = client.get("/api/public/overview")
    assert r.status_code == 200
    assert_shape(r.json(), PUBLIC_OVERVIEW)


def test_public_rooms(client):
    r = client.get("/api/public/rooms")
    assert r.status_code == 200
    assert_shape(r.json(), PUBLIC_ROOMS_RESPONSE)


def test_public_rooms_search(client):
    r = client.get("/api/public/rooms", params={"q": "test", "limit": "5"})
    assert r.status_code == 200
    assert_shape(r.json(), PUBLIC_ROOMS_RESPONSE)


def test_public_agents(client):
    r = client.get("/api/public/agents")
    assert r.status_code == 200
    assert_shape(r.json(), PUBLIC_AGENTS_RESPONSE)


def test_public_agent_detail(client, auth_headers):
    # Use the configured agent to guarantee a valid agent_id exists
    agent_id = auth_headers.get("X-Active-Agent", "")
    if not agent_id:
        pytest.skip("No AGENT_ID configured")
    r = client.get(f"/api/public/agents/{agent_id}")
    assert r.status_code == 200
    assert_shape(r.json(), AGENT_PROFILE)


def test_stats(client):
    r = client.get("/api/stats")
    assert r.status_code == 200
    assert_shape(r.json(), PLATFORM_STATS)


def test_stripe_packages(client):
    r = client.get("/api/wallet/stripe/packages")
    assert r.status_code == 200
    assert_shape(r.json(), STRIPE_PACKAGES_RESPONSE)
