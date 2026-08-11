ALTER TABLE daemon_instances
    ADD COLUMN IF NOT EXISTS hub_control_trust_key_fingerprints JSONB;
