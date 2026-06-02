-- Add constraints for deployments that already ran 024 before the checks
-- existed. Fresh installs already get these from 024, so guard each add.

DO $$
DECLARE
  remediated_rows integer;
BEGIN
  IF to_regclass('public.new_api_credentials') IS NULL THEN
    RETURN;
  END IF;

  -- Old deployments briefly allowed non-positive remote ids. Those rows
  -- cannot be used for New API balance checks or runtime credentials, and
  -- deleting them lets the normal provisioning path recreate valid credentials
  -- for the affected users instead of hard-failing the deploy.
  WITH deleted AS (
    DELETE FROM new_api_credentials
    WHERE new_api_user_id <= 0 OR token_id <= 0
    RETURNING 1
  )
  SELECT count(*)
    INTO remediated_rows
    FROM deleted;

  IF remediated_rows > 0 THEN
    RAISE NOTICE
      'deleted % invalid new_api_credentials row(s) before adding remote id constraints',
      remediated_rows;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_new_api_credentials_user_id_positive'
      AND conrelid = 'new_api_credentials'::regclass
  ) THEN
    ALTER TABLE new_api_credentials
      ADD CONSTRAINT ck_new_api_credentials_user_id_positive
      CHECK (new_api_user_id > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_new_api_credentials_token_id_positive'
      AND conrelid = 'new_api_credentials'::regclass
  ) THEN
    ALTER TABLE new_api_credentials
      ADD CONSTRAINT ck_new_api_credentials_token_id_positive
      CHECK (token_id > 0);
  END IF;
END $$;
