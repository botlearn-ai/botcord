-- Add audit fields (source_ip, source_user_agent) to message_records
-- for tracking client context on owner chat messages.
ALTER TABLE message_records ADD COLUMN source_ip VARCHAR(45);
ALTER TABLE message_records ADD COLUMN source_user_agent VARCHAR(256);
