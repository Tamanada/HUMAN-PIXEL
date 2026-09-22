-- Briefing content, pickup-point fields, balanced assignment and the participant-facing API.

alter table public.events add column if not exists briefing jsonb not null default '{}'::jsonb;
alter table public.event_areas
  add column if not exists capacity int check (capacity is null or capacity between 1 and 1000000),
  add column if not exists opens_at timestamptz,
  add column if not exists closes_at timestamptz,
  add column if not exists details text check (details is null or char_length(details) <= 2000);
alter table public.event_members add column if not exists pickup_area_id uuid references public.event_areas (id) on delete set null;
create index if not exists event_members_pickup_idx on public.event_members (pickup_area_id) where pickup_area_id is not null;

grant update (briefing) on public.events to authenticated;
grant insert (capacity, opens_at, closes_at, details) on public.event_areas to authenticated;
grant update (capacity, opens_at, closes_at, details) on public.event_areas to authenticated;

create or replace function public.get_event_areas(p_event_id uuid) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'event_id', a.event_id, 'kind', a.kind, 'name', a.name, 'symbol', a.symbol,
    'geom', st_asgeojson(a.geom, 8)::jsonb, 'safety_buffer_m', a.safety_buffer_m, 'is_public', a.is_public,
    'capacity', a.capacity, 'opens_at', a.opens_at, 'closes_at', a.closes_at, 'details', a.details,
    'assigned', (select count(*) from public.event_members m where m.pickup_area_id = a.id and m.status = 'registered'),
    'area_m2', case when a.kind not in ('access_point', 'collection', 'control', 'bounty') then round(st_area(a.geom::geography)) end
  ) order by a.kind, a.created_at), '[]'::jsonb)
  from public.event_areas a where a.event_id = p_event_id;
$$;

drop function if exists public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid, text);

create function public.save_event_area(
  p_event_id uuid, p_kind public.area_kind, p_geojson jsonb, p_name text default null,
  p_safety_buffer_m real default 0, p_is_public boolean default null, p_area_id uuid default null,
  p_symbol text default null, p_capacity int default null, p_opens_at timestamptz default null,
  p_closes_at timestamptz default null, p_details text default null
) returns uuid
language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_geom extensions.geometry := st_setsrid(st_geomfromgeojson(p_geojson::text), 4326);
  v_polys extensions.geometry;
  v_best extensions.geometry;
  v_id uuid;
begin
  if geometrytype(v_geom) <> 'POINT' then
    if geometrytype(v_geom) not in ('POLYGON', 'MULTIPOLYGON') then
      raise exception 'INVALID_GEOMETRY: draw a closed shape (at least 3 corners)' using errcode = 'P0001';
    end if;
    if not st_isvalid(v_geom) then
      v_polys := st_collectionextract(st_makevalid(v_geom), 3);
      if st_isempty(v_polys) then
        raise exception 'INVALID_GEOMETRY: the outline has no area' using errcode = 'P0001';
      end if;
      select d.geom into v_best from st_dump(v_polys) d order by st_area(d.geom) desc limit 1;
      if st_area(v_best) < 0.9 * st_area(v_polys) then
        raise exception 'INVALID_GEOMETRY: the outline crosses itself; go around the zone once, in one direction' using errcode = 'P0001';
      end if;
      v_geom := v_best;
    end if;
    if st_area(v_geom::geography) < 1 then
      raise exception 'INVALID_GEOMETRY: the shape is too small' using errcode = 'P0001';
    end if;
  end if;
  if p_area_id is null then
    insert into public.event_areas (event_id, kind, name, geom, safety_buffer_m, is_public, symbol, capacity, opens_at, closes_at, details)
    values (p_event_id, p_kind, p_name, v_geom, coalesce(p_safety_buffer_m, 0),
            coalesce(p_is_public, p_kind not in ('formation_area', 'exclusion')), p_symbol,
            p_capacity, p_opens_at, p_closes_at, p_details)
    returning id into v_id;
  else
    update public.event_areas
       set name = p_name, geom = v_geom, safety_buffer_m = coalesce(p_safety_buffer_m, 0),
           is_public = coalesce(p_is_public, is_public), symbol = p_symbol,
           capacity = p_capacity, opens_at = p_opens_at, closes_at = p_closes_at, details = p_details
     where id = p_area_id and event_id = p_event_id
    returning id into v_id;
    if v_id is null then raise exception 'AREA_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid, text, int, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid, text, int, timestamptz, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Balanced pickup assignment: the emptiest point that still has room. Ratios (not raw counts) so
-- a small point next to a big one is not swamped; ties broken at random to spread simultaneous
-- joins. Runs inside join_event, so a participant always leaves with their point.
create or replace function public.hp_assign_pickup(p_member_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
  v_area uuid;
begin
  select event_id into v_event from public.event_members where id = p_member_id;
  select a.id into v_area
  from public.event_areas a
  left join lateral (
    select count(*) n from public.event_members m where m.pickup_area_id = a.id and m.status <> 'cancelled'
  ) c on true
  where a.event_id = v_event and a.kind = 'collection'
    and (a.capacity is null or c.n < a.capacity)
  order by c.n::numeric / coalesce(a.capacity, 1000000)::numeric, random()
  limit 1;
  if v_area is not null then
    update public.event_members set pickup_area_id = v_area where id = p_member_id;
  end if;
  return v_area;
end;
$$;
revoke all on function public.hp_assign_pickup(uuid) from public, anon, authenticated;

-- Organizer tools: move one person, or (re)spread everybody after adding or resizing points.
create or replace function public.set_member_pickup(p_member_id uuid, p_area_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
begin
  select event_id into v_event from public.event_members where id = p_member_id;
  if v_event is null or not public.hp_can_manage_event(v_event) then perform public.hp_forbid(); end if;
  if p_area_id is not null and not exists (
    select 1 from public.event_areas a where a.id = p_area_id and a.event_id = v_event and a.kind = 'collection'
  ) then
    raise exception 'AREA_NOT_FOUND' using errcode = 'P0002';
  end if;
  update public.event_members set pickup_area_id = p_area_id where id = p_member_id;
  perform public.hp_audit('member.pickup', null, v_event, 'member', p_member_id::text, jsonb_build_object('area', p_area_id));
end;
$$;
revoke all on function public.set_member_pickup(uuid, uuid) from public, anon;
grant execute on function public.set_member_pickup(uuid, uuid) to authenticated;

create or replace function public.rebalance_pickups(p_event_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_points int;
  v_moved int := 0;
begin
  if not public.hp_can_manage_event(p_event_id) then perform public.hp_forbid(); end if;
  select count(*) into v_points from public.event_areas where event_id = p_event_id and kind = 'collection';
  if v_points = 0 then
    update public.event_members set pickup_area_id = null where event_id = p_event_id and pickup_area_id is not null;
    return jsonb_build_object('points', 0, 'assigned', 0);
  end if;
  -- Deal members round-robin over the points, each point taking its share of the crowd.
  with points as (
    select a.id, coalesce(a.capacity, 1000000) cap, row_number() over (order by a.created_at) rn, count(*) over () n
    from public.event_areas a where a.event_id = p_event_id and a.kind = 'collection'
  ), members as (
    select m.id, row_number() over (order by m.participant_number) rn
    from public.event_members m where m.event_id = p_event_id and m.status <> 'cancelled'
  ), deal as (
    select m.id member_id, p.id area_id
    from members m join points p on p.rn = 1 + ((m.rn - 1) % (select n from points limit 1))
  ), upd as (
    update public.event_members m set pickup_area_id = d.area_id
    from deal d where m.id = d.member_id and m.pickup_area_id is distinct from d.area_id
    returning 1
  )
  select count(*) into v_moved from upd;
  perform public.hp_audit('event.rebalance_pickups', null, p_event_id, 'event', p_event_id::text, jsonb_build_object('moved', v_moved));
  return jsonb_build_object('points', v_points, 'moved', v_moved);
end;
$$;
revoke all on function public.rebalance_pickups(uuid) from public, anon;
grant execute on function public.rebalance_pickups(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Participant API: the briefing before joining, and the personal pickup point afterwards.
create or replace function public.get_event_preview(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'eventId', e.id,
    'name', e.name,
    'state', e.state,
    'venueName', e.venue_name,
    'startsAt', e.starts_at,
    'timezone', e.timezone,
    'registrationOpen', e.state = 'REGISTRATION_OPEN'
       or (e.allow_late_registration and e.state in ('EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION', 'POSITIONING')),
    'allowAnonymousJoin', e.allow_anonymous_join,
    'consentVersion', e.consent_version,
    'briefing', e.briefing
  )
  from public.events e
  join public.organizations o on o.id = e.org_id and o.status = 'active'
  where e.join_code = upper(trim(p_code)) and e.state <> 'DRAFT';
$$;

create or replace function public.get_my_assignment(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public.hp_require_user();
  e public.events;
  m public.event_members;
  s public.participant_status;
  p public.formation_points;
  v_zone text;
  v_released boolean;
  v_areas jsonb;
  v_total int;
  v_pickup jsonb;
begin
  select * into e from public.events where id = p_event_id;
  select * into m from public.event_members where event_id = p_event_id and user_id = v_uid;
  if e.id is null or m.id is null then
    raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0002';
  end if;
  select * into s from public.participant_status where member_id = m.id;
  if e.active_formation_id is not null and m.status = 'registered' then
    select * into p from public.formation_points where formation_id = e.active_formation_id and member_id = m.id;
    select label into v_zone from public.formation_zones where formation_id = p.formation_id and zone = p.zone;
  end if;
  v_released := e.state in ('PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY', 'LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING')
             or (e.positions_release_at is not null and now() >= e.positions_release_at and e.state not in ('CANCELLED', 'COMPLETED', 'PHOTO_RELEASED'));
  select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'name', a.name, 'geometry', st_asgeojson(a.geom, 7)::jsonb)), '[]'::jsonb)
    into v_areas
  from public.event_areas a
  where a.event_id = e.id and a.is_public and a.kind <> 'formation_area';
  select registered into v_total from public.event_counters where event_id = e.id;
  -- The one pickup point this person must go to (plus any control / bounty point, same for all).
  select jsonb_build_object(
      'id', a.id, 'name', a.name, 'kind', a.kind, 'details', a.details,
      'opens_at', a.opens_at, 'closes_at', a.closes_at,
      'lat', st_y(a.geom::extensions.geometry), 'lng', st_x(a.geom::extensions.geometry))
    into v_pickup
  from public.event_areas a where a.id = m.pickup_area_id;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', e.id,
      'name', e.name,
      'state', e.state,
      'timezone', e.timezone,
      'starts_at', e.starts_at,
      'arrival_deadline', e.arrival_deadline,
      'positions_release_at', e.positions_release_at,
      'venue_name', e.venue_name,
      'center', case when e.center_lat is null then null else jsonb_build_object('lat', e.center_lat, 'lng', e.center_lng) end,
      'tolerance_radius_m', e.tolerance_radius_m,
      'required_accuracy_m', e.required_accuracy_m,
      'countdown', e.countdown,
      'share_message', e.share_message,
      'hashtags', to_jsonb(e.hashtags),
      'briefing', e.briefing,
      'manifest_version', e.manifest_version,
      'assignment_epoch', e.assignment_epoch,
      'participant_total', coalesce(v_total, 0)
    ),
    'member', jsonb_build_object(
      'id', m.id,
      'participant_number', m.participant_number,
      'status', m.status,
      'state', coalesce(s.state, 'JOINED'),
      'last_seq', coalesce(s.last_seq, 0)
    ),
    'pixel', case when p.idx is null then null else jsonb_build_object(
      'label', p.label,
      'zone', coalesce(v_zone, '?'),
      'released', v_released,
      'target', case when v_released then jsonb_build_object('lat', p.lat, 'lng', p.lng) else null end
    ) end,
    'pickup', v_pickup,
    'areas', v_areas,
    'server_time', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;
