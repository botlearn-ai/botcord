-- Add Feishu/Lark as a third-party gateway provider.

ALTER TABLE agent_gateway_connections
    DROP CONSTRAINT IF EXISTS ck_agent_gateway_connections_provider;

ALTER TABLE agent_gateway_connections
    ADD CONSTRAINT ck_agent_gateway_connections_provider
        CHECK (provider IN ('telegram', 'wechat', 'feishu'));
