-- Migration 003: Create file_records table for Hub-hosted file upload
-- Run against PostgreSQL 16

CREATE TABLE file_records (
    id SERIAL PRIMARY KEY,
    file_id VARCHAR(64) NOT NULL,
    uploader_id VARCHAR(32) NOT NULL REFERENCES agents(agent_id),
    original_filename VARCHAR(256) NOT NULL,
    content_type VARCHAR(128) NOT NULL,
    size_bytes INTEGER NOT NULL,
    disk_path TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX ix_file_records_file_id ON file_records(file_id);
CREATE INDEX ix_file_records_uploader_id ON file_records(uploader_id);
CREATE INDEX ix_file_records_expires_at ON file_records(expires_at);
