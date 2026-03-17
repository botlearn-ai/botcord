from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.config import DATABASE_SCHEMA, DATABASE_URL

_connect_args: dict = {}
_execution_options: dict = {}
if DATABASE_SCHEMA:
    _connect_args["server_settings"] = {"search_path": f"{DATABASE_SCHEMA},public"}
    _execution_options["schema_translate_map"] = {None: DATABASE_SCHEMA}

engine = create_async_engine(
    DATABASE_URL, echo=False, connect_args=_connect_args,
    execution_options=_execution_options,
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncSession:  # type: ignore[misc]
    async with async_session() as session:
        yield session
