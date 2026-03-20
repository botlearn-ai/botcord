"""Tests for Stripe topup integration."""

import base64
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.models import Base

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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
    monkeypatch.setattr(cfg, "STRIPE_SECRET_KEY", "sk_test_fake")
    monkeypatch.setattr(cfg, "STRIPE_WEBHOOK_SECRET", "whsec_test_fake")
    monkeypatch.setattr(cfg, "FRONTEND_BASE_URL", "https://app.test")
    monkeypatch.setattr(cfg, "STRIPE_TOPUP_PACKAGES", [
        {
            "package_code": "coin_500",
            "stripe_price_id": "price_test_500",
            "coin_amount_minor": "50000",
            "fiat_amount": "4.99",
        },
        {
            "package_code": "coin_1200",
            "stripe_price_id": "price_test_1200",
            "coin_amount_minor": "120000",
            "fiat_amount": "9.99",
        },
    ])

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_keypair():
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(client, sk, pubkey_str, name="agent"):
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
    claim_resp = await client.post(
        f"/registry/agents/{agent_id}/claim",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert claim_resp.status_code == 200
    return agent_id, token


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _mock_stripe_session(
    topup_id,
    session_id="cs_test_123",
    *,
    package_code="coin_500",
    coin_amount_minor="50000",
    quantity="1",
):
    """Create a mock Stripe Checkout Session object."""
    session = MagicMock()
    session.id = session_id
    session.url = f"https://checkout.stripe.com/c/pay/{session_id}"
    session.expires_at = 1742308496
    session.mode = "payment"
    session.payment_status = "paid"
    session.metadata = {
        "topup_id": topup_id,
        "agent_id": "ag_test",
        "package_code": package_code,
        "quantity": quantity,
        "coin_amount_minor": coin_amount_minor,
    }
    return session


# ---------------------------------------------------------------------------
# Tests: Create Checkout Session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_checkout_session(client):
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_new"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_new"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        resp = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={
                "package_code": "coin_500",
                "idempotency_key": str(uuid.uuid4()),
            },
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["topup_id"].startswith("tu_")
    assert data["checkout_session_id"] == "cs_test_new"
    assert data["checkout_url"].startswith("https://checkout.stripe.com/")
    assert data["status"] == "pending"


@pytest.mark.asyncio
async def test_create_checkout_session_with_quantity(client, db_session):
    """Quantity should scale both Stripe line items and local topup amount."""
    from sqlalchemy import select

    from hub.models import TopupRequest as TopupRequestModel

    sk, pubkey = _make_keypair()
    _, token = await _register_and_verify(client, sk, pubkey)

    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_qty"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_qty"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        resp = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={
                "package_code": "coin_500",
                "quantity": 3,
                "idempotency_key": str(uuid.uuid4()),
            },
        )

    assert resp.status_code == 201
    create_kwargs = mock_stripe.checkout.Session.create.call_args.kwargs
    assert create_kwargs["line_items"] == [{"price": "price_test_500", "quantity": 3}]
    assert create_kwargs["metadata"]["quantity"] == "3"
    assert create_kwargs["metadata"]["coin_amount_minor"] == "150000"

    result = await db_session.execute(
        select(TopupRequestModel).where(
            TopupRequestModel.topup_id == resp.json()["topup_id"]
        )
    )
    topup = result.scalar_one()
    assert topup.amount_minor == 150000


@pytest.mark.asyncio
async def test_create_checkout_session_unknown_package(client):
    sk, pubkey = _make_keypair()
    _, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups/stripe/checkout-session",
        headers=_auth(token),
        json={
            "package_code": "nonexistent",
            "idempotency_key": str(uuid.uuid4()),
        },
    )
    assert resp.status_code == 400
    assert "Unknown package_code" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_checkout_session_idempotency(client):
    """Same idempotency_key returns the same topup/session."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)
    idem_key = str(uuid.uuid4())

    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_idem"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_idem"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        resp1 = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={"package_code": "coin_500", "idempotency_key": idem_key},
        )
        resp2 = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={"package_code": "coin_500", "idempotency_key": idem_key},
        )

    assert resp1.status_code == 201
    assert resp2.status_code == 201
    assert resp1.json()["topup_id"] == resp2.json()["topup_id"]


@pytest.mark.asyncio
async def test_create_checkout_stripe_failure_marks_topup_failed(client, db_session):
    """If Stripe session creation fails, topup should be persisted as failed."""
    import stripe as stripe_lib
    from hub.models import TopupRequest as TopupRequestModel
    from hub.enums import TopupStatus

    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)
    idem_key = str(uuid.uuid4())

    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_stripe.StripeError = stripe_lib.StripeError
        mock_stripe.checkout.Session.create.side_effect = stripe_lib.StripeError(
            "Card declined"
        )

        resp = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={
                "package_code": "coin_500",
                "idempotency_key": idem_key,
            },
        )

    assert resp.status_code == 400
    assert "Stripe error" in resp.json()["detail"]

    # Verify the failed topup was actually persisted in the DB
    from sqlalchemy import select
    result = await db_session.execute(
        select(TopupRequestModel).where(
            TopupRequestModel.agent_id == agent_id,
            TopupRequestModel.channel == "stripe",
        )
    )
    topups = result.scalars().all()
    assert len(topups) == 1
    assert topups[0].status == TopupStatus.failed


@pytest.mark.asyncio
async def test_retry_after_failure_creates_new_topup(client):
    """Same idempotency_key should work after a failed attempt."""
    import stripe as stripe_lib

    sk, pubkey = _make_keypair()
    _, token = await _register_and_verify(client, sk, pubkey)
    idem_key = str(uuid.uuid4())

    # First attempt: Stripe fails
    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_stripe.StripeError = stripe_lib.StripeError
        mock_stripe.checkout.Session.create.side_effect = stripe_lib.StripeError(
            "Card declined"
        )
        resp1 = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={"package_code": "coin_500", "idempotency_key": idem_key},
        )
    assert resp1.status_code == 400

    # Second attempt: same key, Stripe succeeds this time
    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_retry"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_retry"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        resp2 = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={"package_code": "coin_500", "idempotency_key": idem_key},
        )

    assert resp2.status_code == 201
    data = resp2.json()
    assert data["checkout_session_id"] == "cs_test_retry"
    assert data["status"] == "pending"


# ---------------------------------------------------------------------------
# Tests: Webhook
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_webhook_completes_topup(client):
    """checkout.session.completed webhook should credit wallet."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    # Create a checkout session first
    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_wh"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_wh"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        resp = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={
                "package_code": "coin_500",
                "idempotency_key": str(uuid.uuid4()),
            },
        )
    assert resp.status_code == 201
    topup_id = resp.json()["topup_id"]

    # Simulate webhook
    webhook_payload = json.dumps({
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_wh",
                "mode": "payment",
                "payment_status": "paid",
                "metadata": {
                    "topup_id": topup_id,
                    "agent_id": agent_id,
                    "package_code": "coin_500",
                    "coin_amount_minor": "50000",
                },
            },
        },
    })

    with patch("hub.routers.stripe.stripe") as mock_stripe_router, \
         patch("hub.services.stripe_topup.stripe") as mock_stripe_svc:
        # Mock webhook signature verification
        mock_event = MagicMock()
        mock_event.type = "checkout.session.completed"
        mock_event.data.object = MagicMock()
        mock_event.data.object.id = "cs_test_wh"
        mock_stripe_router.Webhook.construct_event.return_value = mock_event
        mock_stripe_router.SignatureVerificationError = Exception

        # Mock fulfill's Stripe session retrieve
        fulfill_session = _mock_stripe_session(topup_id, "cs_test_wh")
        mock_stripe_svc.checkout.Session.retrieve.return_value = fulfill_session
        mock_stripe_svc.StripeError = Exception

        resp = await client.post(
            "/stripe/webhook",
            content=webhook_payload,
            headers={"stripe-signature": "t=123,v1=fakesig"},
        )

    assert resp.status_code == 200

    # Check wallet balance
    wallet_resp = await client.get("/wallet/me", headers=_auth(token))
    assert wallet_resp.status_code == 200
    assert wallet_resp.json()["available_balance_minor"] == "50000"


@pytest.mark.asyncio
async def test_webhook_duplicate_does_not_double_credit(client):
    """Duplicate webhooks should not credit wallet twice."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_dup"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_dup"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        resp = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={
                "package_code": "coin_500",
                "idempotency_key": str(uuid.uuid4()),
            },
        )
    topup_id = resp.json()["topup_id"]

    # Send webhook twice
    for _ in range(2):
        with patch("hub.routers.stripe.stripe") as mock_stripe_router, \
             patch("hub.services.stripe_topup.stripe") as mock_stripe_svc:
            mock_event = MagicMock()
            mock_event.type = "checkout.session.completed"
            mock_event.data.object = MagicMock()
            mock_event.data.object.id = "cs_test_dup"
            mock_stripe_router.Webhook.construct_event.return_value = mock_event
            mock_stripe_router.SignatureVerificationError = Exception

            fulfill_session = _mock_stripe_session(topup_id, "cs_test_dup")
            mock_stripe_svc.checkout.Session.retrieve.return_value = fulfill_session
            mock_stripe_svc.StripeError = Exception

            await client.post(
                "/stripe/webhook",
                content=b"{}",
                headers={"stripe-signature": "t=123,v1=fakesig"},
            )

    # Balance should only be credited once
    wallet_resp = await client.get("/wallet/me", headers=_auth(token))
    assert wallet_resp.json()["available_balance_minor"] == "50000"


# ---------------------------------------------------------------------------
# Tests: Session Status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_status_pending(client):
    """Session status returns pending before webhook arrives."""
    sk, pubkey = _make_keypair()
    _, token = await _register_and_verify(client, sk, pubkey)

    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_status"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_status"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={
                "package_code": "coin_500",
                "idempotency_key": str(uuid.uuid4()),
            },
        )

    # Query status — Stripe says not paid yet
    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        unpaid_session = MagicMock()
        unpaid_session.mode = "payment"
        unpaid_session.payment_status = "unpaid"
        unpaid_session.metadata = {"topup_id": "tu_whatever"}
        mock_stripe.checkout.Session.retrieve.return_value = unpaid_session
        mock_stripe.StripeError = Exception

        resp = await client.get(
            "/wallet/topups/stripe/session-status",
            headers=_auth(token),
            params={"session_id": "cs_test_status"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["topup_status"] == "pending"
    assert data["wallet_credited"] is False


@pytest.mark.asyncio
async def test_session_status_after_fulfillment(client):
    """Session status should show completed after webhook fulfillment."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_fulfilled"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_fulfilled"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        resp = await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token),
            json={
                "package_code": "coin_1200",
                "quantity": 2,
                "idempotency_key": str(uuid.uuid4()),
            },
        )
    topup_id = resp.json()["topup_id"]

    # Fulfill via session-status endpoint (compensation path)
    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        paid_session = _mock_stripe_session(
            topup_id,
            "cs_test_fulfilled",
            package_code="coin_1200",
            coin_amount_minor="240000",
            quantity="2",
        )
        mock_stripe.checkout.Session.retrieve.return_value = paid_session
        mock_stripe.StripeError = Exception

        resp = await client.get(
            "/wallet/topups/stripe/session-status",
            headers=_auth(token),
            params={"session_id": "cs_test_fulfilled"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["topup_status"] == "completed"
    assert data["wallet_credited"] is True
    assert data["amount_minor"] == "240000"

    # Verify wallet balance
    wallet_resp = await client.get("/wallet/me", headers=_auth(token))
    assert wallet_resp.json()["available_balance_minor"] == "240000"


@pytest.mark.asyncio
async def test_webhook_missing_signature(client):
    """Webhook without Stripe-Signature should return 400."""
    resp = await client.post(
        "/stripe/webhook",
        content=b"{}",
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_webhook_ignores_unknown_event(client):
    """Webhook should return 200 for unhandled event types."""
    with patch("hub.routers.stripe.stripe") as mock_stripe:
        mock_event = MagicMock()
        mock_event.type = "payment_intent.created"
        mock_stripe.Webhook.construct_event.return_value = mock_event
        mock_stripe.SignatureVerificationError = Exception

        resp = await client.post(
            "/stripe/webhook",
            content=b"{}",
            headers={"stripe-signature": "t=123,v1=fakesig"},
        )

    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# Tests: Packages endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_packages(client):
    """GET /wallet/topups/stripe/packages returns configured packages with fiat price."""
    resp = await client.get("/wallet/topups/stripe/packages")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["packages"]) == 2
    codes = {p["package_code"]: p for p in data["packages"]}
    assert "coin_500" in codes
    assert "coin_1200" in codes
    assert codes["coin_500"]["currency"] == "usd"
    assert codes["coin_500"]["fiat_amount"] == "4.99"
    assert codes["coin_1200"]["fiat_amount"] == "9.99"


# ---------------------------------------------------------------------------
# Tests: Session status ownership
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_status_rejects_other_agent(client):
    """Session status should reject queries from a different agent."""
    sk1, pubkey1 = _make_keypair()
    agent1_id, token1 = await _register_and_verify(client, sk1, pubkey1, name="agent1")

    sk2, pubkey2 = _make_keypair()
    agent2_id, token2 = await _register_and_verify(client, sk2, pubkey2, name="agent2")

    # Agent 1 creates a checkout session
    with patch("hub.services.stripe_topup.stripe") as mock_stripe:
        mock_session = MagicMock()
        mock_session.id = "cs_test_owner"
        mock_session.url = "https://checkout.stripe.com/c/pay/cs_test_owner"
        mock_session.expires_at = 1742308496
        mock_stripe.checkout.Session.create.return_value = mock_session

        await client.post(
            "/wallet/topups/stripe/checkout-session",
            headers=_auth(token1),
            json={
                "package_code": "coin_500",
                "idempotency_key": str(uuid.uuid4()),
            },
        )

    # Agent 2 tries to query agent 1's session
    resp = await client.get(
        "/wallet/topups/stripe/session-status",
        headers=_auth(token2),
        params={"session_id": "cs_test_owner"},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Webhook transient error returns 500
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_webhook_transient_error_returns_500(client):
    """Webhook should return 500 for transient fulfillment errors so Stripe retries."""
    from hub.services.stripe_topup import FulfillmentError

    with patch("hub.routers.stripe.stripe") as mock_stripe_router, \
         patch("hub.services.stripe_topup.stripe") as mock_stripe_svc, \
         patch("hub.services.stripe_topup.fulfill_stripe_checkout") as mock_fulfill:
        mock_event = MagicMock()
        mock_event.type = "checkout.session.completed"
        mock_event.data.object = MagicMock()
        mock_event.data.object.id = "cs_test_transient"
        mock_stripe_router.Webhook.construct_event.return_value = mock_event
        mock_stripe_router.SignatureVerificationError = Exception

        # Simulate a transient error (topup not found yet due to race)
        mock_fulfill.side_effect = FulfillmentError(
            "Topup tu_xxx not found", retryable=True
        )

        resp = await client.post(
            "/stripe/webhook",
            content=b"{}",
            headers={"stripe-signature": "t=123,v1=fakesig"},
        )

    assert resp.status_code == 500
