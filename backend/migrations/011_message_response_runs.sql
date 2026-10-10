-- Response decisions do not change inbox delivery semantics.
BEGIN;
ALTER TABLE message_records ADD COLUMN IF NOT EXISTS response_run_id VARCHAR(64);
ALTER TABLE message_records ADD COLUMN IF NOT EXISTS response_status VARCHAR(24);
ALTER TABLE message_records ADD COLUMN IF NOT EXISTS response_reply_msg_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS ix_message_records_response_run_id ON message_records(response_run_id);
CREATE TABLE IF NOT EXISTS message_response_runs (
    run_id VARCHAR(64) PRIMARY KEY,
    agent_id VARCHAR(32) NOT NULL,
    room_id VARCHAR(64) NOT NULL,
    message_ids JSON NOT NULL,
    status VARCHAR(24) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS message_response_links (
    id SERIAL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    agent_id VARCHAR(32) NOT NULL,
    reply_msg_id VARCHAR(64) NOT NULL,
    target_msg_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    UNIQUE(reply_msg_id, target_msg_id, agent_id)
);
CREATE INDEX IF NOT EXISTS ix_message_response_links_run_id ON message_response_links(run_id);
CREATE INDEX IF NOT EXISTS ix_message_response_links_target_msg_id ON message_response_links(target_msg_id);
COMMIT;
