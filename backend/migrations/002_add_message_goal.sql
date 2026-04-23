-- Migration: 002_add_message_goal
-- Description: Add goal column to message_records for topic lifecycle support
-- Date: 2026-03-11

ALTER TABLE message_records
    ADD COLUMN IF NOT EXISTS goal VARCHAR(1024) DEFAULT NULL;
