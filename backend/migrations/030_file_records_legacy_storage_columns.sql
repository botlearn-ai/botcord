-- Upgrade true legacy file_records tables that still only have storage_location.
-- Migration 029 made that branch constraint-safe, but the current ORM also
-- reads storage_backend, disk_path, storage_bucket, and storage_object_key.

DO $$
DECLARE
  file_records_table regclass := to_regclass('file_records');
  has_storage_backend boolean;
  has_storage_location boolean;
BEGIN
  IF file_records_table IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = file_records_table
       AND attname = 'storage_backend'
       AND NOT attisdropped
  )
    INTO has_storage_backend;

  IF has_storage_backend THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = file_records_table
       AND attname = 'storage_location'
       AND NOT attisdropped
  )
    INTO has_storage_location;

  IF NOT has_storage_location THEN
    RETURN;
  END IF;

  EXECUTE format(
    'ALTER TABLE %s ALTER COLUMN storage_location DROP NOT NULL',
    file_records_table
  );

  EXECUTE format(
    'ALTER TABLE %s ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32)',
    file_records_table
  );
  EXECUTE format(
    'ALTER TABLE %s ADD COLUMN IF NOT EXISTS disk_path TEXT',
    file_records_table
  );
  EXECUTE format(
    'ALTER TABLE %s ADD COLUMN IF NOT EXISTS storage_bucket VARCHAR(128)',
    file_records_table
  );
  EXECUTE format(
    'ALTER TABLE %s ADD COLUMN IF NOT EXISTS storage_object_key TEXT',
    file_records_table
  );

  EXECUTE format(
    'ALTER TABLE %s DROP CONSTRAINT IF EXISTS ck_file_records_storage_backend',
    file_records_table
  );
  EXECUTE format(
    'ALTER TABLE %s DROP CONSTRAINT IF EXISTS ck_file_records_storage_location',
    file_records_table
  );

  EXECUTE format(
    $SQL$
    UPDATE %s
       SET storage_location = NULL
     WHERE storage_location IS NULL
        OR storage_location NOT IN ('disk', 'supabase')
    $SQL$,
    file_records_table
  );

  EXECUTE format(
    $SQL$
    UPDATE %s
       SET storage_backend = NULL,
           disk_path = NULL,
           storage_bucket = NULL,
           storage_object_key = NULL
    $SQL$,
    file_records_table
  );

  EXECUTE format(
    $SQL$
    ALTER TABLE %s
      ADD CONSTRAINT ck_file_records_storage_backend
      CHECK (storage_backend IS NULL OR storage_backend IN ('disk', 'supabase'))
    $SQL$,
    file_records_table
  );

  EXECUTE format(
    $SQL$
    ALTER TABLE %s
      ADD CONSTRAINT ck_file_records_storage_location
      CHECK (
        (
          storage_backend IS NULL
          AND disk_path IS NULL
          AND storage_object_key IS NULL
        )
        OR (
          storage_backend IS NOT NULL
          AND storage_backend = 'disk'
          AND disk_path IS NOT NULL
          AND storage_object_key IS NULL
        )
        OR (
          storage_backend IS NOT NULL
          AND storage_backend = 'supabase'
          AND disk_path IS NULL
          AND storage_bucket IS NOT NULL
          AND storage_object_key IS NOT NULL
        )
      )
    $SQL$,
    file_records_table
  );
END $$;
