-- Add source_type, source_user_id, source_session_kind to message_records
-- for distinguishing dashboard user chat messages from A2A agent messages.
ALTER TABLE message_records ADD COLUMN source_type VARCHAR(32) NOT NULL DEFAULT 'agent';
ALTER TABLE message_records ADD COLUMN source_user_id VARCHAR(128);
ALTER TABLE message_records ADD COLUMN source_session_kind VARCHAR(32);
