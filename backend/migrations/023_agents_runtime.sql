-- 023_agents_runtime.sql
-- Record the runtime selected at agent creation (claude-code / codex / gemini / ...).
-- Null is valid: agents created through bind_code have no daemon-side runtime.

alter table agents
    add column if not exists runtime varchar(32);
