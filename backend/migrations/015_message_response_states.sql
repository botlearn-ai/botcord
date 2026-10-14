-- Add durable response facts without changing the legacy activity contract.
BEGIN;
ALTER TABLE message_records ADD COLUMN IF NOT EXISTS response_state VARCHAR(24);
ALTER TABLE message_records ADD COLUMN IF NOT EXISTS response_reason VARCHAR(32);
ALTER TABLE message_records ADD COLUMN IF NOT EXISTS response_updated_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS message_response_events (
    id SERIAL PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    agent_id VARCHAR(32) NOT NULL,
    room_id VARCHAR(64) NOT NULL,
    target_msg_id VARCHAR(64) NOT NULL,
    state VARCHAR(24) NOT NULL,
    reason VARCHAR(32),
    reply_msg_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(run_id, target_msg_id, agent_id, state)
);
CREATE INDEX IF NOT EXISTS ix_message_response_events_run_id ON message_response_events(run_id);
CREATE INDEX IF NOT EXISTS ix_message_response_events_target
    ON message_response_events(room_id, target_msg_id, agent_id, id);
-- Do not backfill response_state or synthesize events: historical no_reply
-- cannot distinguish policy skips from decisions made after processing.
COMMIT;
