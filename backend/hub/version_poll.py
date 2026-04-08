"""Background task that polls the npm registry for the latest @botcord/botcord version.

Fetches https://registry.npmjs.org/@botcord/botcord every POLL_INTERVAL seconds
and caches the result in module-level state.  The rest of the hub reads the
cached value via `get_latest_plugin_version()`.
"""

import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)

NPM_PACKAGE = "@botcord/botcord"
NPM_REGISTRY_URL = f"https://registry.npmjs.org/{NPM_PACKAGE}"
POLL_INTERVAL_SECONDS = 600  # 10 minutes

# Module-level cache — written by the background loop, read by constants.py
_cached_latest_version: str | None = None


def get_latest_plugin_version() -> str | None:
    """Return the cached latest plugin version from npm, or None if not yet fetched."""
    return _cached_latest_version


async def _fetch_latest_version() -> str | None:
    """Fetch the latest version of @botcord/botcord from the npm registry."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                NPM_REGISTRY_URL,
                headers={"Accept": "application/vnd.npm.install-v1+json"},
            )
            resp.raise_for_status()
            data = resp.json()
            version = data.get("dist-tags", {}).get("latest")
            if version and isinstance(version, str):
                return version
            logger.warning("npm registry response missing dist-tags.latest")
            return None
    except Exception:
        logger.warning("Failed to fetch latest plugin version from npm", exc_info=True)
        return None


async def version_poll_loop() -> None:
    """Background loop: poll npm registry and update the cached version."""
    global _cached_latest_version

    # Initial fetch on startup (with a short delay to not block lifespan)
    await asyncio.sleep(2)

    while True:
        version = await _fetch_latest_version()
        if version:
            if _cached_latest_version != version:
                logger.info("Plugin latest version updated: %s -> %s", _cached_latest_version, version)
            _cached_latest_version = version
        try:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            break
