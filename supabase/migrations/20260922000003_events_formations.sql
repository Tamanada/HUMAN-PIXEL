-- HUMAN PIXEL: organizations, events, state machine, formation upload/validation/lock.

-- ---------------------------------------------------------------------------------------------
-- Codes
-- ---------------------------------------------------------------------------------------------
-- Unambiguous alphabet (no 0/O, 1/I/L) for codes read aloud on a beach.
create or replace function public.hp_random_code(p_len int) returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(p_len);
  out text := '';
begin
  for i in 0 .. p_len - 1 loop
    out := out || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return out;
end;
$$;

create or replace function public.hp_slugify(p text) returns text
language sql immutable as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g'));
$$;

-- ---------------------------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_organization(p_name text, p_contact_email text default null)
returns public.organizations
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  v_org public.organizations;
  v_plan jsonb := coalesce(public.hp_setting('default_plan'), '{}'::jsonb);
  v_slug text := left(public.hp_slugify(p_name), 48);
begin
  if not public.hp_rate_limit('org:' || v_uid, 5, interval '1 hour') then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  if length(v_slug) < 3 then v_slug := 'org'; end if;
  v_slug := v_slug || '-' || lower(public.hp_random_code(5));
  insert into public.organizations (name, slug, contact_email, created_by)
  values (trim(p_name), v_slug, nullif(trim(p_contact_email), ''), v_uid)
  returning * into v_org;
  insert into public.organization_members (org_id, user_id, role) values (v_org.id, v_uid, 'owner');
  insert into public.organization_subscriptions (org_id, plan, max_participants_per_event, max_active_events)
  values (
    v_org.id,
    coalesce(v_plan ->> 'plan', 'free'),
    coalesce((v_plan ->> 'max_participants_per_event')::int, 1000),
    coalesce((v_plan ->> 'max_active_events')::int, 1)
  );
  perform public.hp_audit('organization.create', v_org.id, null, 'organization', v_org.id::text, jsonb_build_object('name', v_org.name));
  return v_org;
end;
$$;

create or replace function public.add_organization_member(p_org_id uuid, p_email text, p_role public.org_role default 'member')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_target uuid;
begin
  perform public.hp_require_user();
  if not public.hp_has_org_role(p_org_id, 'admin') then perform public.hp_forbid(); end if;
  if p_role = 'owner' and not public.hp_has_org_role(p_org_id, 'owner') then perform public.hp_forbid(); end if;
  select id into v_target from auth.users where lower(email) = lower(trim(p_email));
  if v_target is null then
    raise exception 'USER_NOT_FOUND: the person must sign in to HUMAN PIXEL once before being added' using errcode = 'P0001';
  end if;
  insert into public.organization_members (org_id, user_id, role) values (p_org_id, v_target, p_role)
  on conflict (org_id, user_id) do update set role = excluded.role;
  perform public.hp_audit('organization.member_set', p_org_id, null, 'user', v_target::text, jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.remove_organization_member(p_org_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.hp_require_user();
  if not public.hp_has_org_role(p_org_id, 'admin') then perform public.hp_forbid(); end if;
  if (select role from public.organization_members where org_id = p_org_id and user_id = p_user_id) = 'owner'
     and (select count(*) from public.organization_members where org_id = p_org_id and role = 'owner') <= 1 then
    raise exception 'LAST_OWNER' using errcode = 'P0001';
  end if;
  delete from public.organization_members where org_id = p_org_id and user_id = p_user_id;
  perform public.hp_audit('organization.member_remove', p_org_id, null, 'user', p_user_id::text);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_event(
  p_org_id uuid,
  p_name text,
  p_starts_at timestamptz default null,
  p_timezone text default 'UTC',
  p_capacity int default 1000,
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
  if p_capacity > v_sub.max_participants_per_event and not public.hp_is_admin() then
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

create or replace function public.regenerate_join_code(p_event_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_org uuid;
begin
  perform public.hp_require_user();
  if not public.hp_can_manage_event(p_event_id) then perform public.hp_forbid(); end if;
  loop
    v_code := public.hp_random_code(8);
    exit when not exists (select 1 from public.events where join_code = v_code);
  end loop;
  perform public.hp_internal();
  update public.events set join_code = v_code where id = p_event_id returning org_id into v_org;
  perform public.hp_audit('event.join_code_regenerated', v_org, p_event_id, 'event', p_event_id::text);
  return v_code;
end;
$$;

-- Core transition logic, used by organizers (transition_event) and by the scheduler (system).
create or replace function public.hp_transition_event(
  p_event_id uuid, p_to public.event_state, p_actor uuid, p_reason text, p_system boolean
) returns public.events
language plpgsql security definer set search_path = public, extensions as $$
declare
  e public.events;
  v_from public.event_state;
  v_org_status public.org_status;
  v_counts jsonb;
begin
  select * into e from public.events where id = p_event_id for update;
  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_from := e.state;
  if e.state = p_to then
    return e; -- idempotent
  end if;
  if not exists (select 1 from public.event_state_transitions where from_state = e.state and to_state = p_to) then
    raise exception 'ILLEGAL_TRANSITION % -> %', e.state, p_to using errcode = 'P0001';
  end if;

  -- Preconditions
  if p_to = 'REGISTRATION_OPEN' then
    select status into v_org_status from public.organizations where id = e.org_id;
    if v_org_status <> 'active' then raise exception 'ORGANIZATION_SUSPENDED' using errcode = 'P0001'; end if;
    if e.starts_at is null or e.starts_at <= now() then
      raise exception 'PRECONDITION_START_TIME: set a future formation start time' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.event_areas where event_id = e.id and kind = 'perimeter') then
      raise exception 'PRECONDITION_PERIMETER: draw the event perimeter first' using errcode = 'P0001';
    end if;
  elsif p_to = 'EVENT_PREPARATION' then
    if e.active_formation_id is null then
      raise exception 'PRECONDITION_FORMATION: lock a formation first' using errcode = 'P0001';
    end if;
  elsif p_to = 'PHOTO_RELEASED' then
    if not exists (select 1 from public.event_photos where event_id = e.id and is_primary and status in ('ready', 'released')) then
      raise exception 'PRECONDITION_PHOTO: upload and select the official photo first' using errcode = 'P0001';
    end if;
  end if;

  perform public.hp_internal();
  update public.events set
    state = p_to,
    positions_release_at = case
      when p_to = 'PARTICIPANT_NAVIGATION' and (positions_release_at is null or positions_release_at > now()) then now()
      else positions_release_at end,
    live_at = case when p_to = 'LIVE' then now() else live_at end,
    completed_at = case when p_to = 'COMPLETED' then now() else completed_at end,
    cancelled_at = case when p_to = 'CANCELLED' then now() else cancelled_at end
  where id = e.id
  returning * into e;

  if p_to = 'PHOTO_RELEASED' then
    update public.event_photos set status = 'released', released_at = now()
    where event_id = e.id and is_primary and status = 'ready';
  end if;

  if p_to = 'LIVE' then
    -- Official attendance at the moment of the formation: evidence for record submissions.
    v_counts := public.hp_event_counts(e.id);
    insert into public.event_stat_snapshots (event_id, at, state, counts) values (e.id, now(), 'LIVE', v_counts)
    on conflict do nothing;
  end if;

  insert into public.event_state_history (event_id, from_state, to_state, actor_id, is_system, reason)
  values (e.id, v_from, p_to, p_actor, p_system, p_reason);
  insert into public.audit_logs (actor_id, org_id, event_id, action, target_type, target_id, details)
  values (p_actor, e.org_id, e.id, 'event.transition', 'event', e.id::text,
          jsonb_build_object('to', p_to, 'reason', p_reason, 'system', p_system));
  return e;
end;
$$;

create or replace function public.transition_event(p_event_id uuid, p_to public.event_state, p_reason text default null)
returns public.events
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
begin
  if not public.hp_can_manage_event(p_event_id) then perform public.hp_forbid(); end if;
  return public.hp_transition_event(p_event_id, p_to, v_uid, p_reason, false);
end;
$$;

-- Public, cache-safe manifest. NOTHING secret: no formation, no points, no members.
create or replace function public.get_event_manifest(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'schema', 1,
    'eventId', e.id,
    'version', e.manifest_version,
    'assignmentEpoch', e.assignment_epoch,
    'name', e.name,
    'state', e.state,
    'timezone', e.timezone,
    'startsAt', to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'arrivalDeadline', to_char(e.arrival_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'positionsReleaseAt', to_char(e.positions_release_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'venueName', e.venue_name,
    'announcement', e.announcement,
    'photoReleased', e.state in ('PHOTO_RELEASED', 'COMPLETED'),
    'countdown', e.countdown,
    'allowAnonymousJoin', e.allow_anonymous_join,
    'publishedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  from public.events e
  where e.id = p_event_id and e.state <> 'DRAFT';
$$;

-- ---------------------------------------------------------------------------------------------
-- Formations
-- ---------------------------------------------------------------------------------------------
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
  v_id uuid;
  v_version int;
begin
  if not public.hp_can_manage_event(p_event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = p_event_id;
  if e.state not in ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EVENT_PREPARATION') then
    raise exception 'FORMATION_FROZEN' using errcode = 'P0001';
  end if;
  if p_point_count > e.capacity then
    raise exception 'FORMATION_EXCEEDS_CAPACITY: % points > capacity %', p_point_count, e.capacity using errcode = 'P0001';
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

-- Chunked, idempotent upload: rows are [idx, lat, lng, x, y, zone, fill_rank, label].
create or replace function public.formation_upload_points(p_formation_id uuid, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  f public.formations;
  v_n int;
begin
  perform public.hp_require_user();
  select * into f from public.formations where id = p_formation_id;
  if not found or not public.hp_can_manage_event(f.event_id) then perform public.hp_forbid(); end if;
  if f.status <> 'uploading' then
    raise exception 'FORMATION_NOT_UPLOADING' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10000 then
    raise exception 'CHUNK_TOO_LARGE: max 10000 rows per chunk' using errcode = 'P0001';
  end if;
  insert into public.formation_points (formation_id, idx, lat, lng, x_m, y_m, zone, fill_rank, label, shuffle_key)
  select p_formation_id,
         (r ->> 0)::int, (r ->> 1)::float8, (r ->> 2)::float8, (r ->> 3)::real, (r ->> 4)::real,
         (r ->> 5)::smallint, (r ->> 6)::int, (r ->> 7)::int,
         (hashtextextended(p_formation_id::text || ':' || (r ->> 0), f.seed) >> 32)::int
  from jsonb_array_elements(p_rows) r
  on conflict (formation_id, idx) do update set
    lat = excluded.lat, lng = excluded.lng, x_m = excluded.x_m, y_m = excluded.y_m,
    zone = excluded.zone, fill_rank = excluded.fill_rank, label = excluded.label;
  get diagnostics v_n = row_count;
  update public.formations set uploaded_count = (select count(*) from public.formation_points where formation_id = p_formation_id)
  where id = p_formation_id;
  return v_n;
end;
$$;

-- Server-side validation. The client generated the points; the database decides if they are safe.
create or replace function public.formation_finalize(p_formation_id uuid, p_checksum bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  f public.formations;
  v_count int;
  v_min_idx int; v_max_idx int;
  v_min_label int; v_max_label int;
  v_min_rank int; v_max_rank int;
  v_checksum bigint;
  v_outside int := 0;
  v_outside_area int := 0;
  v_excluded int := 0;
  v_too_close int := 0;
  v_min_spacing float8;
  v_zone_bad int;
  v_ok boolean;
  v_report jsonb;
begin
  perform public.hp_require_user();
  select * into f from public.formations where id = p_formation_id for update;
  if not found or not public.hp_can_manage_event(f.event_id) then perform public.hp_forbid(); end if;
  if f.status <> 'uploading' then
    raise exception 'FORMATION_NOT_UPLOADING' using errcode = 'P0001';
  end if;

  select count(*), min(idx), max(idx), min(label), max(label), min(fill_rank), max(fill_rank),
         coalesce(sum(((idx + 1)::bigint * label) % 2147483647) % 2147483647, 0)
    into v_count, v_min_idx, v_max_idx, v_min_label, v_max_label, v_min_rank, v_max_rank, v_checksum
  from public.formation_points where formation_id = p_formation_id;

  select count(*) into v_zone_bad from public.formation_points p
  where p.formation_id = p_formation_id
    and not exists (select 1 from public.formation_zones z where z.formation_id = p_formation_id and z.zone = p.zone);

  -- Geometry checks with a 5 cm / 2% tolerance for planar-vs-geodesic differences.
  create temporary table _hp_pts on commit drop as
    select idx, st_setsrid(st_makepoint(lng, lat), 4326) as g
    from public.formation_points where formation_id = p_formation_id;
  create index on _hp_pts using gist (g);
  create index on _hp_pts using gist ((g::geography));
  analyze _hp_pts;

  select count(*) into v_outside from _hp_pts p
  where not exists (
    select 1 from public.event_areas a
    where a.event_id = f.event_id and a.kind = 'perimeter' and st_covers(a.geom, p.g)
  );
  if exists (select 1 from public.event_areas where event_id = f.event_id and kind = 'formation_area') then
    select count(*) into v_outside_area from _hp_pts p
    where not exists (
      select 1 from public.event_areas a
      where a.event_id = f.event_id and a.kind = 'formation_area' and st_covers(a.geom, p.g)
    );
  end if;
  select count(distinct p.idx) into v_excluded from _hp_pts p
  join public.event_areas a on a.event_id = f.event_id and a.kind in ('exclusion', 'no_go', 'emergency')
  where st_dwithin(a.geom::geography, p.g::geography, greatest(0, a.safety_buffer_m * 0.98 - 0.05))
     or st_intersects(a.geom, p.g);

  v_min_spacing := coalesce((f.params ->> 'minSpacingM')::float8, 0.9);
  select count(*) into v_too_close from _hp_pts a
  join _hp_pts b on a.idx < b.idx and st_dwithin(a.g::geography, b.g::geography, v_min_spacing * 0.95);

  v_ok := v_count = f.point_count
      and v_min_idx = 0 and v_max_idx = f.point_count - 1
      and v_min_label = 1 and v_max_label = f.point_count
      and v_min_rank = 0 and v_max_rank = f.point_count - 1
      and v_checksum = p_checksum
      and v_zone_bad = 0
      and v_outside = 0 and v_outside_area = 0 and v_excluded = 0 and v_too_close = 0;

  v_report := jsonb_build_object(
    'ok', v_ok,
    'count', v_count,
    'expected', f.point_count,
    'checksum_ok', v_checksum = p_checksum,
    'index_ok', v_min_idx = 0 and v_max_idx = f.point_count - 1 and v_count = f.point_count,
    'labels_ok', v_min_label = 1 and v_max_label = f.point_count,
    'ranks_ok', v_min_rank = 0 and v_max_rank = f.point_count - 1,
    'unknown_zone', v_zone_bad,
    'outside_perimeter', v_outside,
    'outside_formation_area', v_outside_area,
    'inside_exclusions', v_excluded,
    'spacing_violations', v_too_close,
    'min_spacing_m', v_min_spacing,
    'validated_at', now()
  );
  update public.formations
     set status = case when v_ok then 'ready'::public.formation_status else 'rejected'::public.formation_status end,
         validation = v_report, validated_at = now(), checksum = p_checksum
   where id = p_formation_id;
  perform public.hp_audit('formation.validate', (select org_id from public.events where id = f.event_id), f.event_id,
    'formation', f.id::text, v_report);
  return v_report;
end;
$$;

-- Organizer read of their own points (compact columnar JSON; ~2 MB for 50k).
create or replace function public.get_formation_points(p_formation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_event uuid;
  v jsonb;
begin
  select event_id into v_event from public.formations where id = p_formation_id;
  if v_event is null or not public.hp_can_view_event(v_event) then perform public.hp_forbid(); end if;
  select jsonb_build_object(
    'idx', coalesce(jsonb_agg(idx order by idx), '[]'),
    'lat', coalesce(jsonb_agg(lat order by idx), '[]'),
    'lng', coalesce(jsonb_agg(lng order by idx), '[]'),
    'x', coalesce(jsonb_agg(x_m order by idx), '[]'),
    'y', coalesce(jsonb_agg(y_m order by idx), '[]'),
    'zone', coalesce(jsonb_agg(zone order by idx), '[]'),
    'rank', coalesce(jsonb_agg(fill_rank order by idx), '[]')
  ) into v from public.formation_points where formation_id = p_formation_id;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Assignment core (internal)
-- ---------------------------------------------------------------------------------------------
-- Claims one free point for a member. Concurrency-safe: FOR UPDATE SKIP LOCKED over the partial
-- free-pool index, and the UNIQUE(member_id) index as the final guarantee. Returns idx or NULL.
create or replace function public.hp_assign_member(p_member_id uuid, p_action public.assignment_action, p_reason text)
returns int
language plpgsql security definer set search_path = public as $$
declare
  m public.event_members;
  e public.events;
  v_idx int;
begin
  select * into m from public.event_members where id = p_member_id;
  select * into e from public.events where id = m.event_id;
  if e.active_formation_id is null or m.status not in ('registered', 'waitlisted') then
    return null;
  end if;
  select idx into v_idx from public.formation_points
   where formation_id = e.active_formation_id and member_id = p_member_id;
  if v_idx is not null then
    return v_idx; -- already holds a point (idempotent)
  end if;

  if m.group_id is not null then
    select idx into v_idx from public.formation_points
     where formation_id = e.active_formation_id and reserved_group_id = m.group_id and member_id is null
     order by fill_rank limit 1 for update skip locked;
  end if;
  if v_idx is null then
    if e.allocation_mode = 'random' then
      select idx into v_idx from public.formation_points
       where formation_id = e.active_formation_id and member_id is null and reserved_group_id is null
       order by shuffle_key limit 1 for update skip locked;
    elsif e.allocation_mode = 'sequential' then
      select idx into v_idx from public.formation_points
       where formation_id = e.active_formation_id and member_id is null and reserved_group_id is null
       order by idx limit 1 for update skip locked;
    else
      select idx into v_idx from public.formation_points
       where formation_id = e.active_formation_id and member_id is null and reserved_group_id is null
       order by fill_rank limit 1 for update skip locked;
    end if;
  end if;
  if v_idx is null then
    return null;
  end if;
  update public.formation_points set member_id = p_member_id, assigned_at = now()
   where formation_id = e.active_formation_id and idx = v_idx;
  if m.status = 'waitlisted' then
    update public.event_members set status = 'registered' where id = p_member_id;
  end if;
  insert into public.assignment_log (event_id, formation_id, point_idx, member_id, action, reason, actor_id)
  values (e.id, e.active_formation_id, v_idx, p_member_id, p_action, p_reason, auth.uid());
  return v_idx;
end;
$$;

create or replace function public.hp_release_member(p_member_id uuid, p_action public.assignment_action, p_reason text)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_idx int;
  v_formation uuid;
  v_event uuid;
begin
  update public.formation_points set member_id = null, assigned_at = null
   where member_id = p_member_id
  returning idx, formation_id into v_idx, v_formation;
  if v_idx is not null then
    select event_id into v_event from public.formations where id = v_formation;
    insert into public.assignment_log (event_id, formation_id, point_idx, member_id, action, reason, actor_id)
    values (v_event, v_formation, v_idx, p_member_id, p_action, p_reason, auth.uid());
  end if;
  return v_idx;
end;
$$;

-- Fills free points from the waitlist. On the event day, checked-in standby members go first.
create or replace function public.hp_promote_waitlist(p_event_id uuid, p_limit int default 100000) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_n int := 0;
begin
  for r in
    select m.id from public.event_members m
    left join public.participant_status s on s.member_id = m.id
    where m.event_id = p_event_id and m.status = 'waitlisted'
    order by (s.state is not null and s.state <> 'JOINED') desc, m.participant_number
    limit p_limit
  loop
    exit when public.hp_assign_member(r.id, 'assign', 'waitlist_promotion') is null;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Locks a validated formation as the event's active formation and (re)maps every member onto it
-- in one set-based transaction (tens of thousands of rows, no per-row round trips).
create or replace function public.formation_lock(p_formation_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  f public.formations;
  e public.events;
  v_prev uuid;
  v_released int := 0;
  v_group_assigned int := 0;
  v_assigned int := 0;
  v_waitlisted int := 0;
begin
  select * into f from public.formations where id = p_formation_id for update;
  if not found or not public.hp_can_manage_event(f.event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = f.event_id for update;
  if f.status <> 'ready' then
    raise exception 'FORMATION_NOT_READY: formation must pass validation first' using errcode = 'P0001';
  end if;
  if e.state not in ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EVENT_PREPARATION') then
    raise exception 'FORMATION_FROZEN' using errcode = 'P0001';
  end if;
  v_prev := e.active_formation_id;

  perform public.hp_internal();
  if v_prev is not null then
    with rel as (
      update public.formation_points set member_id = null, assigned_at = null
       where formation_id = v_prev and member_id is not null
      returning idx, member_id
    ), logged as (
      insert into public.assignment_log (event_id, formation_id, point_idx, member_id, action, reason, actor_id)
      select e.id, v_prev, idx, member_id, 'remap', 'formation_version_change', v_uid from rel
      returning 1
    )
    select count(*) into v_released from logged;
    update public.formations set status = 'archived', archived_at = now() where id = v_prev;
  end if;

  update public.formations set status = 'locked', locked_at = now() where id = f.id;
  update public.events set active_formation_id = f.id, assignment_epoch = assignment_epoch + 1 where id = e.id;

  -- Pass 1: group members onto their group's reserved points.
  with m as (
    select id, group_id, row_number() over (partition by group_id order by participant_number) rn
    from public.event_members
    where event_id = e.id and status in ('registered', 'waitlisted') and group_id is not null
  ), p as (
    select idx, reserved_group_id, row_number() over (partition by reserved_group_id order by fill_rank) rn
    from public.formation_points
    where formation_id = f.id and reserved_group_id is not null and member_id is null
  ), upd as (
    update public.formation_points fp set member_id = m.id, assigned_at = now()
    from m join p on p.reserved_group_id = m.group_id and p.rn = m.rn
    where fp.formation_id = f.id and fp.idx = p.idx
    returning fp.idx, fp.member_id
  ), logged as (
    insert into public.assignment_log (event_id, formation_id, point_idx, member_id, action, reason, actor_id)
    select e.id, f.id, idx, member_id, 'assign', 'formation_lock_group', v_uid from upd
    returning 1
  )
  select count(*) into v_group_assigned from logged;

  -- Pass 2: everyone else, in join order, onto the free pool in allocation order.
  with m as (
    select mm.id, row_number() over (order by mm.participant_number) rn
    from public.event_members mm
    where mm.event_id = e.id and mm.status in ('registered', 'waitlisted')
      and not exists (select 1 from public.formation_points x where x.member_id = mm.id)
  ), p as (
    select idx, row_number() over (
      order by case e.allocation_mode when 'random' then shuffle_key::bigint when 'sequential' then idx::bigint else fill_rank::bigint end
    ) rn
    from public.formation_points
    where formation_id = f.id and reserved_group_id is null and member_id is null
  ), upd as (
    update public.formation_points fp set member_id = m.id, assigned_at = now()
    from m join p on p.rn = m.rn
    where fp.formation_id = f.id and fp.idx = p.idx
    returning fp.idx, fp.member_id
  ), logged as (
    insert into public.assignment_log (event_id, formation_id, point_idx, member_id, action, reason, actor_id)
    select e.id, f.id, idx, member_id, 'assign', 'formation_lock', v_uid from upd
    returning 1
  )
  select count(*) into v_assigned from logged;

  -- Members with a point are registered; those without are waitlisted.
  update public.event_members mm set status = case
      when exists (select 1 from public.formation_points x where x.member_id = mm.id) then 'registered'::public.member_status
      else 'waitlisted'::public.member_status end
   where mm.event_id = e.id and mm.status in ('registered', 'waitlisted');
  select count(*) into v_waitlisted from public.event_members where event_id = e.id and status = 'waitlisted';
  update public.event_counters set registered = (select count(*) from public.event_members where event_id = e.id and status = 'registered')
   where event_id = e.id;

  perform public.hp_audit('formation.lock', e.org_id, e.id, 'formation', f.id::text, jsonb_build_object(
    'version', f.version, 'previous', v_prev, 'released', v_released,
    'assigned', v_group_assigned + v_assigned, 'waitlisted', v_waitlisted));
  return jsonb_build_object('formation_id', f.id, 'released', v_released,
    'assigned', v_group_assigned + v_assigned, 'waitlisted', v_waitlisted);
end;
$$;

-- Reserve a compact cluster of k free points in a zone for a group (friends stand together).
create or replace function public.reserve_points_for_group(p_group_id uuid, p_zone smallint, p_count int) returns int
language plpgsql security definer set search_path = public as $$
declare
  g public.event_groups;
  e public.events;
  v_seed record;
  v_n int;
begin
  perform public.hp_require_user();
  select * into g from public.event_groups where id = p_group_id;
  if not found or not public.hp_can_manage_event(g.event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = g.event_id;
  if e.active_formation_id is null then raise exception 'NO_ACTIVE_FORMATION' using errcode = 'P0001'; end if;
  if p_count < 1 or p_count > 5000 then raise exception 'INVALID_COUNT' using errcode = 'P0001'; end if;
  select x_m, y_m into v_seed from public.formation_points
   where formation_id = e.active_formation_id and zone = p_zone and member_id is null and reserved_group_id is null
   order by fill_rank limit 1;
  if v_seed is null then raise exception 'ZONE_FULL' using errcode = 'P0001'; end if;
  with pick as (
    select idx from public.formation_points
     where formation_id = e.active_formation_id and zone = p_zone and member_id is null and reserved_group_id is null
     order by (x_m - v_seed.x_m) ^ 2 + (y_m - v_seed.y_m) ^ 2
     limit p_count
     for update skip locked
  )
  update public.formation_points fp set reserved_group_id = p_group_id
  from pick where fp.formation_id = e.active_formation_id and fp.idx = pick.idx;
  get diagnostics v_n = row_count;
  insert into public.assignment_log (event_id, formation_id, point_idx, member_id, action, reason, actor_id)
  values (e.id, e.active_formation_id, null, null, 'reserve', format('group %s: %s points in zone %s', g.name, v_n, p_zone), auth.uid());
  return v_n;
end;
$$;
