"""Focused tests for subscription products and recurring billing."""

import base64
import datetime

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.enums import SubscriptionChargeAttemptStatus, SubscriptionStatus
from hub.models import AgentSubscription, Base, SubscriptionChargeAttempt

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config as cfg

    monkeypatch.setattr(cfg, "ALLOW_PRIVATE_ENDPOINTS", True)

    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


def _make_keypair() -> tuple[SigningKey, str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(
    client: AsyncClient,
    sk: SigningKey,
    pubkey_str: str,
    name: str = "agent",
):
    resp = await client.post(
        "/registry/agents",
        json={"display_name": name, "pubkey": pubkey_str, "bio": "test"},
    )
    assert resp.status_code == 201
    data = resp.json()
    agent_id = data["agent_id"]
    key_id = data["key_id"]
    challenge = data["challenge"]

    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk.sign(challenge_bytes).signature).decode()

    resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    assert resp.status_code == 200
    token = resp.json()["agent_token"]
    return agent_id, token


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _utc(dt: datetime.datetime) -> datetime.datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc)


async def _fund_agent(client: AsyncClient, token: str, amount_minor: int):
    resp = await client.post(
        "/wallet/topups",
        json={"amount_minor": str(amount_minor), "channel": "mock"},
        headers=_auth(token),
    )
    assert resp.status_code == 201
    topup_id = resp.json()["topup_id"]
    resp = await client.post(f"/internal/wallet/topups/{topup_id}/complete")
    assert resp.status_code == 200


async def _set_open_policy(client: AsyncClient, agent_id: str, token: str):
    resp = await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth(token),
    )
    assert resp.status_code == 200


async def _set_subscription_room_policy(
    client: AsyncClient,
    agent_id: str,
    *,
    allowed_to_create: bool,
    max_active_rooms: int,
    note: str | None = None,
):
    payload = {
        "allowed_to_create": allowed_to_create,
        "max_active_rooms": max_active_rooms,
        "note": note,
    }
    resp = await client.put(
        f"/internal/rooms/subscription-room-policies/{agent_id}",
        json=payload,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _create_product(
    client: AsyncClient,
    token: str,
    *,
    name: str,
    amount_minor: int,
    billing_interval: str,
    description: str = "",
):
    resp = await client.post(
        "/subscriptions/products",
        json={
            "name": name,
            "description": description,
            "amount_minor": str(amount_minor),
            "billing_interval": billing_interval,
        },
        headers=_auth(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _subscribe(client: AsyncClient, token: str, product_id: str, key: str | None = None):
    payload = {}
    if key:
        payload["idempotency_key"] = key
    resp = await client.post(
        f"/subscriptions/products/{product_id}/subscribe",
        json=payload,
        headers=_auth(token),
    )
    return resp


async def _create_room(
    client: AsyncClient,
    token: str,
    *,
    name: str,
    required_subscription_product_id: str | None = None,
):
    payload = {"name": name}
    if required_subscription_product_id is not None:
        payload["required_subscription_product_id"] = required_subscription_product_id
    resp = await client.post(
        "/hub/rooms",
        json=payload,
        headers=_auth(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _set_subscription_due(
    db_session: AsyncSession,
    subscription_id: str,
    due_at: datetime.datetime,
    period_end: datetime.datetime | None = None,
):
    result = await db_session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    sub = result.scalar_one()
    sub.next_charge_at = due_at
    if period_end is not None:
        sub.current_period_end = period_end
    await db_session.commit()


@pytest.mark.asyncio
async def test_create_product_and_list(client: AsyncClient):
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey, "Provider")

    product = await _create_product(
        client,
        token,
        name="Weekly Advice",
        description="1 week access",
        amount_minor=10000,
        billing_interval="week",
    )
    assert product["owner_agent_id"] == agent_id
    assert product["status"] == "active"
    assert product["billing_interval"] == "week"

    resp = await client.get("/subscriptions/products")
    assert resp.status_code == 200
    assert len(resp.json()["products"]) == 1

    resp = await client.get("/subscriptions/products/me", headers=_auth(token))
    assert resp.status_code == 200
    assert resp.json()["products"][0]["product_id"] == product["product_id"]


@pytest.mark.asyncio
async def test_subscribe_charges_first_period_immediately(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    subscriber_id, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Weekly Club",
        amount_minor=10000,
        billing_interval="week",
    )

    await _fund_agent(client, subscriber_token, 20000)

    resp = await _subscribe(client, subscriber_token, product["product_id"], key="sub-key-1")
    assert resp.status_code == 201, resp.text
    subscription = resp.json()
    assert subscription["subscriber_agent_id"] == subscriber_id
    assert subscription["provider_agent_id"] == provider_id
    assert subscription["status"] == "active"
    assert subscription["amount_minor"] == "10000"
    assert subscription["last_charge_tx_id"]

    resp = await client.get("/wallet/me", headers=_auth(subscriber_token))
    assert resp.json()["available_balance_minor"] == "10000"

    resp = await client.get("/wallet/me", headers=_auth(provider_token))
    assert resp.json()["available_balance_minor"] == "10000"

    resp = await client.get(
        f"/wallet/transactions/{subscription['last_charge_tx_id']}",
        headers=_auth(subscriber_token),
    )
    assert resp.status_code == 200
    tx = resp.json()
    assert tx["type"] == "transfer"
    assert tx["reference_type"] == "subscription_charge"
    assert tx["reference_id"] == subscription["subscription_id"]
    assert tx["metadata_json"]


@pytest.mark.asyncio
async def test_subscribe_insufficient_balance(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    _, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    _, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Monthly Club",
        amount_minor=10000,
        billing_interval="month",
    )

    resp = await _subscribe(client, subscriber_token, product["product_id"])
    assert resp.status_code == 400
    assert "Insufficient balance" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_recurring_billing_success(client: AsyncClient, db_session: AsyncSession):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    _, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    _, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Weekly Billing",
        amount_minor=5000,
        billing_interval="week",
    )
    await _fund_agent(client, subscriber_token, 20000)

    resp = await _subscribe(client, subscriber_token, product["product_id"])
    subscription_id = resp.json()["subscription_id"]

    result = await db_session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    sub = result.scalar_one()
    due_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
    await _set_subscription_due(db_session, subscription_id, due_at, due_at)

    resp = await client.post("/internal/subscriptions/run-billing")
    assert resp.status_code == 200, resp.text
    assert resp.json()["charged_count"] == 1

    result = await db_session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    sub = result.scalar_one()
    assert sub.status == SubscriptionStatus.active
    assert sub.consecutive_failed_attempts == 0
    assert sub.next_charge_at > due_at
    assert sub.current_period_end > due_at

    result = await db_session.execute(
        select(SubscriptionChargeAttempt).where(
            SubscriptionChargeAttempt.subscription_id == subscription_id
        )
    )
    attempt = result.scalar_one()
    assert attempt.status == SubscriptionChargeAttemptStatus.succeeded


@pytest.mark.asyncio
async def test_recurring_billing_failure_moves_to_past_due(
    client: AsyncClient, db_session: AsyncSession
):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    _, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    _, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Weekly Billing Fail",
        amount_minor=5000,
        billing_interval="week",
    )
    await _fund_agent(client, subscriber_token, 5000)

    resp = await _subscribe(client, subscriber_token, product["product_id"])
    subscription_id = resp.json()["subscription_id"]

    due_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
    await _set_subscription_due(db_session, subscription_id, due_at, due_at)

    resp = await client.post("/internal/subscriptions/run-billing")
    assert resp.status_code == 200, resp.text
    assert resp.json()["failed_count"] == 1

    result = await db_session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    sub = result.scalar_one()
    assert sub.status == SubscriptionStatus.past_due
    assert sub.consecutive_failed_attempts == 1
    assert _utc(sub.next_charge_at) > datetime.datetime.now(datetime.timezone.utc)


@pytest.mark.asyncio
async def test_auto_cancel_after_three_failed_attempts(
    client: AsyncClient, db_session: AsyncSession
):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    _, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    _, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Weekly Billing Auto Cancel",
        amount_minor=5000,
        billing_interval="week",
    )
    await _fund_agent(client, subscriber_token, 5000)

    resp = await _subscribe(client, subscriber_token, product["product_id"])
    subscription_id = resp.json()["subscription_id"]

    for _ in range(3):
        due_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
        await _set_subscription_due(db_session, subscription_id, due_at, due_at)
        resp = await client.post("/internal/subscriptions/run-billing")
        assert resp.status_code == 200, resp.text

    result = await db_session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    sub = result.scalar_one()
    assert sub.status == SubscriptionStatus.cancelled
    assert sub.consecutive_failed_attempts == 3


@pytest.mark.asyncio
async def test_duplicate_billing_cycle_processing_is_idempotent(
    client: AsyncClient, db_session: AsyncSession
):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    _, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    _, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Weekly Billing Idempotent",
        amount_minor=5000,
        billing_interval="week",
    )
    await _fund_agent(client, subscriber_token, 20000)

    resp = await _subscribe(client, subscriber_token, product["product_id"])
    subscription_id = resp.json()["subscription_id"]

    result = await db_session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    sub = result.scalar_one()
    due_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
    await _set_subscription_due(db_session, subscription_id, due_at, due_at)

    resp = await client.post("/internal/subscriptions/run-billing")
    assert resp.status_code == 200, resp.text
    wallet_after_first = await client.get("/wallet/me", headers=_auth(subscriber_token))
    first_available = wallet_after_first.json()["available_balance_minor"]

    await _set_subscription_due(db_session, subscription_id, due_at, due_at)

    resp = await client.post("/internal/subscriptions/run-billing")
    assert resp.status_code == 200, resp.text
    assert resp.json()["skipped_count"] == 1

    wallet_after_second = await client.get("/wallet/me", headers=_auth(subscriber_token))
    assert wallet_after_second.json()["available_balance_minor"] == first_available


@pytest.mark.asyncio
async def test_archived_product_blocks_new_subscribe(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    _, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    _, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="One Shot Product",
        amount_minor=5000,
        billing_interval="week",
    )

    resp = await client.post(
        f"/subscriptions/products/{product['product_id']}/archive",
        headers=_auth(provider_token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "archived"

    await _fund_agent(client, subscriber_token, 10000)
    resp = await _subscribe(client, subscriber_token, product["product_id"])
    assert resp.status_code == 400
    assert "archived" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_subscribe_auto_joins_bound_private_room(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    subscriber_id, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Premium Room Access",
        amount_minor=10000,
        billing_interval="week",
    )
    await _set_subscription_room_policy(
        client, provider_id, allowed_to_create=True, max_active_rooms=5
    )
    room = await _create_room(
        client,
        provider_token,
        name="Premium Room",
        required_subscription_product_id=product["product_id"],
    )

    await _fund_agent(client, subscriber_token, 20000)
    resp = await _subscribe(client, subscriber_token, product["product_id"])
    assert resp.status_code == 201, resp.text

    resp = await client.get(f"/hub/rooms/{room['room_id']}", headers=_auth(subscriber_token))
    assert resp.status_code == 200, resp.text
    member_ids = {member["agent_id"] for member in resp.json()["members"]}
    assert member_ids == {provider_id, subscriber_id}
    assert resp.json()["required_subscription_product_id"] == product["product_id"]


@pytest.mark.asyncio
async def test_cancel_subscription_revokes_gated_room_access(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    _, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Cancelable Room Access",
        amount_minor=10000,
        billing_interval="week",
    )
    await _set_subscription_room_policy(
        client, provider_id, allowed_to_create=True, max_active_rooms=5
    )
    room = await _create_room(
        client,
        provider_token,
        name="Cancelable Premium Room",
        required_subscription_product_id=product["product_id"],
    )

    await _fund_agent(client, subscriber_token, 20000)
    resp = await _subscribe(client, subscriber_token, product["product_id"])
    assert resp.status_code == 201, resp.text
    subscription_id = resp.json()["subscription_id"]

    resp = await client.post(
        f"/subscriptions/{subscription_id}/cancel",
        headers=_auth(subscriber_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"

    resp = await client.get(f"/hub/rooms/{room['room_id']}", headers=_auth(subscriber_token))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_subscription_gated_room_blocks_unsubscribed_invite(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    subscriber_id, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")
    await _set_open_policy(client, subscriber_id, subscriber_token)

    product = await _create_product(
        client,
        provider_token,
        name="Invite Gated Access",
        amount_minor=5000,
        billing_interval="week",
    )
    await _set_subscription_room_policy(
        client, provider_id, allowed_to_create=True, max_active_rooms=5
    )
    room = await _create_room(
        client,
        provider_token,
        name="Invite Gated Room",
        required_subscription_product_id=product["product_id"],
    )

    resp = await client.post(
        f"/hub/rooms/{room['room_id']}/members",
        json={"agent_id": subscriber_id},
        headers=_auth(provider_token),
    )
    assert resp.status_code == 403
    assert "Active subscription required" in resp.json()["detail"]

    await _fund_agent(client, subscriber_token, 10000)
    resp = await _subscribe(client, subscriber_token, product["product_id"])
    assert resp.status_code == 201, resp.text

    resp = await client.get(f"/hub/rooms/{room['room_id']}", headers=_auth(subscriber_token))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_update_room_rejects_enabling_subscription_gate_with_unsubscribed_members(
    client: AsyncClient,
):
    sk_provider, pub_provider = _make_keypair()
    sk_member, pub_member = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    member_id, member_token = await _register_and_verify(client, sk_member, pub_member, "Member")
    await _set_open_policy(client, member_id, member_token)

    product = await _create_product(
        client,
        provider_token,
        name="Retroactive Gate",
        amount_minor=5000,
        billing_interval="week",
    )
    await _set_subscription_room_policy(
        client, provider_id, allowed_to_create=True, max_active_rooms=5
    )
    room = await _create_room(
        client,
        provider_token,
        name="Initially Open Access Room",
    )

    resp = await client.post(
        f"/hub/rooms/{room['room_id']}/members",
        json={"agent_id": member_id},
        headers=_auth(provider_token),
    )
    assert resp.status_code == 201, resp.text

    resp = await client.patch(
        f"/hub/rooms/{room['room_id']}",
        json={"required_subscription_product_id": product["product_id"]},
        headers=_auth(provider_token),
    )
    assert resp.status_code == 400, resp.text
    assert "All existing members must have an active subscription" in resp.json()["detail"]

    resp = await client.get(f"/hub/rooms/{room['room_id']}", headers=_auth(member_token))
    assert resp.status_code == 200, resp.text
    assert resp.json()["required_subscription_product_id"] is None


@pytest.mark.asyncio
async def test_gated_room_transfer_ownership_requires_product_owner(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_subscriber, pub_subscriber = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    subscriber_id, subscriber_token = await _register_and_verify(client, sk_subscriber, pub_subscriber, "Subscriber")

    product = await _create_product(
        client,
        provider_token,
        name="Transfer Scoped Product",
        amount_minor=5000,
        billing_interval="week",
    )
    await _set_subscription_room_policy(
        client, provider_id, allowed_to_create=True, max_active_rooms=5
    )
    room = await _create_room(
        client,
        provider_token,
        name="Transfer Gated Room",
        required_subscription_product_id=product["product_id"],
    )

    await _fund_agent(client, subscriber_token, 10000)
    resp = await _subscribe(client, subscriber_token, product["product_id"])
    assert resp.status_code == 201, resp.text

    resp = await client.post(
        f"/hub/rooms/{room['room_id']}/transfer",
        json={"new_owner_id": subscriber_id},
        headers=_auth(provider_token),
    )
    assert resp.status_code == 403
    assert "must own" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_room_owner_must_own_required_subscription_product(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    sk_other, pub_other = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")
    other_id, other_token = await _register_and_verify(client, sk_other, pub_other, "Other")

    product = await _create_product(
        client,
        provider_token,
        name="Owner Scoped Product",
        amount_minor=5000,
        billing_interval="week",
    )
    await _set_subscription_room_policy(
        client, provider_id, allowed_to_create=True, max_active_rooms=5
    )
    await _set_subscription_room_policy(
        client, other_id, allowed_to_create=True, max_active_rooms=5
    )

    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "Bad Room",
            "required_subscription_product_id": product["product_id"],
        },
        headers=_auth(other_token),
    )
    assert resp.status_code == 403
    assert "must own" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_internal_subscription_room_policy_upsert_and_list(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    provider_id, _provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")

    resp = await client.put(
        f"/internal/rooms/subscription-room-policies/{provider_id}",
        json={
            "allowed_to_create": True,
            "max_active_rooms": 3,
            "note": "pilot allowlist",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["agent_id"] == provider_id
    assert resp.json()["allowed_to_create"] is True
    assert resp.json()["max_active_rooms"] == 3

    resp = await client.get(f"/internal/rooms/subscription-room-policies/{provider_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["note"] == "pilot allowlist"

    resp = await client.get("/internal/rooms/subscription-room-policies")
    assert resp.status_code == 200, resp.text
    assert any(policy["agent_id"] == provider_id for policy in resp.json()["policies"])


@pytest.mark.skip(reason="Creator-policy whitelist check temporarily disabled (commit 574f96630)")
@pytest.mark.asyncio
async def test_subscription_gated_room_requires_creator_policy(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")

    product = await _create_product(
        client,
        provider_token,
        name="Policy Required Product",
        amount_minor=5000,
        billing_interval="week",
    )

    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "Blocked Premium Room",
            "required_subscription_product_id": product["product_id"],
        },
        headers=_auth(provider_token),
    )
    assert resp.status_code == 403
    assert "not allowed" in resp.json()["detail"]


@pytest.mark.skip(reason="Creator-policy whitelist check temporarily disabled (commit 574f96630)")
@pytest.mark.asyncio
async def test_update_room_to_subscription_gate_requires_creator_policy(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")

    product = await _create_product(
        client,
        provider_token,
        name="Policy Required Update Product",
        amount_minor=5000,
        billing_interval="week",
    )
    room = await _create_room(
        client,
        provider_token,
        name="Plain Private Room",
    )

    resp = await client.patch(
        f"/hub/rooms/{room['room_id']}",
        json={"required_subscription_product_id": product["product_id"]},
        headers=_auth(provider_token),
    )
    assert resp.status_code == 403
    assert "not allowed" in resp.json()["detail"]


@pytest.mark.skip(reason="Creator-policy quota check temporarily disabled (commit 574f96630)")
@pytest.mark.asyncio
async def test_subscription_gated_room_quota_enforced(client: AsyncClient):
    sk_provider, pub_provider = _make_keypair()
    provider_id, provider_token = await _register_and_verify(client, sk_provider, pub_provider, "Provider")

    product = await _create_product(
        client,
        provider_token,
        name="Quota Product",
        amount_minor=5000,
        billing_interval="week",
    )
    await _set_subscription_room_policy(
        client, provider_id, allowed_to_create=True, max_active_rooms=1
    )

    room_one = await _create_room(
        client,
        provider_token,
        name="First Gated Room",
        required_subscription_product_id=product["product_id"],
    )
    assert room_one["required_subscription_product_id"] == product["product_id"]

    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "Second Gated Room",
            "required_subscription_product_id": product["product_id"],
        },
        headers=_auth(provider_token),
    )
    assert resp.status_code == 403
    assert "quota exceeded" in resp.json()["detail"]
