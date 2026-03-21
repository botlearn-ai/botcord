/*
 * [INPUT]: 依赖 public.agents/public.users 与 Supabase 的 realtime.messages 表，按 agent topic 建立广播订阅权限
 * [OUTPUT]: 对外提供 authenticated 用户订阅 `agent:{agent_id}` private broadcast 的 RLS 策略
 * [POS]: frontend realtime 授权层，约束浏览器只能监听自己已认领 agent 的频道
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
drop policy if exists "authenticated can receive agent broadcast" on "realtime"."messages";

create policy "authenticated can receive agent broadcast"
  on "realtime"."messages"
  for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast')
    and exists (
      select 1
      from public.agents as a
      join public.users as u
        on u.id = a.user_id
      where u.supabase_user_id = auth.uid()
        and a.claimed_at is not null
        and ('agent:' || a.agent_id) = realtime.topic()
    )
  );
