DO $$
BEGIN
    ALTER TYPE txtype ADD VALUE IF NOT EXISTS 'grant';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
