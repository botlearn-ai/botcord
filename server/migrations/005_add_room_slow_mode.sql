-- Migration: Add slow_mode_seconds column to rooms table
-- Supports per-room slow mode for anti-spam protection

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slow_mode_seconds INTEGER DEFAULT NULL;
