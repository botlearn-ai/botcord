/*
 * [INPUT]: 依赖 public.users 与 Supabase 的 realtime.messages 表，按 human topic 建立稳定的 private broadcast 授权函数
 * [OUTPUT]: 对外提供 public.can_access_human_realtime(topic) 与基于该函数的 realtime.messages 订阅策略
 * [POS]: frontend realtime 授权稳定层，Human 分支；和 004 的 Agent 分支对称，收敛跨表 policy 判断到 security definer 函数
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

create or replace function public.can_access_human_realtime(requested_topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users as u
    where u.supabase_user_id = auth.uid()
      and u.human_id is not null
      and (
        requested_topic = ('human:' || u.human_id)
        or requested_topic = ('realtime:human:' || u.human_id)
      )
  );
$$;

revoke all on function public.can_access_human_realtime(text) from public;
grant execute on function public.can_access_human_realtime(text) to authenticated;

-- Merge the Human condition into the existing realtime.messages SELECT policy
-- so a single row-level check covers both agent and human subscribers. The
-- Agent policy (004) narrowed SELECT to agent-topic rows; we widen it here to
-- "agent OR human". Dropping and recreating is idempotent.
drop policy if exists "authenticated can receive agent broadcast" on "realtime"."messages";
drop policy if exists "authenticated can receive human broadcast" on "realtime"."messages";

create policy "authenticated can receive agent or human broadcast"
  on "realtime"."messages"
  for select
  to authenticated
  using (
    public.can_access_agent_realtime(realtime.topic())
    or public.can_access_human_realtime(realtime.topic())
  );
