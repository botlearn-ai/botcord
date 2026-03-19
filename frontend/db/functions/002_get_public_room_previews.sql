drop function if exists public.get_public_room_previews(integer, integer, text, varchar, varchar);

create or replace function public.get_public_room_previews(
  p_limit integer default 20,
  p_offset integer default 0,
  p_search text default null,
  p_room_id varchar default null,
  p_sort varchar default 'recent'
)
returns table (
  room_id varchar,
  room_name varchar,
  room_description text,
  room_rule text,
  required_subscription_product_id varchar,
  owner_id varchar,
  visibility varchar,
  join_policy varchar,
  max_members integer,
  created_at timestamptz,
  member_count bigint,
  last_message_preview text,
  last_message_at timestamptz,
  last_sender_id varchar,
  last_sender_name varchar
)
language sql
stable
as $$
  with filtered_rooms as (
    select
      r.room_id,
      r.name as room_name,
      r.description as room_description,
      r.rule as room_rule,
      r.required_subscription_product_id,
      r.owner_id,
      r.visibility,
      r.join_policy,
      r.max_members,
      r.created_at
    from rooms r
    where r.visibility = 'public'
      and (p_room_id is null or r.room_id = p_room_id)
      and (
        coalesce(trim(p_search), '') = ''
        or r.name ilike '%' || replace(replace(trim(p_search), '%', '\%'), '_', '\_') || '%' escape '\'
      )
  ),
  member_counts as (
    select room_id, count(*)::bigint as member_count
    from room_members
    where room_id in (select room_id from filtered_rooms)
    group by room_id
  ),
  latest_message_time as (
    select room_id, max(created_at) as last_created_at
    from message_records
    where room_id in (select room_id from filtered_rooms)
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
    fr.room_id,
    fr.room_name,
    fr.room_description,
    fr.room_rule,
    fr.required_subscription_product_id,
    fr.owner_id,
    fr.visibility,
    fr.join_policy,
    fr.max_members,
    fr.created_at,
    coalesce(mc.member_count, 0) as member_count,
    lm.last_message_preview,
    lm.last_message_at,
    lm.last_sender_id,
    lm.last_sender_name
  from filtered_rooms fr
  left join member_counts mc on mc.room_id = fr.room_id
  left join latest_message lm on lm.room_id = fr.room_id
  order by
    case when p_sort = 'members' then coalesce(mc.member_count, 0) end desc,
    case when p_sort = 'activity' then lm.last_message_at end desc nulls last,
    fr.created_at desc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
