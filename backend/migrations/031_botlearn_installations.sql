-- PR 9: BotLearn first-party browser integration.
--
-- One row per BotLearn login identity bound to a BotCord user + default
-- Cloud Agent. This is the durable authorization record behind the
-- short-lived ``botlearn-integration-session`` token — NOT a long-term API
-- key. BotLearn browsers never hold a long-lived BotCord credential; they
-- exchange their login token for a session token scoped to this row.
--
-- See docs/cloud-agent-technical-design.md §5.6.

CREATE TABLE IF NOT EXISTS public.botlearn_installations (
    id VARCHAR(32) PRIMARY KEY,
    user_id UUID NOT NULL,
    botlearn_subject VARCHAR(256) NOT NULL,
    botlearn_email VARCHAR(256),
    agent_id VARCHAR(32),
    scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_botlearn_subject_agent UNIQUE (botlearn_subject, agent_id)
);

CREATE INDEX IF NOT EXISTS ix_botlearn_installations_user
    ON public.botlearn_installations (user_id);

CREATE INDEX IF NOT EXISTS ix_botlearn_installations_subject
    ON public.botlearn_installations (botlearn_subject);
