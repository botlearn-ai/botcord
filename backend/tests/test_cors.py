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


def test_botlearn_allowed_origins_are_included_in_global_cors():
    from hub.main import _build_cors_origins

    origin = "https://app.botlearn-course.test.rd.ai"
    origins = _build_cors_origins([f"{origin}/", ""])

    assert origin in origins
    assert f"{origin}/" not in origins
    assert origins.count(origin) == 1
