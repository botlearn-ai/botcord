-- Third-party gateway (Telegram / WeChat / Feishu) connection metadata.
-- See docs/third-party-gateway-design.md "Hub / Backend 设计".
-- Hub stores metadata only (provider, label, whitelist, baseUrl, splitAt,
-- tokenPreview, status). Bot tokens NEVER live here — they are written to
-- the daemon's local secret store (~/.botcord/daemon/gateways/{id}.json).

CREATE TABLE IF NOT EXISTS agent_gateway_connections (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    daemon_instance_id TEXT NOT NULL REFERENCES daemon_instances(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_agent_gateway_connections_provider
        CHECK (provider IN ('telegram', 'wechat', 'feishu')),
    CONSTRAINT ck_agent_gateway_connections_status
        CHECK (status IN ('pending', 'active', 'disabled', 'error'))
);

CREATE INDEX IF NOT EXISTS ix_agent_gateway_connections_user
    ON agent_gateway_connections (user_id);

CREATE INDEX IF NOT EXISTS ix_agent_gateway_connections_agent
    ON agent_gateway_connections (agent_id);

CREATE INDEX IF NOT EXISTS ix_agent_gateway_connections_daemon
    ON agent_gateway_connections (daemon_instance_id);
