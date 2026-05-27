-- Quote-reply: add reply_to_msg_id column to message_records.
-- See backend/doc/quote-reply-prd.md.
--
-- `reply_to_msg_id` stores the target msg_id when an envelope of type=message
-- carries `reply_to`. Receipt envelopes (ack/result/error) keep using the
-- envelope-level `reply_to` field and are NOT written into this column.

ALTER TABLE message_records
    ADD COLUMN IF NOT EXISTS reply_to_msg_id VARCHAR(64);

-- Partial composite index for two query patterns:
--   1. preview lookups: WHERE msg_id IN (...) (covered by existing index on msg_id)
--   2. reverse-reply lookups: WHERE room_id = ? AND reply_to_msg_id = ?
-- Partial WHERE keeps the index small since most messages have no reply_to.
CREATE INDEX IF NOT EXISTS ix_message_records_room_reply_to
    ON message_records (room_id, reply_to_msg_id)
    WHERE reply_to_msg_id IS NOT NULL;
