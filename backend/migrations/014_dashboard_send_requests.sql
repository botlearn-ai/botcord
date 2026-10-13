-- Durable request deduplication; reservation and fan-out commit together.
BEGIN;
CREATE TABLE IF NOT EXISTS dashboard_send_requests (
    request_id VARCHAR(64) PRIMARY KEY,
    fingerprint VARCHAR(64) NOT NULL,
    response_json JSON,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
