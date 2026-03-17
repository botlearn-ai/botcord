-- Migration: Add mentioned column to message_records table
-- Supports @mention tagging in room fan-out messages

ALTER TABLE message_records ADD COLUMN IF NOT EXISTS mentioned BOOLEAN NOT NULL DEFAULT FALSE;
