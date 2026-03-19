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
      r.visibility
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
  latest_message_time as (
    select room_id, max(created_at) as last_created_at
    from message_records
    where room_id in (select room_id from member_rooms)
    group by room_id
  ),
  latest_message as (
    select
      mr.room_id,
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
      ) as last_message_preview
    from message_records mr
    inner join latest_message_time lmt
      on lmt.room_id = mr.room_id and lmt.last_created_at = mr.created_at
    left join agents a on a.agent_id = mr.sender_id
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
    coalesce(mc.member_count, 0) as member_count,
    lm.last_message_preview,
    lm.last_message_at,
    lm.last_sender_id,
    lm.last_sender_name
  from member_rooms m
  left join member_counts mc on mc.room_id = m.room_id
  left join latest_message lm on lm.room_id = m.room_id;
$$;
