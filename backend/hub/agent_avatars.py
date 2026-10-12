import secrets

from hub.agent_avatar_legacy import LEGACY_AGENT_AVATAR_MAP

# VI v1.0 §6: 16 characters × 8 agent hues, served by the frontend as
# /agent-avatars/<character>-<hue>.svg. Keep in sync with
# frontend/src/lib/agent-avatars.ts and docs/brand/botcord-vi/scripts/avatars.py.
AGENT_AVATAR_CHARACTERS: tuple[str, ...] = (
    "robot", "alien", "ufo", "astronaut", "handheld", "slime", "octopus", "cat",
    "ghost", "jellyfish", "dinosaur", "bird", "chef", "wizard", "knight", "dj",
)
AGENT_AVATAR_HUES: tuple[str, ...] = (
    "coral", "amber", "lime", "green", "cyan", "blue", "violet", "pink",
)

AGENT_AVATAR_URLS: tuple[str, ...] = tuple(
    f"/agent-avatars/{character}-{hue}.svg"
    for character in AGENT_AVATAR_CHARACTERS
    for hue in AGENT_AVATAR_HUES
)


def random_agent_avatar_url() -> str:
    return secrets.choice(AGENT_AVATAR_URLS)


def normalize_agent_avatar_url(value: str | None) -> str | None:
    if value is None:
        return None
    avatar_url = value.strip()
    if not avatar_url:
        return None
    # Stale clients may still send a retired pixel avatar; map it forward.
    avatar_url = LEGACY_AGENT_AVATAR_MAP.get(avatar_url, avatar_url)
    if avatar_url not in AGENT_AVATAR_URLS:
        raise ValueError("avatar_url must be one of the built-in agent avatars")
    return avatar_url
