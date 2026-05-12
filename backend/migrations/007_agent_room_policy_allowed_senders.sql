ALTER TABLE agent_room_policy_overrides
ADD COLUMN IF NOT EXISTS allowed_sender_ids TEXT;
