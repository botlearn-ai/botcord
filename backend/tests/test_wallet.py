"""Comprehensive tests for the wallet / coin economy system."""

import asyncio
import base64
import uuid

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
    # Enable internal endpoints for testing
    import hub.config as cfg
    monkeypatch.setattr(cfg, "ALLOW_PRIVATE_ENDPOINTS", True)

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


def _make_keypair() -> tuple[SigningKey, str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(client: AsyncClient, sk: SigningKey, pubkey_str: str, name: str = "agent"):
    """Register, verify, return (agent_id, token)."""
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


async def _fund_agent(client: AsyncClient, agent_id: str, amount: int):
    """Create and complete a topup to give an agent funds."""
    # We need a token for the agent, but for topup we use internal endpoints.
    # First create topup via API (need agent's token) — but simpler: use internal directly.
    # Actually topup create needs auth. Let's do it via the service layer workaround
    # by creating topup with a dummy token. Instead, let's use the full flow.
    pass


# ---------------------------------------------------------------------------
# Tests: wallet creation on registration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wallet_created_on_verify(client: AsyncClient):
    """Wallet should be auto-created when agent is verified."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == agent_id
    assert data["asset_code"] == "COIN"
    assert data["available_balance_minor"] == "0"
    assert data["locked_balance_minor"] == "0"
    assert data["total_balance_minor"] == "0"


# ---------------------------------------------------------------------------
# Tests: topup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_topup_create_and_complete(client: AsyncClient):
    """Create a topup request, then complete it via internal endpoint."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    # Create topup
    resp = await client.post(
        "/wallet/topups",
        json={"amount_minor": "100000", "channel": "mock"},
        headers=_auth(token),
    )
    assert resp.status_code == 201
    topup_data = resp.json()
    assert topup_data["status"] == "pending"
    assert topup_data["amount_minor"] == "100000"
    topup_id = topup_data["topup_id"]

    # Complete via internal
    resp = await client.post(f"/internal/wallet/topups/{topup_id}/complete")
    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"

    # Check balance
    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["available_balance_minor"] == "100000"


@pytest.mark.asyncio
async def test_topup_fail(client: AsyncClient):
    """Create a topup, then fail it — balance should remain zero."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups",
        json={"amount_minor": "50000", "channel": "mock"},
        headers=_auth(token),
    )
    assert resp.status_code == 201
    topup_id = resp.json()["topup_id"]

    resp = await client.post(f"/internal/wallet/topups/{topup_id}/fail")
    assert resp.status_code == 200
    assert resp.json()["status"] == "failed"

    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["available_balance_minor"] == "0"


# ---------------------------------------------------------------------------
# Tests: transfer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transfer_normal(client: AsyncClient):
    """Normal transfer between two agents."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Fund Alice
    resp = await client.post(
        "/wallet/topups",
        json={"amount_minor": "100000"},
        headers=_auth(token_a),
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    # Transfer
    resp = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "30000", "memo": "test"},
        headers=_auth(token_a),
    )
    assert resp.status_code == 201
    tx = resp.json()
    assert tx["type"] == "transfer"
    assert tx["status"] == "completed"
    assert tx["amount_minor"] == "30000"

    # Check balances
    resp = await client.get("/wallet/me", headers=_auth(token_a))
    assert resp.json()["available_balance_minor"] == "70000"

    resp = await client.get("/wallet/me", headers=_auth(token_b))
    assert resp.json()["available_balance_minor"] == "30000"


@pytest.mark.asyncio
async def test_transfer_insufficient_balance(client: AsyncClient):
    """Transfer should fail if sender has insufficient balance."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    resp = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "1000"},
        headers=_auth(token_a),
    )
    assert resp.status_code == 400
    assert "Insufficient" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_transfer_self_rejected(client: AsyncClient):
    """Self-transfer should be rejected."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_id, "amount_minor": "1000"},
        headers=_auth(token),
    )
    assert resp.status_code == 400
    assert "yourself" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_transfer_idempotency(client: AsyncClient):
    """Duplicate idempotency_key should return the same transaction without double deduction."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Fund Alice
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "100000"}, headers=_auth(token_a)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    idem_key = str(uuid.uuid4())

    # First transfer
    resp1 = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "20000", "idempotency_key": idem_key},
        headers=_auth(token_a),
    )
    assert resp1.status_code == 201
    tx_id_1 = resp1.json()["tx_id"]

    # Second transfer with same key
    resp2 = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "20000", "idempotency_key": idem_key},
        headers=_auth(token_a),
    )
    assert resp2.status_code == 201
    tx_id_2 = resp2.json()["tx_id"]

    assert tx_id_1 == tx_id_2

    # Balance should only be deducted once
    resp = await client.get("/wallet/me", headers=_auth(token_a))
    assert resp.json()["available_balance_minor"] == "80000"


# ---------------------------------------------------------------------------
# Tests: withdrawal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_withdrawal_full_lifecycle(client: AsyncClient):
    """Create withdrawal, approve, complete — balance should be deducted."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    # Fund
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "100000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    # Create withdrawal
    resp = await client.post(
        "/wallet/withdrawals",
        json={"amount_minor": "30000", "destination_type": "mock_bank"},
        headers=_auth(token),
    )
    assert resp.status_code == 201
    wd_data = resp.json()
    assert wd_data["status"] == "pending"
    wd_id = wd_data["withdrawal_id"]

    # Balance should show locked
    resp = await client.get("/wallet/me", headers=_auth(token))
    data = resp.json()
    assert data["available_balance_minor"] == "70000"
    assert data["locked_balance_minor"] == "30000"

    # Approve
    resp = await client.post(f"/internal/wallet/withdrawals/{wd_id}/approve")
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"

    # Complete
    resp = await client.post(f"/internal/wallet/withdrawals/{wd_id}/complete")
    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"

    # Final balance
    resp = await client.get("/wallet/me", headers=_auth(token))
    data = resp.json()
    assert data["available_balance_minor"] == "70000"
    assert data["locked_balance_minor"] == "0"
    assert data["total_balance_minor"] == "70000"


@pytest.mark.asyncio
async def test_withdrawal_reject_unlocks(client: AsyncClient):
    """Rejecting a withdrawal should unlock balance."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    # Fund
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "50000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    # Create withdrawal
    resp = await client.post(
        "/wallet/withdrawals",
        json={"amount_minor": "20000"},
        headers=_auth(token),
    )
    wd_id = resp.json()["withdrawal_id"]

    # Reject
    resp = await client.post(
        f"/internal/wallet/withdrawals/{wd_id}/reject",
        json={"note": "not approved"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"

    # Balance should be restored
    resp = await client.get("/wallet/me", headers=_auth(token))
    data = resp.json()
    assert data["available_balance_minor"] == "50000"
    assert data["locked_balance_minor"] == "0"


@pytest.mark.asyncio
async def test_withdrawal_cancel(client: AsyncClient):
    """User can cancel a pending withdrawal to unlock balance."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    # Fund
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "50000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    # Create withdrawal
    resp = await client.post(
        "/wallet/withdrawals",
        json={"amount_minor": "15000"},
        headers=_auth(token),
    )
    wd_id = resp.json()["withdrawal_id"]

    # Cancel
    resp = await client.post(
        f"/wallet/withdrawals/{wd_id}/cancel",
        headers=_auth(token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"

    # Balance restored
    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["available_balance_minor"] == "50000"


# ---------------------------------------------------------------------------
# Tests: ledger
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ledger_entries_created(client: AsyncClient):
    """Ledger entries should be created for topup and transfer."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Fund Alice via topup
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "100000"}, headers=_auth(token_a)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    # Transfer
    await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "25000"},
        headers=_auth(token_a),
    )

    # Check Alice's ledger
    resp = await client.get("/wallet/ledger", headers=_auth(token_a))
    assert resp.status_code == 200
    data = resp.json()
    entries = data["entries"]
    # Should have: 1 credit (topup) + 1 debit (transfer) = 2 entries
    assert len(entries) == 2

    # Most recent first (transfer debit)
    assert entries[0]["direction"] == "debit"
    assert entries[0]["amount_minor"] == "25000"

    # Topup credit
    assert entries[1]["direction"] == "credit"
    assert entries[1]["amount_minor"] == "100000"


@pytest.mark.asyncio
async def test_ledger_pagination(client: AsyncClient):
    """Ledger pagination should work with cursor."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Fund Alice
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "500000"}, headers=_auth(token_a)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    # Make 3 transfers
    for i in range(3):
        await client.post(
            "/wallet/transfers",
            json={"to_agent_id": agent_b, "amount_minor": "10000"},
            headers=_auth(token_a),
        )

    # Alice has 4 entries: 1 topup credit + 3 transfer debits
    # Get with limit=2
    resp = await client.get("/wallet/ledger?limit=2", headers=_auth(token_a))
    data = resp.json()
    assert len(data["entries"]) == 2
    assert data["has_more"] is True
    cursor = data["next_cursor"]

    # Next page
    resp = await client.get(f"/wallet/ledger?limit=2&cursor={cursor}", headers=_auth(token_a))
    data = resp.json()
    assert len(data["entries"]) == 2
    assert data["has_more"] is False


# ---------------------------------------------------------------------------
# Tests: transaction detail
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_transaction(client: AsyncClient):
    """Can retrieve a specific transaction by tx_id."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Fund and transfer
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "100000"}, headers=_auth(token_a)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "5000"},
        headers=_auth(token_a),
    )
    tx_id = resp.json()["tx_id"]

    # Both sender and receiver can see it
    resp = await client.get(f"/wallet/transactions/{tx_id}", headers=_auth(token_a))
    assert resp.status_code == 200
    assert resp.json()["tx_id"] == tx_id

    resp = await client.get(f"/wallet/transactions/{tx_id}", headers=_auth(token_b))
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Tests: concurrent transfers don't overdraft
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_transfers_no_overdraft(client: AsyncClient):
    """Multiple transfers should not overdraft.

    We fire 10 transfers of 10000 each against a 50000 balance.
    Exactly 5 should succeed; the rest should fail with insufficient balance.

    NOTE: SQLite + shared in-memory session does not support true concurrent
    writes (no FOR UPDATE, single-writer), so we run serially here.
    On PostgreSQL with separate connections, use asyncio.gather for a true
    concurrency test — the FOR UPDATE lock ensures correctness.
    """
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Fund Alice with exactly 50000
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "50000"}, headers=_auth(token_a)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    # Try 10 transfers of 10000 each (total 100000 > 50000)
    # Serial execution: SQLite can't handle concurrent session writes.
    # The business logic correctness (balance check + deduct) is still validated.
    success_count = 0
    fail_count = 0
    for _ in range(10):
        resp = await client.post(
            "/wallet/transfers",
            json={"to_agent_id": agent_b, "amount_minor": "10000"},
            headers=_auth(token_a),
        )
        if resp.status_code == 201:
            success_count += 1
        else:
            fail_count += 1

    assert success_count == 5
    assert fail_count == 5

    # Final balance should be exactly 0
    resp = await client.get("/wallet/me", headers=_auth(token_a))
    assert resp.json()["available_balance_minor"] == "0"

    # Bob should have exactly 50000
    resp = await client.get("/wallet/me", headers=_auth(token_b))
    assert resp.json()["available_balance_minor"] == "50000"


# ---------------------------------------------------------------------------
# Tests: edge cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transfer_zero_amount_rejected(client: AsyncClient):
    """Transfer of zero or negative amount should be rejected."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, _ = await _register_and_verify(client, sk_b, pub_b, "Bob")

    resp = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "0"},
        headers=_auth(token_a),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_transfer_to_nonexistent_agent(client: AsyncClient):
    """Transfer to nonexistent agent should fail."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    # Fund
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "10000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": "ag_doesnotexist", "amount_minor": "5000"},
        headers=_auth(token),
    )
    assert resp.status_code == 400
    assert "not found" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_internal_endpoints_disabled_by_default(client: AsyncClient, monkeypatch):
    """Internal endpoints should be blocked when ALLOW_PRIVATE_ENDPOINTS is false."""
    import hub.config as cfg
    monkeypatch.setattr(cfg, "ALLOW_PRIVATE_ENDPOINTS", False)

    resp = await client.post("/internal/wallet/topups/tu_fake/complete")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_withdrawal_insufficient_balance(client: AsyncClient):
    """Withdrawal with insufficient balance should fail."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/withdrawals",
        json={"amount_minor": "10000"},
        headers=_auth(token),
    )
    assert resp.status_code == 400
    assert "Insufficient" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_withdrawal_negative_fee_rejected(client: AsyncClient):
    """Negative fee_minor should be rejected."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    # Fund agent
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "100000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(
        "/wallet/withdrawals",
        json={"amount_minor": "10000", "fee_minor": "-5000"},
        headers=_auth(token),
    )
    assert resp.status_code == 400
    assert "fee" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_idempotency_key_scoped_to_agent(client: AsyncClient):
    """Same idempotency_key from different agents should NOT collide."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    sk_c, pub_c = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")
    agent_c, token_c = await _register_and_verify(client, sk_c, pub_c, "Carol")

    # Fund both Alice and Bob
    for token in [token_a, token_b]:
        resp = await client.post(
            "/wallet/topups", json={"amount_minor": "100000"}, headers=_auth(token)
        )
        topup_id = resp.json()["topup_id"]
        await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    shared_key = "shared-idem-key-123"

    # Alice transfers to Carol with key
    resp_a = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_c, "amount_minor": "5000", "idempotency_key": shared_key},
        headers=_auth(token_a),
    )
    assert resp_a.status_code == 201

    # Bob transfers to Carol with same key — should succeed (different agent)
    resp_b = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_c, "amount_minor": "7000", "idempotency_key": shared_key},
        headers=_auth(token_b),
    )
    assert resp_b.status_code == 201

    # Different tx_ids
    assert resp_a.json()["tx_id"] != resp_b.json()["tx_id"]

    # Carol should have 12000
    resp = await client.get("/wallet/me", headers=_auth(token_c))
    assert resp.json()["available_balance_minor"] == "12000"


@pytest.mark.asyncio
async def test_internal_endpoints_require_secret_when_configured(client: AsyncClient, monkeypatch):
    """Internal endpoints should require INTERNAL_API_SECRET when it is set."""
    import hub.config as cfg
    monkeypatch.setattr(cfg, "INTERNAL_API_SECRET", "test-secret-123")

    # No header — should fail
    resp = await client.post("/internal/wallet/topups/tu_fake/complete")
    assert resp.status_code == 401

    # Wrong secret — should fail
    resp = await client.post(
        "/internal/wallet/topups/tu_fake/complete",
        headers={"Authorization": "Bearer wrong-secret"},
    )
    assert resp.status_code == 401

    # Correct secret — should pass auth (will fail on business logic, not auth)
    resp = await client.post(
        "/internal/wallet/topups/tu_fake/complete",
        headers={"Authorization": "Bearer test-secret-123"},
    )
    # 400 = passed auth guard, failed on "not found" which is fine
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Tests: state transition safety (double-complete, complete+fail, etc.)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_topup_double_complete_rejected(client: AsyncClient):
    """Completing an already-completed topup should fail with status error."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "10000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]

    # First complete succeeds
    resp = await client.post(f"/internal/wallet/topups/{topup_id}/complete")
    assert resp.status_code == 200

    # Second complete should fail — topup is no longer pending
    resp = await client.post(f"/internal/wallet/topups/{topup_id}/complete")
    assert resp.status_code == 400
    assert "not pending" in resp.json()["detail"].lower()

    # Balance should be credited only once
    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["available_balance_minor"] == "10000"


@pytest.mark.asyncio
async def test_topup_complete_then_fail_rejected(client: AsyncClient):
    """Failing an already-completed topup should be rejected."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "10000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]

    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(f"/internal/wallet/topups/{topup_id}/fail")
    assert resp.status_code == 400
    assert "not pending" in resp.json()["detail"].lower()

    # Balance intact
    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["available_balance_minor"] == "10000"


@pytest.mark.asyncio
async def test_topup_fail_then_complete_rejected(client: AsyncClient):
    """Completing an already-failed topup should be rejected."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "10000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]

    await client.post(f"/internal/wallet/topups/{topup_id}/fail")

    resp = await client.post(f"/internal/wallet/topups/{topup_id}/complete")
    assert resp.status_code == 400
    assert "not pending" in resp.json()["detail"].lower()

    # Balance remains zero
    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["available_balance_minor"] == "0"


@pytest.mark.asyncio
async def test_withdrawal_double_approve_rejected(client: AsyncClient):
    """Approving an already-approved withdrawal should fail."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "50000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(
        "/wallet/withdrawals", json={"amount_minor": "20000"}, headers=_auth(token)
    )
    wd_id = resp.json()["withdrawal_id"]

    # First approve succeeds
    resp = await client.post(f"/internal/wallet/withdrawals/{wd_id}/approve")
    assert resp.status_code == 200

    # Second approve fails
    resp = await client.post(f"/internal/wallet/withdrawals/{wd_id}/approve")
    assert resp.status_code == 400
    assert "not pending" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_withdrawal_approve_then_reject_rejected(client: AsyncClient):
    """Rejecting an approved withdrawal should fail (not pending)."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "50000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(
        "/wallet/withdrawals", json={"amount_minor": "20000"}, headers=_auth(token)
    )
    wd_id = resp.json()["withdrawal_id"]

    await client.post(f"/internal/wallet/withdrawals/{wd_id}/approve")

    # Reject should fail — status is 'approved', not 'pending'
    resp = await client.post(
        f"/internal/wallet/withdrawals/{wd_id}/reject",
        json={"note": "too late"},
    )
    assert resp.status_code == 400
    assert "not pending" in resp.json()["detail"].lower()

    # Locked balance should remain unchanged
    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["locked_balance_minor"] == "20000"


@pytest.mark.asyncio
async def test_withdrawal_cancel_after_approve_rejected(client: AsyncClient):
    """Cancelling an approved withdrawal should fail (not pending)."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "50000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(
        "/wallet/withdrawals", json={"amount_minor": "20000"}, headers=_auth(token)
    )
    wd_id = resp.json()["withdrawal_id"]

    await client.post(f"/internal/wallet/withdrawals/{wd_id}/approve")

    resp = await client.post(
        f"/wallet/withdrawals/{wd_id}/cancel", headers=_auth(token)
    )
    assert resp.status_code == 400
    assert "not pending" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_withdrawal_double_complete_rejected(client: AsyncClient):
    """Completing an already-completed withdrawal should fail."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "50000"}, headers=_auth(token)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await client.post(
        "/wallet/withdrawals", json={"amount_minor": "20000"}, headers=_auth(token)
    )
    wd_id = resp.json()["withdrawal_id"]

    await client.post(f"/internal/wallet/withdrawals/{wd_id}/approve")

    # First complete
    resp = await client.post(f"/internal/wallet/withdrawals/{wd_id}/complete")
    assert resp.status_code == 200

    # Second complete should fail
    resp = await client.post(f"/internal/wallet/withdrawals/{wd_id}/complete")
    assert resp.status_code == 400
    assert "not approved" in resp.json()["detail"].lower()

    # Balance correct — only deducted once
    resp = await client.get("/wallet/me", headers=_auth(token))
    assert resp.json()["available_balance_minor"] == "30000"
    assert resp.json()["locked_balance_minor"] == "0"


@pytest.mark.asyncio
async def test_transfer_idempotency_same_key_same_agent(client: AsyncClient):
    """Same idempotency key from same agent should return same tx (not 500)."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, _ = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Fund Alice
    resp = await client.post(
        "/wallet/topups", json={"amount_minor": "100000"}, headers=_auth(token_a)
    )
    topup_id = resp.json()["topup_id"]
    await client.post(f"/internal/wallet/topups/{topup_id}/complete")

    key = "test-idem-key-repeated"

    # First request
    resp1 = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "5000", "idempotency_key": key},
        headers=_auth(token_a),
    )
    assert resp1.status_code == 201

    # Second request — same key, should not be 500
    resp2 = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "5000", "idempotency_key": key},
        headers=_auth(token_a),
    )
    assert resp2.status_code == 201
    assert resp2.json()["tx_id"] == resp1.json()["tx_id"]

    # Third request — same key, should still work
    resp3 = await client.post(
        "/wallet/transfers",
        json={"to_agent_id": agent_b, "amount_minor": "5000", "idempotency_key": key},
        headers=_auth(token_a),
    )
    assert resp3.status_code == 201
    assert resp3.json()["tx_id"] == resp1.json()["tx_id"]

    # Balance only deducted once
    resp = await client.get("/wallet/me", headers=_auth(token_a))
    assert resp.json()["available_balance_minor"] == "95000"


@pytest.mark.asyncio
async def test_topup_idempotency(client: AsyncClient):
    """Same idempotency key for topup should return same result."""
    sk, pubkey = _make_keypair()
    agent_id, token = await _register_and_verify(client, sk, pubkey)

    key = "topup-idem-key-1"

    resp1 = await client.post(
        "/wallet/topups",
        json={"amount_minor": "10000", "idempotency_key": key},
        headers=_auth(token),
    )
    assert resp1.status_code == 201
    topup_id_1 = resp1.json()["topup_id"]

    resp2 = await client.post(
        "/wallet/topups",
        json={"amount_minor": "10000", "idempotency_key": key},
        headers=_auth(token),
    )
    assert resp2.status_code == 201
    topup_id_2 = resp2.json()["topup_id"]

    # Same topup returned
    assert topup_id_1 == topup_id_2
