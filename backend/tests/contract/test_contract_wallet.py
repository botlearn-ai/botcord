"""Contract tests for wallet routes."""

import pytest

from .schema import (
    WALLET_LEDGER_RESPONSE,
    WALLET_SUMMARY,
    WITHDRAWAL_LIST_RESPONSE,
    assert_shape,
)

pytestmark = pytest.mark.contract


def test_wallet_summary(client, auth_headers):
    r = client.get("/api/wallet/summary", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), WALLET_SUMMARY)


def test_wallet_ledger(client, auth_headers):
    r = client.get("/api/wallet/ledger", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), WALLET_LEDGER_RESPONSE)


def test_wallet_withdrawals(client, auth_headers):
    r = client.get("/api/wallet/withdrawals", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), WITHDRAWAL_LIST_RESPONSE)


def test_wallet_summary_no_auth(client):
    r = client.get("/api/wallet/summary")
    assert r.status_code == 401
