"""Contract test fixtures — requires live backend + Supabase JWT.

Usage:
  CONTRACT_BASE_URL=https://api.botcord.chat \
  CONTRACT_SUPABASE_TOKEN=eyJ... \
  CONTRACT_AGENT_ID=ag_... \
  uv run pytest tests/contract/ -v
"""

import os

import httpx
import pytest

BASE_URL = os.environ.get("CONTRACT_BASE_URL", "http://localhost:8000")
SUPABASE_TOKEN = os.environ.get("CONTRACT_SUPABASE_TOKEN", "")
AGENT_ID = os.environ.get("CONTRACT_AGENT_ID", "")

_SKIP = not SUPABASE_TOKEN or not AGENT_ID


def pytest_collection_modifyitems(items):
    """Skip every item in this package when credentials are absent."""
    if not _SKIP:
        return
    skip_marker = pytest.mark.skip(
        reason="CONTRACT_SUPABASE_TOKEN and CONTRACT_AGENT_ID required"
    )
    for item in items:
        if item.nodeid.startswith("tests/contract/"):
            item.add_marker(skip_marker)


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def auth_headers():
    return {
        "Authorization": f"Bearer {SUPABASE_TOKEN}",
        "X-Active-Agent": AGENT_ID,
    }


@pytest.fixture(scope="session")
def user_headers():
    """Auth without X-Active-Agent (user-only routes)."""
    return {"Authorization": f"Bearer {SUPABASE_TOKEN}"}


@pytest.fixture(scope="session")
def client(base_url):
    with httpx.Client(base_url=base_url, timeout=30, trust_env=False) as c:
        yield c
