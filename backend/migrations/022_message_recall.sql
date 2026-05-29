-- Dashboard message recall: keep logical messages in place while redacting
-- sender-authored content after a recall.

ALTER TABLE message_records
    ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;

ALTER TABLE message_records
    ADD COLUMN IF NOT EXISTS recalled_by_id VARCHAR(32);

ALTER TABLE message_records
    ADD COLUMN IF NOT EXISTS recalled_by_type participanttype;

CREATE INDEX IF NOT EXISTS ix_message_records_room_msg_recalled
    ON message_records (room_id, msg_id, recalled_at)
    WHERE recalled_at IS NOT NULL;
