"""Contract tests for subscription routes."""

import pytest

from .schema import (
    MY_SUBSCRIPTIONS_RESPONSE,
    SUBSCRIPTION_PRODUCTS_RESPONSE,
    assert_shape,
)

pytestmark = pytest.mark.contract


def test_list_products(client):
    r = client.get("/api/subscriptions/products")
    assert r.status_code == 200
    assert_shape(r.json(), SUBSCRIPTION_PRODUCTS_RESPONSE)


def test_my_subscriptions(client, auth_headers):
    r = client.get("/api/subscriptions/me", headers=auth_headers)
    assert r.status_code == 200
    assert_shape(r.json(), MY_SUBSCRIPTIONS_RESPONSE)
