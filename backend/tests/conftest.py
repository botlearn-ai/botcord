import pytest


@pytest.fixture(autouse=True)
def disable_endpoint_probe(monkeypatch):
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", False)


@pytest.fixture(autouse=True)
def _clear_rate_windows():
    """Clear in-memory rate-limit windows before each test."""
    from hub.routers import hub as hub_mod

    hub_mod._rate_windows.clear()
    hub_mod._pair_rate_windows.clear()
    yield
    hub_mod._rate_windows.clear()
    hub_mod._pair_rate_windows.clear()
