"""CORS coverage for deployed frontend origins."""

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "origin",
    [
        "https://preview.botcord.chat",
        "https://botcord.chat",
        "https://www.botcord.chat",
    ],
)
async def test_deployed_frontend_origins_pass_preflight(origin: str):
    from hub.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.options(
            "/api/users/me",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization,x-active-agent",
            },
        )

    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == origin
    assert "authorization" in res.headers["access-control-allow-headers"].lower()
    assert "x-active-agent" in res.headers["access-control-allow-headers"].lower()
