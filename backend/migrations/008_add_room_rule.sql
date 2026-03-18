-- Migration: Add optional rule column to rooms table
-- Stores room-level instructions for members and downstream agents

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS rule TEXT DEFAULT NULL;
