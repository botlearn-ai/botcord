-- Organization rooms become Hub Rooms owned by a Team space (agents can join).
-- Apply after 002_team_identity_spaces.sql, using the configured Hub schema.
BEGIN;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS space_id UUID REFERENCES spaces (id);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS space_kind VARCHAR(8);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS space_visibility VARCHAR(16);
CREATE INDEX IF NOT EXISTS ix_rooms_space_id ON rooms (space_id);

COMMIT;
