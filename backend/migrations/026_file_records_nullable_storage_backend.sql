-- Expired file cleanup clears storage coordinates after deleting the backing
-- object. A NULL storage backend/location marks records whose storage has
-- already been cleaned while preserving expires_at so downloads keep returning
-- file_expired.

DO $$
DECLARE
  file_records_table regclass := to_regclass('file_records');
BEGIN
  IF file_records_table IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = file_records_table
       AND attname = 'storage_backend'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE file_records
      ALTER COLUMN storage_backend DROP NOT NULL;

    UPDATE file_records
      SET storage_backend = NULL
      WHERE storage_backend IN ('expired', 'deleted');

    ALTER TABLE file_records
      DROP CONSTRAINT IF EXISTS ck_file_records_storage_backend;
    ALTER TABLE file_records
      DROP CONSTRAINT IF EXISTS ck_file_records_storage_location;

    ALTER TABLE file_records
      ADD CONSTRAINT ck_file_records_storage_backend
      CHECK (storage_backend IS NULL OR storage_backend IN ('disk', 'supabase'));
  ELSIF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = file_records_table
       AND attname = 'storage_location'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE file_records
      ALTER COLUMN storage_location DROP NOT NULL;

    UPDATE file_records
      SET storage_location = NULL
      WHERE storage_location IN ('expired', 'deleted');

    ALTER TABLE file_records
      DROP CONSTRAINT IF EXISTS ck_file_records_storage_backend;
    ALTER TABLE file_records
      DROP CONSTRAINT IF EXISTS ck_file_records_storage_location;

    ALTER TABLE file_records
      ADD CONSTRAINT ck_file_records_storage_location
      CHECK (storage_location IS NULL OR storage_location IN ('disk', 'supabase'));
  END IF;
END $$;
