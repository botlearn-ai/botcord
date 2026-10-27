"""Database-level outbox capture, including bulk SQL and non-ORM writers.

The outbox row is updated (not DO NOTHING) so concurrent projection/delete and
write transactions cannot lose an invalidation. Projection tables never trigger
capture. PostgreSQL functions pin their search path to the installing schema.
"""
import re

from sqlalchemy import event, text


def capture_statements(dialect: str, *, user_table: str = '"public"."users"', suffix: str = "") -> list[str]:
    statements = []
    sources = {
        "rooms": ["room_id", "name", "description", "rule", "owner_id", "owner_type", "visibility", "join_policy", "required_subscription_product_id", "max_members", "default_send", "default_invite", "allow_human_send", "slow_mode_seconds", "space_id"],
        "room_members": ["room_id", "agent_id", "role", "can_invite", "can_send", "last_viewed_at", "participant_type"],
        "message_records": ["room_id", "msg_id", "sender_id", "created_at", "envelope_json", "recalled_at"],
        "agents": ["agent_id", "user_id", "display_name", "avatar_url"],
        "users": ["human_id", "display_name", "avatar_url"],
    }
    for table, columns in sources.items():
        target = user_table if table == "users" else table
        for operation, refs in [("INSERT", ["NEW"]), ("UPDATE", ["OLD", "NEW"]), ("DELETE", ["OLD"])]:
            name = f"conversation_{table}_{operation.lower()}{suffix}"
            queries = []
            for ref in refs:
                if table in ("rooms", "room_members", "message_records"):
                    query = f"SELECT {ref}.room_id AS room_id WHERE {ref}.room_id IS NOT NULL"
                    if table == "message_records":
                        expression = f"({ref}.envelope_json::jsonb ->> 'type')" if dialect == "postgresql" else f"json_extract(CASE WHEN json_valid({ref}.envelope_json) THEN {ref}.envelope_json ELSE '{{}}' END, '$.type')"
                        query += f" AND COALESCE({expression}, 'message') IN ('message', 'system')"
                else:
                    pid = f"{ref}.human_id" if table == "users" else f"{ref}.agent_id"
                    query = f"SELECT room_id FROM room_members WHERE agent_id = {pid} UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = {pid}"
                    if table == "users":
                        query += f" UNION SELECT room_id FROM conversation_entries WHERE user_id = {ref}.id"
                queries.append(query)
            # WHERE disambiguates SQLite's INSERT SELECT ... ON CONFLICT parser.
            union = " UNION ".join(queries)
            xid = "txid_current()::text" if dialect == "postgresql" else "NULL"
            body = f"INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, {xid} FROM ({union}) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid;"
            if operation == "UPDATE":
                if dialect == "postgresql":
                    condition = " OR ".join(f"OLD.{c} IS DISTINCT FROM NEW.{c}" for c in columns)
                else:
                    condition = " OR ".join(f"OLD.{c} IS NOT NEW.{c}" for c in columns)
            else:
                condition = "TRUE"
            if dialect == "postgresql":
                statements += [
                    f"CREATE OR REPLACE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF {condition} THEN {body} END IF; RETURN NULL; END; $capture$",
                    f"DROP TRIGGER IF EXISTS {name} ON {target}",
                    f"CREATE TRIGGER {name} AFTER {operation} ON {target} FOR EACH ROW EXECUTE FUNCTION {name}()",
                ]
            else:
                statements.append(f"CREATE TRIGGER IF NOT EXISTS {name} AFTER {operation} ON {target} WHEN {condition} BEGIN {body} END")
    if dialect == "postgresql":
        # These account summaries contain private message previews. They are
        # served only through the authenticated Hub, never Supabase table APIs.
        for table in ("conversation_dirty_rooms", "conversation_accounts", "conversation_entries", "conversation_changes"):
            statements.append(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    return statements


def _search_path_items(value):
    # PostgreSQL identifiers: ignore whitespace outside quotes, preserve quoted
    # case and escaped quotes. Do not erase whitespace *inside* an identifier.
    token = r'\s*(?:"((?:[^"]|"")*)"|([^,\s"]+))\s*(?:,|$)'
    items = []
    offset = 0
    while offset < len(value):
        match = re.match(token, value[offset:])
        if not match:
            return None
        quoted, unquoted = match.groups()
        items.append(quoted.replace('""', '"') if quoted is not None else unquoted.lower())
        offset += match.end()
    return items


def _matching_search_path(config, expected):
    if not config or len(config) != 1 or not config[0].startswith("search_path="):
        return False
    actual = _search_path_items(config[0].partition("=")[2])
    return actual is not None and actual == _search_path_items(expected)


def _validate_postgres_capture(connection, schema, user_schema, suffix):
    """Check the installed migration without acquiring business-table DDL locks."""
    functions = {}
    for statement in capture_statements("postgresql", suffix=suffix):
        if statement.startswith("CREATE OR REPLACE FUNCTION "):
            functions[statement.split()[4].removesuffix("()")] = statement.split("$capture$")[1]
    rows = connection.execute(text("""
        SELECT n.nspname, c.relname, t.tgname, t.tgtype, t.tgenabled::text AS tgenabled,
               p.proname, pn.nspname AS function_schema, p.prosrc,
               t.tgqual IS NULL AS unconditional, t.tgnargs, p.proconfig,
               (p.prorettype = 'trigger'::regtype AND p.pronargs = 0
                AND NOT p.prosecdef AND p.prokind = 'f' AND p.provolatile = 'v'
                AND t.tgattr = ''::int2vector
                AND l.lanname = 'plpgsql' AND t.tgconstraint = 0) AS implementation_matches
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE NOT t.tgisinternal AND n.nspname IN (:schema, :user_schema)
    """), {"schema": schema, "user_schema": user_schema}).mappings()
    found = {(r["nspname"], r["relname"], r["tgname"]): r for r in rows}
    search_path = connection.exec_driver_sql("SHOW search_path").scalar()
    for table in ("rooms", "room_members", "message_records", "agents", "users"):
        for operation, trigger_type in (("insert", 5), ("update", 17), ("delete", 9)):
            name = f"conversation_{table}_{operation}{suffix}"
            row = found.get((user_schema if table == "users" else schema, table, name))
            if not row or not (
                row["tgtype"] == trigger_type and row["tgenabled"] in ("O", "A")
                and row["proname"] == name and row["function_schema"] == schema
                and row["prosrc"] == functions[name] and row["unconditional"]
                and row["tgnargs"] == 0 and row["implementation_matches"]
                and _matching_search_path(row["proconfig"], search_path)
            ):
                raise RuntimeError("Conversation capture is missing or outdated; see migrations/README.md for the controlled scripts/repair_conversation_capture.py repair procedure")
    secured = set(connection.execute(text("""
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = :schema AND c.relrowsecurity
    """), {"schema": schema}).scalars())
    if not {"conversation_dirty_rooms", "conversation_accounts", "conversation_entries", "conversation_changes"} <= secured:
        raise RuntimeError("Conversation row level security is missing; see migrations/README.md for the controlled scripts/repair_conversation_capture.py repair procedure")


def register_capture(metadata):
    @event.listens_for(metadata, "after_create")
    def install(_metadata, connection, **kwargs):
        # A few tests create only a subset of the model tables.
        from sqlalchemy import inspect
        if not all(inspect(connection).has_table(t) for t in ("conversation_dirty_rooms", "message_records", "room_members", "rooms", "agents")):
            return
        dialect = connection.dialect.name
        if dialect not in ("postgresql", "sqlite"):
            return
        schema = connection.exec_driver_sql("SELECT current_schema()").scalar() if dialect == "postgresql" else ""
        import hashlib
        suffix = "_" + hashlib.md5(schema.encode()).hexdigest()[:8] if schema else ""
        translated = connection.get_execution_options().get("schema_translate_map", {}).get("public", "public")
        user_table = f'"{translated}"."users"' if dialect == "postgresql" else '"users"'
        created = {table.name for table in kwargs.get("tables", ())}
        if dialect == "postgresql" and "conversation_dirty_rooms" not in created:
            # after_create also fires when create_all created no tables.
            # Existing databases are upgraded by migrations, not each worker.
            _validate_postgres_capture(connection, schema, translated, suffix)
        else:
            for statement in capture_statements(dialect, user_table=user_table, suffix=suffix):
                connection.exec_driver_sql(statement)
        connection.engine._conversation_capture_installed = True
