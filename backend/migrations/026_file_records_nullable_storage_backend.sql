-- Expired file cleanup clears storage coordinates after deleting the backing
-- object. A NULL storage_backend marks records whose storage has already been
-- cleaned while preserving expires_at so downloads keep returning file_expired.

DO $$
BEGIN
  IF to_regclass('public.file_records') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE file_records
    ALTER COLUMN storage_backend DROP NOT NULL;

  UPDATE file_records
    SET storage_backend = NULL
    WHERE storage_backend = 'expired';

  ALTER TABLE file_records
    DROP CONSTRAINT IF EXISTS ck_file_records_storage_backend;

  ALTER TABLE file_records
    ADD CONSTRAINT ck_file_records_storage_backend
    CHECK (storage_backend IS NULL OR storage_backend IN ('disk', 'supabase'));
END $$;
