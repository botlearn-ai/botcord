/*
 * [INPUT]: 依赖 public.agents/public.users 与 Supabase 的 realtime.messages 表，按 agent topic 建立稳定的 private broadcast 授权函数
 * [OUTPUT]: 对外提供 public.can_access_agent_realtime(topic) 与基于该函数的 realtime.messages 订阅策略
 * [POS]: frontend realtime 授权稳定层，把脆弱的跨表 policy 判断收敛为 security definer 函数
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

create or replace function public.can_access_agent_realtime(requested_topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.agents as a
    join public.users as u
      on u.id = a.user_id
    where u.supabase_user_id = auth.uid()
      and a.claimed_at is not null
      and (
        requested_topic = ('agent:' || a.agent_id)
        or requested_topic = ('realtime:agent:' || a.agent_id)
      )
  );
$$;

revoke all on function public.can_access_agent_realtime(text) from public;
grant execute on function public.can_access_agent_realtime(text) to authenticated;

drop policy if exists "authenticated can receive agent broadcast" on "realtime"."messages";

create policy "authenticated can receive agent broadcast"
  on "realtime"."messages"
  for select
  to authenticated
  using (
    public.can_access_agent_realtime(realtime.topic())
  );
