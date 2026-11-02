-- Incremental logical messages and reason-specific conversation projection.
-- Stop old Hub writers/workers, apply, backfill with new code, then roll out.
-- Generated DDL must match models + conversation_capture; tested against PG.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE conversation_dirty_rooms ADD COLUMN IF NOT EXISTS reasons INTEGER NOT NULL DEFAULT 8;
ALTER TABLE conversation_entries ADD COLUMN IF NOT EXISTS read_member_id VARCHAR(32);



CREATE TABLE IF NOT EXISTS conversation_dirty_messages (
	room_id VARCHAR(64) NOT NULL, 
	msg_id VARCHAR(64) NOT NULL, 
	PRIMARY KEY (room_id, msg_id)
)

;


CREATE TABLE IF NOT EXISTS conversation_dirty_readers (
	room_id VARCHAR(64) NOT NULL, 
	agent_id VARCHAR(32) NOT NULL, 
	PRIMARY KEY (room_id, agent_id)
)

;


CREATE TABLE IF NOT EXISTS conversation_messages (
	room_id VARCHAR(64) NOT NULL, 
	msg_id VARCHAR(64) NOT NULL, 
	canonical_id INTEGER NOT NULL, 
	sender_id VARCHAR(32) NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	recalled_at TIMESTAMP WITH TIME ZONE, 
	preview TEXT, 
	PRIMARY KEY (room_id, msg_id)
)

;

CREATE INDEX IF NOT EXISTS ix_conversation_messages_latest ON conversation_messages (room_id, created_at, canonical_id);


CREATE TABLE IF NOT EXISTS conversation_room_summaries (
	room_id VARCHAR(64) NOT NULL, 
	last_message_at TIMESTAMP WITH TIME ZONE, 
	last_sender_id VARCHAR(32), 
	last_message_preview TEXT, 
	PRIMARY KEY (room_id)
)

;

DO $migration$
DECLARE suffix text := '_' || substr(md5(current_schema()), 1, 8);
BEGIN

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_rooms_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_rooms_insert__SCHEMA_SUFFIX__ ON rooms$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_rooms_insert__SCHEMA_SUFFIX__ AFTER INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION conversation_rooms_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_rooms_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.room_id IS DISTINCT FROM NEW.room_id OR OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description OR OLD.rule IS DISTINCT FROM NEW.rule OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.owner_type IS DISTINCT FROM NEW.owner_type OR OLD.visibility IS DISTINCT FROM NEW.visibility OR OLD.join_policy IS DISTINCT FROM NEW.join_policy OR OLD.required_subscription_product_id IS DISTINCT FROM NEW.required_subscription_product_id OR OLD.max_members IS DISTINCT FROM NEW.max_members OR OLD.default_send IS DISTINCT FROM NEW.default_send OR OLD.default_invite IS DISTINCT FROM NEW.default_invite OR OLD.allow_human_send IS DISTINCT FROM NEW.allow_human_send OR OLD.slow_mode_seconds IS DISTINCT FROM NEW.slow_mode_seconds OR OLD.space_id IS DISTINCT FROM NEW.space_id THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL UNION SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_rooms_update__SCHEMA_SUFFIX__ ON rooms$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_rooms_update__SCHEMA_SUFFIX__ AFTER UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION conversation_rooms_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_rooms_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_rooms_delete__SCHEMA_SUFFIX__ ON rooms$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_rooms_delete__SCHEMA_SUFFIX__ AFTER DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION conversation_rooms_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_room_members_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; INSERT INTO conversation_dirty_readers (room_id, agent_id) SELECT NEW.room_id, NEW.agent_id WHERE NEW.room_id IS NOT NULL ON CONFLICT (room_id, agent_id) DO NOTHING; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_room_members_insert__SCHEMA_SUFFIX__ ON room_members$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_room_members_insert__SCHEMA_SUFFIX__ AFTER INSERT ON room_members FOR EACH ROW EXECUTE FUNCTION conversation_room_members_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_room_members_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.room_id IS DISTINCT FROM NEW.room_id OR OLD.agent_id IS DISTINCT FROM NEW.agent_id OR OLD.role IS DISTINCT FROM NEW.role OR OLD.can_invite IS DISTINCT FROM NEW.can_invite OR OLD.can_send IS DISTINCT FROM NEW.can_send OR OLD.last_viewed_at IS DISTINCT FROM NEW.last_viewed_at OR OLD.participant_type IS DISTINCT FROM NEW.participant_type THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, CASE WHEN OLD.room_id IS DISTINCT FROM NEW.room_id OR OLD.agent_id IS DISTINCT FROM NEW.agent_id OR OLD.role IS DISTINCT FROM NEW.role OR OLD.can_invite IS DISTINCT FROM NEW.can_invite OR OLD.can_send IS DISTINCT FROM NEW.can_send OR OLD.participant_type IS DISTINCT FROM NEW.participant_type THEN 1 ELSE 4 END FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL UNION SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; INSERT INTO conversation_dirty_readers (room_id, agent_id) SELECT OLD.room_id, OLD.agent_id WHERE OLD.room_id IS NOT NULL ON CONFLICT (room_id, agent_id) DO NOTHING; INSERT INTO conversation_dirty_readers (room_id, agent_id) SELECT NEW.room_id, NEW.agent_id WHERE NEW.room_id IS NOT NULL ON CONFLICT (room_id, agent_id) DO NOTHING; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_room_members_update__SCHEMA_SUFFIX__ ON room_members$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_room_members_update__SCHEMA_SUFFIX__ AFTER UPDATE ON room_members FOR EACH ROW EXECUTE FUNCTION conversation_room_members_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_room_members_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; INSERT INTO conversation_dirty_readers (room_id, agent_id) SELECT OLD.room_id, OLD.agent_id WHERE OLD.room_id IS NOT NULL ON CONFLICT (room_id, agent_id) DO NOTHING; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_room_members_delete__SCHEMA_SUFFIX__ ON room_members$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_room_members_delete__SCHEMA_SUFFIX__ AFTER DELETE ON room_members FOR EACH ROW EXECUTE FUNCTION conversation_room_members_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_message_records_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 2 FROM (SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL AND COALESCE((NEW.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system')) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; INSERT INTO conversation_dirty_messages (room_id, msg_id) SELECT NEW.room_id, NEW.msg_id WHERE NEW.room_id IS NOT NULL AND COALESCE((NEW.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system') ON CONFLICT (room_id, msg_id) DO NOTHING; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_message_records_insert__SCHEMA_SUFFIX__ ON message_records$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_message_records_insert__SCHEMA_SUFFIX__ AFTER INSERT ON message_records FOR EACH ROW EXECUTE FUNCTION conversation_message_records_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_message_records_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.room_id IS DISTINCT FROM NEW.room_id OR OLD.msg_id IS DISTINCT FROM NEW.msg_id OR OLD.sender_id IS DISTINCT FROM NEW.sender_id OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.envelope_json IS DISTINCT FROM NEW.envelope_json OR OLD.recalled_at IS DISTINCT FROM NEW.recalled_at THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 2 FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL AND COALESCE((OLD.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system') UNION SELECT NEW.room_id AS room_id WHERE NEW.room_id IS NOT NULL AND COALESCE((NEW.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system')) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; INSERT INTO conversation_dirty_messages (room_id, msg_id) SELECT OLD.room_id, OLD.msg_id WHERE OLD.room_id IS NOT NULL AND COALESCE((OLD.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system') ON CONFLICT (room_id, msg_id) DO NOTHING; INSERT INTO conversation_dirty_messages (room_id, msg_id) SELECT NEW.room_id, NEW.msg_id WHERE NEW.room_id IS NOT NULL AND COALESCE((NEW.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system') ON CONFLICT (room_id, msg_id) DO NOTHING; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_message_records_update__SCHEMA_SUFFIX__ ON message_records$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_message_records_update__SCHEMA_SUFFIX__ AFTER UPDATE ON message_records FOR EACH ROW EXECUTE FUNCTION conversation_message_records_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_message_records_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 2 FROM (SELECT OLD.room_id AS room_id WHERE OLD.room_id IS NOT NULL AND COALESCE((OLD.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system')) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; INSERT INTO conversation_dirty_messages (room_id, msg_id) SELECT OLD.room_id, OLD.msg_id WHERE OLD.room_id IS NOT NULL AND COALESCE((OLD.envelope_json::jsonb ->> 'type'), 'message') IN ('message', 'system') ON CONFLICT (room_id, msg_id) DO NOTHING; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_message_records_delete__SCHEMA_SUFFIX__ ON message_records$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_message_records_delete__SCHEMA_SUFFIX__ AFTER DELETE ON message_records FOR EACH ROW EXECUTE FUNCTION conversation_message_records_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_agents_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT room_id FROM room_members WHERE agent_id = NEW.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.agent_id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_agents_insert__SCHEMA_SUFFIX__ ON agents$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_agents_insert__SCHEMA_SUFFIX__ AFTER INSERT ON agents FOR EACH ROW EXECUTE FUNCTION conversation_agents_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_agents_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.agent_id IS DISTINCT FROM NEW.agent_id OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.agent_id UNION SELECT room_id FROM room_members WHERE agent_id = NEW.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.agent_id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_agents_update__SCHEMA_SUFFIX__ ON agents$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_agents_update__SCHEMA_SUFFIX__ AFTER UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION conversation_agents_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_agents_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.agent_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.agent_id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_agents_delete__SCHEMA_SUFFIX__ ON agents$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_agents_delete__SCHEMA_SUFFIX__ AFTER DELETE ON agents FOR EACH ROW EXECUTE FUNCTION conversation_agents_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_users_insert__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT room_id FROM room_members WHERE agent_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = NEW.id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_users_insert__SCHEMA_SUFFIX__ ON "public"."users"$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_users_insert__SCHEMA_SUFFIX__ AFTER INSERT ON "public"."users" FOR EACH ROW EXECUTE FUNCTION conversation_users_insert__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_users_update__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF OLD.human_id IS DISTINCT FROM NEW.human_id OR OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = OLD.id UNION SELECT room_id FROM room_members WHERE agent_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = NEW.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = NEW.id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_users_update__SCHEMA_SUFFIX__ ON "public"."users"$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_users_update__SCHEMA_SUFFIX__ AFTER UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION conversation_users_update__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE OR REPLACE FUNCTION conversation_users_delete__SCHEMA_SUFFIX__() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$ BEGIN IF TRUE THEN INSERT INTO conversation_dirty_rooms (room_id, generation, writer_xid, reasons) SELECT room_id, 1, txid_current()::text, 1 FROM (SELECT room_id FROM room_members WHERE agent_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE last_sender_id = OLD.human_id UNION SELECT room_id FROM conversation_entries WHERE user_id = OLD.id) AS affected WHERE room_id IS NOT NULL ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1, writer_xid = EXCLUDED.writer_xid, reasons = conversation_dirty_rooms.reasons | EXCLUDED.reasons; END IF; RETURN NULL; END; $capture$$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$DROP TRIGGER IF EXISTS conversation_users_delete__SCHEMA_SUFFIX__ ON "public"."users"$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$CREATE TRIGGER conversation_users_delete__SCHEMA_SUFFIX__ AFTER DELETE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION conversation_users_delete__SCHEMA_SUFFIX__()$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_dirty_rooms ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_dirty_messages ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_dirty_readers ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_room_summaries ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_accounts ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_entries ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

  EXECUTE replace($ddl$ALTER TABLE conversation_changes ENABLE ROW LEVEL SECURITY$ddl$, '__SCHEMA_SUFFIX__', suffix);

END;
$migration$;
INSERT INTO conversation_dirty_rooms (room_id, generation, reasons)
SELECT room_id, 1, 8 FROM (SELECT room_id FROM rooms WHERE space_id IS NULL
    UNION SELECT room_id FROM conversation_entries) AS pending WHERE TRUE
ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1,
    reasons = conversation_dirty_rooms.reasons | 8;
COMMIT;
