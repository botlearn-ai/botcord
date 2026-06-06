-- Forward repair for databases that already recorded migrations 026/027.
-- The migration runner skips previously applied filenames, so this new
-- filename reapplies the file_records nullable storage cleanup on deployed DBs.

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
    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN storage_backend DROP NOT NULL',
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
         SET storage_backend = NULL,
             disk_path = NULL,
             storage_object_key = NULL
       WHERE storage_backend IS NULL
          OR storage_backend NOT IN ('disk', 'supabase')
      $SQL$,
      file_records_table
    );

    EXECUTE format(
      $SQL$
      UPDATE %s
         SET storage_bucket = NULL,
             storage_object_key = NULL
       WHERE storage_backend = 'disk'
         AND disk_path IS NOT NULL
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
       WHERE storage_backend = 'disk'
         AND disk_path IS NULL
      $SQL$,
      file_records_table
    );

    EXECUTE format(
      $SQL$
      UPDATE %s
         SET disk_path = NULL
       WHERE storage_backend = 'supabase'
         AND storage_bucket IS NOT NULL
         AND storage_object_key IS NOT NULL
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
       WHERE storage_backend = 'supabase'
         AND (
           storage_bucket IS NULL
           OR storage_object_key IS NULL
         )
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
  ELSIF has_storage_location THEN
    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN storage_location DROP NOT NULL',
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
      ALTER TABLE %s
        ADD CONSTRAINT ck_file_records_storage_location
        CHECK (storage_location IS NULL OR storage_location IN ('disk', 'supabase'))
      $SQL$,
      file_records_table
    );
  END IF;
END $$;
