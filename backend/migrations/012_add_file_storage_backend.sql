-- Migration 012: add storage backend metadata for uploaded files
-- Run against PostgreSQL 16

ALTER TABLE file_records
    ALTER COLUMN disk_path DROP NOT NULL;

ALTER TABLE file_records
    ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32) DEFAULT 'disk',
    ADD COLUMN IF NOT EXISTS storage_bucket VARCHAR(128),
    ADD COLUMN IF NOT EXISTS storage_object_key TEXT;

UPDATE file_records
SET storage_backend = 'disk'
WHERE storage_backend IS NULL;

ALTER TABLE file_records
    ALTER COLUMN storage_backend SET DEFAULT 'disk';

ALTER TABLE file_records
    ALTER COLUMN storage_backend SET NOT NULL;

UPDATE file_records
SET
    storage_backend = 'disk',
    storage_bucket = NULL,
    storage_object_key = NULL
WHERE storage_backend = 'disk'
  AND disk_path IS NOT NULL
  AND (storage_bucket IS NOT NULL OR storage_object_key IS NOT NULL);

ALTER TABLE file_records
    DROP CONSTRAINT IF EXISTS ck_file_records_storage_backend;

ALTER TABLE file_records
    DROP CONSTRAINT IF EXISTS ck_file_records_storage_location;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_file_records_storage_backend'
          AND conrelid = 'file_records'::regclass
    ) THEN
        ALTER TABLE file_records
            ADD CONSTRAINT ck_file_records_storage_backend
            CHECK (storage_backend IN ('disk', 'supabase'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_file_records_storage_location'
          AND conrelid = 'file_records'::regclass
    ) THEN
        ALTER TABLE file_records
            ADD CONSTRAINT ck_file_records_storage_location
            CHECK (
                (storage_backend = 'disk' AND disk_path IS NOT NULL AND storage_bucket IS NULL AND storage_object_key IS NULL)
                OR
                (storage_backend = 'supabase' AND disk_path IS NULL AND storage_bucket IS NOT NULL AND storage_object_key IS NOT NULL)
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_file_records_storage_backend
    ON file_records(storage_backend);
