/*
 * [INPUT]: 依赖 rooms/room_members/message_records/agents 表，按已加入房间聚合成员数与最近消息摘要
 * [OUTPUT]: 对外提供 public.get_agent_room_previews(agent_id) SQL 函数，返回最近消息预览与 room 级未读状态
 * [POS]: frontend 登录态房间预览聚合层，为 /api/dashboard/overview 的会话列表提供单一数据源
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

-- Add persistent room read watermark for each member.
alter table room_members
add column if not exists last_viewed_at timestamptz;

create index if not exists ix_room_members_agent_room
on room_members (agent_id, room_id);

create index if not exists ix_message_records_room_id_created_at_id
on message_records (room_id, created_at, id);


drop function if exists public.get_agent_room_previews(varchar);

create or replace function public.get_agent_room_previews(p_agent_id varchar)
returns table (
  room_id varchar,
  room_name varchar,
  room_description text,
  room_rule text,
  required_subscription_product_id varchar,
  owner_id varchar,
  visibility varchar,
  my_role varchar,
  last_viewed_at timestamptz,
  has_unread boolean,
  member_count bigint,
  last_message_preview text,
  last_message_at timestamptz,
  last_sender_id varchar,
  last_sender_name varchar
)
language sql
stable
as $$
  with member_rooms as (
    select
      rm.room_id,
      rm.role as my_role,
      r.name as room_name,
      r.description as room_description,
      r.rule as room_rule,
      r.required_subscription_product_id,
      r.owner_id,
      r.visibility,
      rm.last_viewed_at
    from room_members rm
    inner join rooms r on r.room_id = rm.room_id
    where rm.agent_id = p_agent_id
  ),
  member_counts as (
    select room_id, count(*)::bigint as member_count
    from room_members
    where room_id in (select room_id from member_rooms)
    group by room_id
  ),
  ranked_messages as (
    select
      mr.room_id,
      mr.id,
      mr.sender_id as last_sender_id,
      a.display_name as last_sender_name,
      mr.created_at as last_message_at,
      left(
        coalesce(
          (mr.envelope_json::jsonb -> 'payload' ->> 'text'),
          (mr.envelope_json::jsonb -> 'payload' ->> 'body'),
          (mr.envelope_json::jsonb -> 'payload' ->> 'message'),
          ''
        ),
        200
      ) as last_message_preview,
      row_number() over (
        partition by mr.room_id
        order by mr.created_at desc, mr.id desc
      ) as rn
    from message_records mr
    left join agents a on a.agent_id = mr.sender_id
    where mr.room_id in (select room_id from member_rooms)
  ),
  latest_message as (
    select
      room_id,
      last_sender_id,
      last_sender_name,
      last_message_at,
      last_message_preview
    from ranked_messages
    where rn = 1
  ),
  unread_rooms as (
    select
      member_rooms.room_id,
      exists (
        select 1
        from (
          select
            mr.room_id,
            mr.msg_id,
            max(mr.created_at) as created_at,
            min(mr.sender_id) as sender_id
          from message_records mr
          where mr.room_id = member_rooms.room_id
          group by mr.room_id, mr.msg_id
        ) room_messages
        where room_messages.sender_id <> p_agent_id
          and (
            member_rooms.last_viewed_at is null
            or room_messages.created_at > member_rooms.last_viewed_at
          )
      ) as has_unread
    from member_rooms
  )
  select
    m.room_id,
    m.room_name,
    m.room_description,
    m.room_rule,
    m.required_subscription_product_id,
    m.owner_id,
    m.visibility,
    m.my_role,
    m.last_viewed_at,
    coalesce(ur.has_unread, false) as has_unread,
    coalesce(mc.member_count, 0) as member_count,
    lm.last_message_preview,
    lm.last_message_at,
    lm.last_sender_id,
    lm.last_sender_name
  from member_rooms m
  left join member_counts mc on mc.room_id = m.room_id
  left join latest_message lm on lm.room_id = m.room_id
  left join unread_rooms ur on ur.room_id = m.room_id
  order by lm.last_message_at desc nulls last, m.room_id asc;
$$;
