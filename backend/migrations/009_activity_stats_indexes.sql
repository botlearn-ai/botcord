CREATE INDEX IF NOT EXISTS ix_message_records_sender_created_room
    ON message_records (sender_id, created_at, room_id);

CREATE INDEX IF NOT EXISTS ix_message_records_receiver_created_room
    ON message_records (receiver_id, created_at, room_id);

CREATE INDEX IF NOT EXISTS ix_topics_creator_updated_status
    ON topics (creator_id, updated_at, status);
