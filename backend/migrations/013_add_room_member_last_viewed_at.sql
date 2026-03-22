-- Add persistent room read watermark for each member.
alter table room_members
add column if not exists last_viewed_at timestamptz;

create index if not exists ix_room_members_agent_room
on room_members (agent_id, room_id);

create index if not exists ix_message_records_room_id_created_at_id
on message_records (room_id, created_at, id);
