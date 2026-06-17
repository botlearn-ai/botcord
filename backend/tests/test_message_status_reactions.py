import pytest
from pydantic import ValidationError

from hub.schemas import MessageStatusReactionRequest
from hub.services import message_status_reactions


def test_request_schema_accepts_daemon_replying_ttl():
    # The daemon (botcord.ts REPLYING_STATUS_TTL_SEC) sends 1800s for the
    # "replying" backstop; the request schema must accept it or every
    # status-reaction call 422s and the ⏳ indicator never appears.
    req = MessageStatusReactionRequest(
        room_id="rm_1", turn_id="turn_1", ttl_sec=1800
    )
    assert req.ttl_sec == 1800
    assert req.ttl_sec <= message_status_reactions.MAX_STATUS_TTL_SECONDS

    with pytest.raises(ValidationError):
        MessageStatusReactionRequest(
            room_id="rm_1",
            turn_id="turn_1",
            ttl_sec=message_status_reactions.MAX_STATUS_TTL_SECONDS + 1,
        )


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.sets = {}
        self.ttls = {}

    async def set(self, key, value, ex=None):
        self.values[key] = value
        if ex is not None:
            self.ttls[key] = ex

    async def get(self, key):
        return self.values.get(key)

    async def delete(self, key):
        self.values.pop(key, None)

    async def sadd(self, key, *values):
        self.sets.setdefault(key, set()).update(values)

    async def srem(self, key, *values):
        current = self.sets.setdefault(key, set())
        for value in values:
            current.discard(value)

    async def smembers(self, key):
        return set(self.sets.get(key, set()))

    async def mget(self, keys):
        return [self.values.get(key) for key in keys]

    async def expire(self, key, ttl):
        self.ttls[key] = ttl


@pytest.mark.asyncio
async def test_status_reaction_set_load_and_clear(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(message_status_reactions, "get_redis", lambda: fake)

    payload = await message_status_reactions.set_status_reaction(
        room_id="rm_1",
        msg_id="msg_1",
        actor_id="ag_bot",
        actor_name="Bot",
        kind="replying",
        emoji="⏳",
        turn_id="turn_1",
        ttl_sec=60,
    )

    assert payload["state"] == "active"
    assert payload["expires_at"]

    loaded = await message_status_reactions.load_active_status_reactions("rm_1", ["msg_1"])
    assert loaded["msg_1"][0]["actor_id"] == "ag_bot"
    assert loaded["msg_1"][0]["turn_id"] == "turn_1"

    cleared = await message_status_reactions.clear_status_reaction(
        room_id="rm_1",
        msg_id="msg_1",
        actor_id="ag_bot",
        kind="replying",
        turn_id="turn_1",
    )
    assert cleared is not None
    assert cleared["state"] == "cleared"
    assert await message_status_reactions.load_active_status_reactions("rm_1", ["msg_1"]) == {}


@pytest.mark.asyncio
async def test_status_reaction_clear_ignores_stale_turn(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(message_status_reactions, "get_redis", lambda: fake)

    await message_status_reactions.set_status_reaction(
        room_id="rm_1",
        msg_id="msg_1",
        actor_id="ag_bot",
        actor_name="Bot",
        kind="replying",
        emoji="⏳",
        turn_id="turn_new",
        ttl_sec=60,
    )

    cleared = await message_status_reactions.clear_status_reaction(
        room_id="rm_1",
        msg_id="msg_1",
        actor_id="ag_bot",
        kind="replying",
        turn_id="turn_old",
    )

    assert cleared is None
    loaded = await message_status_reactions.load_active_status_reactions("rm_1", ["msg_1"])
    assert loaded["msg_1"][0]["turn_id"] == "turn_new"


@pytest.mark.asyncio
async def test_status_reaction_load_drops_missing_index_members(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(message_status_reactions, "get_redis", lambda: fake)
    await fake.sadd("message_status_reactions:room:rm_1", "missing_key")

    assert await message_status_reactions.load_active_status_reactions("rm_1", ["msg_1"]) == {}
    assert fake.sets["message_status_reactions:room:rm_1"] == set()
