-- Persistent conversation read model and transactional change capture.
-- Apply before deploying the cursor frontend. Backfill script is resumable.

BEGIN;


CREATE TABLE IF NOT EXISTS conversation_dirty_rooms (
	room_id VARCHAR(64) NOT NULL, 
	generation BIGINT DEFAULT '1' NOT NULL, 
	writer_xid VARCHAR(32), 
	PRIMARY KEY (room_id)
)

;

CREATE TABLE IF NOT EXISTS conversation_accounts (
	user_id UUID NOT NULL, 
	epoch VARCHAR(32) NOT NULL, 
	version BIGINT DEFAULT '0' NOT NULL, 
	floor BIGINT DEFAULT '0' NOT NULL, 
	PRIMARY KEY (user_id)
)

;

CREATE TABLE IF NOT EXISTS conversation_entries (
	user_id UUID NOT NULL, 
	room_id VARCHAR(64) NOT NULL, 
	version BIGINT NOT NULL, 
	deleted BOOLEAN DEFAULT FALSE NOT NULL, 
	activity_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_sender_id VARCHAR(32), 
	payload JSON NOT NULL, 
	PRIMARY KEY (user_id, room_id)
)

;
CREATE INDEX IF NOT EXISTS ix_conversation_entries_recent ON conversation_entries (user_id, deleted, activity_at DESC, room_id);
CREATE INDEX IF NOT EXISTS ix_conversation_entries_room ON conversation_entries (room_id);
CREATE INDEX IF NOT EXISTS ix_conversation_entries_sender ON conversation_entries (last_sender_id);

CREATE TABLE IF NOT EXISTS conversation_changes (
	user_id UUID NOT NULL, 
	version BIGINT NOT NULL, 
	room_id VARCHAR(64) NOT NULL, 
	PRIMARY KEY (user_id, version)
)

;

DO $migration$
DECLARE suffix text := '_' || substr(md5(current_schema()), 1, 8);
BEGIN
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_rooms_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_rooms_insert__SCHEMA_SUFFIX__ ON rooms$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_rooms_insert__SCHEMA_SUFFIX__ AFTER INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION conversation_rooms_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_rooms_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.room_id IS DISTINCT FROM NEW.room_id OR OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description OR OLD.rule IS DISTINCT FROM NEW.rule OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.owner_type IS DISTINCT FROM NEW.owner_type OR OLD.visibility IS DISTINCT FROM NEW.visibility OR OLD.join_policy IS DISTINCT FROM NEW.join_policy OR OLD.required_subscription_product_id IS DISTINCT FROM NEW.required_subscription_product_id OR OLD.max_members IS DISTINCT FROM NEW.max_members OR OLD.default_send IS DISTINCT FROM NEW.default_send OR OLD.default_invite IS DISTINCT FROM NEW.default_invite OR OLD.allow_human_send IS DISTINCT FROM NEW.allow_human_send OR OLD.slow_mode_seconds IS DISTINCT FROM NEW.slow_mode_seconds OR OLD.space_id IS DISTINCT FROM NEW.space_id THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL UNION SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_rooms_update__SCHEMA_SUFFIX__ ON rooms$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_rooms_update__SCHEMA_SUFFIX__ AFTER UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION conversation_rooms_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_rooms_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_rooms_delete__SCHEMA_SUFFIX__ ON rooms$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_rooms_delete__SCHEMA_SUFFIX__ AFTER DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION conversation_rooms_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_room_members_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_room_members_insert__SCHEMA_SUFFIX__ ON room_members$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_room_members_insert__SCHEMA_SUFFIX__ AFTER INSERT ON room_members FOR EACH ROW EXECUTE FUNCTION conversation_room_members_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_room_members_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.room_id IS DISTINCT FROM NEW.room_id OR OLD.agent_id IS DISTINCT FROM NEW.agent_id OR OLD.role IS DISTINCT FROM NEW.role OR OLD.can_invite IS DISTINCT FROM NEW.can_invite OR OLD.can_send IS DISTINCT FROM NEW.can_send OR OLD.last_viewed_at IS DISTINCT FROM NEW.last_viewed_at OR OLD.participant_type IS DISTINCT FROM NEW.participant_type THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL UNION SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_room_members_update__SCHEMA_SUFFIX__ ON room_members$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_room_members_update__SCHEMA_SUFFIX__ AFTER UPDATE ON room_members FOR EACH ROW EXECUTE FUNCTION conversation_room_members_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_room_members_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_room_members_delete__SCHEMA_SUFFIX__ ON room_members$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_room_members_delete__SCHEMA_SUFFIX__ AFTER DELETE ON room_members FOR EACH ROW EXECUTE FUNCTION conversation_room_members_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_message_records_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL AND COALESCE((NEW.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system')) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_message_records_insert__SCHEMA_SUFFIX__ ON message_records$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_message_records_insert__SCHEMA_SUFFIX__ AFTER INSERT ON message_records FOR EACH ROW EXECUTE FUNCTION conversation_message_records_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_message_records_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.room_id IS DISTINCT FROM NEW.room_id OR OLD.msg_id IS DISTINCT FROM NEW.msg_id OR OLD.sender_id IS DISTINCT FROM NEW.sender_id OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.envelope_json IS DISTINCT FROM NEW.envelope_json OR OLD.recalled_at IS DISTINCT FROM NEW.recalled_at THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL AND COALESCE((OLD.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system') UNION SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL AND COALESCE((NEW.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system')) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_message_records_update__SCHEMA_SUFFIX__ ON message_records$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_message_records_update__SCHEMA_SUFFIX__ AFTER UPDATE ON message_records FOR EACH ROW EXECUTE FUNCTION conversation_message_records_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_message_records_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL AND COALESCE((OLD.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system')) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_message_records_delete__SCHEMA_SUFFIX__ ON message_records$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_message_records_delete__SCHEMA_SUFFIX__ AFTER DELETE ON message_records FOR EACH ROW EXECUTE FUNCTION conversation_message_records_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_agents_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT room_id FROM room_members WHERE agent_id = NEW.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.agent_id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_agents_insert__SCHEMA_SUFFIX__ ON agents$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_agents_insert__SCHEMA_SUFFIX__ AFTER INSERT ON agents FOR EACH ROW EXECUTE FUNCTION conversation_agents_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_agents_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.agent_id IS DISTINCT FROM NEW.agent_id OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.agent_id UNION SELECT room_id FROM room_members WHERE agent_id = NEW.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.agent_id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_agents_update__SCHEMA_SUFFIX__ ON agents$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_agents_update__SCHEMA_SUFFIX__ AFTER UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION conversation_agents_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_agents_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.agent_id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_agents_delete__SCHEMA_SUFFIX__ ON agents$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_agents_delete__SCHEMA_SUFFIX__ AFTER DELETE ON agents FOR EACH ROW EXECUTE FUNCTION conversation_agents_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_users_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT room_id FROM room_members WHERE agent_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = NEW.id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_users_insert__SCHEMA_SUFFIX__ ON "public"."users"$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_users_insert__SCHEMA_SUFFIX__ AFTER INSERT ON "public"."users" FOR EACH ROW EXECUTE FUNCTION conversation_users_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_users_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.human_id IS DISTINCT FROM NEW.human_id OR OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = OLD.id UNION SELECT room_id FROM room_members WHERE agent_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = NEW.id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_users_update__SCHEMA_SUFFIX__ ON "public"."users"$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_users_update__SCHEMA_SUFFIX__ AFTER UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION conversation_users_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_users_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid) SELECT room_id, 1, txid_current()::text FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = OLD.id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_users_delete__SCHEMA_SUFFIX__ ON "public"."users"$ddl$, '__SCHEMA_SUFFIX__', suffix);
  EXECUTE replace($ddl$CREATE TRIGGER conversation_users_delete__SCHEMA_SUFFIX__ AFTER DELETE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION conversation_users_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);
END;
$migration$;

-- Queue existing rooms and prior entries; no message history is read here.
INSERT INTO conversation_dirty_rooms (room_id, generation)
SELECT room_id, 1 FROM (SELECT room_id FROM rooms WHERE space_id IS NULL
    UNION SELECT room_id FROM conversation_entries) AS pending
ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1;

-- Server-owned read model: no direct anon/authenticated Supabase table access.
-- The Hub DB role must own these tables or have BYPASSRLS.
ALTER TABLE conversation_dirty_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_changes ENABLE ROW LEVEL SECURITY;

COMMIT;
