from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.exc import DBAPIError

from hub.services.conversation_capture import _matching_search_path
from hub.services.schema_startup import prepare_schema


def test_search_path_identifier_semantics():
    assert _matching_search_path(['search_path="public", public'], 'public,public')
    assert _matching_search_path(['search_path="$user", public'], '"$user",public')
    assert not _matching_search_path(['search_path="Other",public'], 'other,public')
    assert not _matching_search_path(['search_path="a b",public'], 'ab,public')
    assert not _matching_search_path(['search_path=public', 'row_security=off'], 'public')


@pytest.mark.asyncio
@pytest.mark.parametrize('state,expected_attempts', [('40P01', 3), ('40001', 3), ('55P03', 3), ('42501', 1)])
async def test_retry_is_bounded_and_permission_errors_are_not_retried(monkeypatch, state, expected_attempts):
    attempts = []
    transactions = []
    error = DBAPIError('test', None, SimpleNamespace(sqlstate=state))
    class Engine:
        sync_engine = SimpleNamespace(_conversation_capture_installed=True)
        @asynccontextmanager
        async def begin(self):
            attempts.append(1)
            try:
                yield SimpleNamespace(dialect=SimpleNamespace(name='postgresql'),
                                      execute=AsyncMock(), run_sync=AsyncMock(side_effect=error))
            finally:
                transactions.append('closed')
    async def sleep(delay):
        assert len(transactions) == len(attempts), 'must exit failed transaction before retry'
    monkeypatch.setattr('hub.services.schema_startup.asyncio.sleep', sleep)
    engine = Engine()
    with pytest.raises(DBAPIError):
        await prepare_schema(engine, SimpleNamespace(create_all=lambda: None))
    assert len(attempts) == expected_attempts
    assert not engine.sync_engine._conversation_capture_installed
