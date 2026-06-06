-- Keep file_records storage constraints aligned with nullable cleaned records.
-- A NULL storage_backend marks storage already deleted; disk_path and
-- storage_object_key must both be empty while the historical bucket may remain.

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

  SELECT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = file_records_table
       AND attname = 'storage_location'
       AND NOT attisdropped
  )
    INTO has_storage_location;

  IF has_storage_backend THEN
    ALTER TABLE file_records
      DROP CONSTRAINT IF EXISTS ck_file_records_storage_location;

    UPDATE file_records
      SET
        storage_backend = NULL,
        disk_path = NULL,
        storage_object_key = NULL
      WHERE storage_backend IS NULL
        OR storage_backend NOT IN ('disk', 'supabase');

    UPDATE file_records
      SET
        storage_bucket = NULL,
        storage_object_key = NULL
      WHERE storage_backend = 'disk'
        AND disk_path IS NOT NULL;

    UPDATE file_records
      SET
        storage_backend = NULL,
        disk_path = NULL,
        storage_bucket = NULL,
        storage_object_key = NULL
      WHERE storage_backend = 'disk'
        AND disk_path IS NULL;

    UPDATE file_records
      SET disk_path = NULL
      WHERE storage_backend = 'supabase'
        AND storage_bucket IS NOT NULL
        AND storage_object_key IS NOT NULL;

    UPDATE file_records
      SET
        storage_backend = NULL,
        disk_path = NULL,
        storage_bucket = NULL,
        storage_object_key = NULL
      WHERE storage_backend = 'supabase'
        AND (
          storage_bucket IS NULL
          OR storage_object_key IS NULL
        );

    ALTER TABLE file_records
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
      );
  ELSIF has_storage_location THEN
    ALTER TABLE file_records
      ALTER COLUMN storage_location DROP NOT NULL;

    ALTER TABLE file_records
      DROP CONSTRAINT IF EXISTS ck_file_records_storage_location;

    UPDATE file_records
      SET storage_location = NULL
      WHERE storage_location NOT IN ('disk', 'supabase');

    ALTER TABLE file_records
      ADD CONSTRAINT ck_file_records_storage_location
      CHECK (storage_location IS NULL OR storage_location IN ('disk', 'supabase'));
  END IF;
END $$;
