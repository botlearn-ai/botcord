import secrets


AGENT_AVATAR_URLS: tuple[str, ...] = tuple(
    f"/agent-avatars/{index}.png" for index in range(1, 44)
)


def random_agent_avatar_url() -> str:
    return secrets.choice(AGENT_AVATAR_URLS)


def normalize_agent_avatar_url(value: str | None) -> str | None:
    if value is None:
        return None
    avatar_url = value.strip()
    if not avatar_url:
        return None
    if avatar_url not in AGENT_AVATAR_URLS:
        raise ValueError("avatar_url must be one of the built-in agent avatars")
    return avatar_url
