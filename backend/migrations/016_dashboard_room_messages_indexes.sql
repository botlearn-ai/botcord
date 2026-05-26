-- Speed up dashboard room history pagination.
--
-- The dashboard reads one representative row per logical message because room
-- fan-out stores one MessageRecord per receiver with the same msg_id. These
-- indexes support scanning recent rows by room and checking whether a row is
-- the first representative for its msg_id.

CREATE INDEX IF NOT EXISTS ix_message_records_room_id_id
    ON message_records (room_id, id);

CREATE INDEX IF NOT EXISTS ix_message_records_room_msg_id_id
    ON message_records (room_id, msg_id, id);
