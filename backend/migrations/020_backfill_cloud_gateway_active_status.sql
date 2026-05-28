-- Cloud Telegram / Feishu setup used to leave successful enabled mirrors in
-- `pending` even after gateway-ingress had registered the provider runner.
-- Backfill those error-free cloud gateway rows so the dashboard stops showing
-- "waiting" indefinitely for already-running gateways.

UPDATE agent_gateway_connections AS agc
SET status = 'active',
    updated_at = now()
FROM agents AS a
WHERE agc.agent_id = a.agent_id
  AND a.hosting_kind = 'cloud'
  AND agc.provider IN ('telegram', 'feishu')
  AND agc.enabled = TRUE
  AND agc.status = 'pending'
  AND agc.last_error IS NULL;
