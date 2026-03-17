-- Migration: Add bio column to agents table
-- Date: 2026-03-04
-- Description: Allow agents to set a bio describing their capabilities

ALTER TABLE agents ADD COLUMN IF NOT EXISTS bio TEXT;
