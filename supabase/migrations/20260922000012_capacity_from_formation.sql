-- Capacity is an OUTPUT of the design, not an input asked at creation.
--   surface (perimeter/formation area) → design sized to fit → pixel count → registration capacity.
-- • events.capacity is NULL until decided ("to be set by the formation").
-- • Opening registration requires a capacity (explicit target, or taken from a saved formation).
-- • Formations are limited by the plan, no longer by a capacity typed in advance.
-- • Locking a formation sets capacity = its pixel count; while a formation is locked, capacity
--   follows it and cannot be edited by hand.

alter table public.events alter column capacity drop not null, alter column capacity drop default;

create or replace function public.create_event(
  p_org_id uuid,
  p_name text,
  p_starts_at timestamptz default null,
  p_timezone text default 'UTC',
  p_capacity int default null,
  p_venue_name text default null,
  p_center_lat double precision default null,
  p_center_lng double precision default null
) returns public.events
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  v_sub public.organization_subscriptions;
  v_active int;
  v_code text;
  v_event public.events;
begin
  if not public.hp_has_org_role(p_org_id, 'admin') then perform public.hp_forbid(); end if;
  select * into v_sub from public.organization_subscriptions where org_id = p_org_id;
  if v_sub.status is distinct from 'active' and not public.hp_is_admin() then
    raise exception 'SUBSCRIPTION_INACTIVE' using errcode = 'P0001';
  end if;
  if p_capacity is not null and p_capacity > v_sub.max_participants_per_event and not public.hp_is_admin() then
    raise exception 'PLAN_LIMIT_CAPACITY: plan allows % participants per event', v_sub.max_participants_per_event using errcode = 'P0001';
  end if;
  select count(*) into v_active from public.events where org_id = p_org_id and state not in ('COMPLETED', 'CANCELLED');
  if v_active >= v_sub.max_active_events and not public.hp_is_admin() then
    raise exception 'PLAN_LIMIT_EVENTS: plan allows % active events', v_sub.max_active_events using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'INVALID_TIMEZONE' using errcode = 'P0001';
  end if;
  loop
    v_code := public.hp_random_code(8);
    exit when not exists (select 1 from public.events where join_code = v_code);
  end loop;
  insert into public.events (org_id, name, slug, join_code, starts_at, timezone, capacity, venue_name, center_lat, center_lng, created_by)
  values (
    p_org_id, trim(p_name),
    left(coalesce(nullif(public.hp_slugify(p_name), ''), 'event'), 60) || '-' || lower(public.hp_random_code(4)),
    v_code, p_starts_at, p_timezone, p_capacity, p_venue_name, p_center_lat, p_center_lng, v_uid
  ) returning * into v_event;
  insert into public.event_counters (event_id) values (v_event.id);
  insert into public.event_state_history (event_id, from_state, to_state, actor_id, reason)
  values (v_event.id, null, 'DRAFT', v_uid, 'created');
  perform public.hp_audit('event.create', p_org_id, v_event.id, 'event', v_event.id::text, jsonb_build_object('name', v_event.name));
  return v_event;
end;
$$;

-- Capacity rules that hold whoever writes the row (console, SQL editor, RPCs).
create or replace function public.hp_guard_capacity() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.capacity is distinct from old.capacity and not public.hp_is_internal() then
    if new.active_formation_id is not null then
      raise exception 'CAPACITY_FROM_FORMATION: capacity follows the locked formation' using errcode = 'P0001';
    end if;
    if new.capacity is null and new.state <> 'DRAFT' then
      raise exception 'CAPACITY_REQUIRED: registration is open, capacity cannot be cleared' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists hp_guard_capacity on public.events;
create trigger hp_guard_capacity before update on public.events
  for each row execute function public.hp_guard_capacity();
revoke all on function public.hp_guard_capacity() from public, anon, authenticated;

-- Precondition: nobody can register into an event without a capacity.
create or replace function public.hp_require_capacity_to_open() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.state = 'REGISTRATION_OPEN' and old.state is distinct from new.state and new.capacity is null then
    raise exception 'PRECONDITION_CAPACITY: generate the formation (or set a target capacity) before opening registration' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists hp_require_capacity_to_open on public.events;
create trigger hp_require_capacity_to_open before update of state on public.events
  for each row execute function public.hp_require_capacity_to_open();
revoke all on function public.hp_require_capacity_to_open() from public, anon, authenticated;

-- Formations are bounded by the plan, not by a number guessed before the design existed.
create or replace function public.formation_create(
  p_event_id uuid,
  p_source jsonb,
  p_params jsonb,
  p_point_count int,
  p_seed bigint,
  p_engine_version text,
  p_metrics jsonb,
  p_warnings jsonb,
  p_zones jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  e public.events;
  v_max int;
  v_id uuid;
  v_version int;
begin
  if not public.hp_can_manage_event(p_event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = p_event_id;
  if e.state not in ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EVENT_PREPARATION') then
    raise exception 'FORMATION_FROZEN' using errcode = 'P0001';
  end if;
  if p_point_count is null or p_point_count < 1 or p_point_count > 250000 then
    raise exception 'INVALID_POINT_COUNT' using errcode = 'P0001';
  end if;
  select s.max_participants_per_event into v_max from public.organization_subscriptions s where s.org_id = e.org_id;
  if p_point_count > coalesce(v_max, 0) and not public.hp_is_admin() then
    raise exception 'PLAN_LIMIT_CAPACITY: % pixels, plan allows % participants per event', p_point_count, coalesce(v_max, 0) using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_zones) <> 'array' or jsonb_array_length(p_zones) = 0 or jsonb_array_length(p_zones) > 52 then
    raise exception 'INVALID_ZONES' using errcode = 'P0001';
  end if;
  -- Serialize version allocation per event.
  perform 1 from public.events where id = p_event_id for update;
  select coalesce(max(version), 0) + 1 into v_version from public.formations where event_id = p_event_id;
  insert into public.formations (event_id, version, source, params, engine_version, seed, point_count, metrics, warnings, created_by)
  values (p_event_id, v_version, p_source, p_params, p_engine_version, p_seed, p_point_count,
          coalesce(p_metrics, '{}'::jsonb), coalesce(p_warnings, '[]'::jsonb), v_uid)
  returning id into v_id;
  insert into public.formation_zones (formation_id, zone, label, point_count, centroid_lat, centroid_lng)
  select v_id, (z ->> 'zone')::smallint, z ->> 'label', (z ->> 'count')::int, (z ->> 'lat')::float8, (z ->> 'lng')::float8
  from jsonb_array_elements(p_zones) z;
  perform public.hp_audit('formation.create', e.org_id, e.id, 'formation', v_id::text,
    jsonb_build_object('version', v_version, 'points', p_point_count));
  return v_id;
end;
$$;

-- Locking makes the formation the capacity. Wraps the existing lock (assignment logic unchanged).
alter function public.formation_lock(uuid) rename to hp_formation_lock_assign;
revoke all on function public.hp_formation_lock_assign(uuid) from public, anon, authenticated;

create or replace function public.formation_lock(p_formation_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
  f public.formations;
begin
  v_result := public.hp_formation_lock_assign(p_formation_id); -- authorization + validation inside
  select * into f from public.formations where id = p_formation_id;
  perform public.hp_internal();
  update public.events set capacity = f.point_count where id = f.event_id and capacity is distinct from f.point_count;
  return v_result || jsonb_build_object('capacity', f.point_count);
end;
$$;
revoke all on function public.formation_lock(uuid) from public, anon;
grant execute on function public.formation_lock(uuid) to authenticated;

-- Organizer shortcut before locking: adopt a validated version's pixel count as the target capacity.
create or replace function public.set_capacity_from_formation(p_formation_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  f public.formations;
begin
  select * into f from public.formations where id = p_formation_id;
  if not found or not public.hp_can_manage_event(f.event_id) then perform public.hp_forbid(); end if;
  if f.status not in ('ready', 'locked') then
    raise exception 'FORMATION_NOT_READY: formation must pass validation first' using errcode = 'P0001';
  end if;
  update public.events set capacity = f.point_count where id = f.event_id; -- guards + plan limit apply
  return f.point_count;
end;
$$;
revoke all on function public.set_capacity_from_formation(uuid) from public, anon;
grant execute on function public.set_capacity_from_formation(uuid) to authenticated;
