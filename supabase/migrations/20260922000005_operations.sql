-- HUMAN PIXEL: live dashboard, health, photos & storage, evidence, admin, privacy, scheduler.

-- ---------------------------------------------------------------------------------------------
-- Live statistics (aggregated in the database: one query per dashboard poll, not per participant)
-- ---------------------------------------------------------------------------------------------
create or replace function public.hp_event_counts(p_event_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with mem as (
    select status, count(*) n from public.event_members where event_id = p_event_id group by status
  ), st as (
    select s.state, count(*) n
    from public.participant_status s
    join public.event_members m on m.id = s.member_id and m.status = 'registered'
    where s.event_id = p_event_id
    group by s.state
  ), c as (
    select
      coalesce((select n from mem where status = 'registered'), 0) registered,
      coalesce((select n from mem where status = 'waitlisted'), 0) waitlisted,
      coalesce((select n from mem where status = 'cancelled'), 0) cancelled,
      coalesce((select sum(n) from st where state <> 'JOINED'), 0) checked_in,
      coalesce((select sum(n) from st where state in ('ARRIVED', 'IN_POSITION', 'READY', 'LEFT_POSITION', 'COMPLETED')), 0) arrived,
      coalesce((select sum(n) from st where state in ('IN_POSITION', 'READY', 'COMPLETED')), 0) in_position,
      coalesce((select sum(n) from st where state in ('READY', 'COMPLETED')), 0) ready,
      coalesce((select n from st where state = 'LEFT_POSITION'), 0) left_position,
      coalesce((select n from st where state = 'COMPLETED'), 0) completed
  )
  select jsonb_build_object(
    'registered', registered, 'waitlisted', waitlisted, 'cancelled', cancelled,
    'checked_in', checked_in, 'arrived', arrived, 'in_position', in_position, 'ready', ready,
    'left_position', left_position, 'completed', completed,
    'assigned', (select count(*) from public.formation_points fp
                  join public.events e on e.active_formation_id = fp.formation_id
                  where e.id = p_event_id and fp.member_id is not null),
    'points', (select f.point_count from public.formations f join public.events e on e.active_formation_id = f.id where e.id = p_event_id)
  ) from c;
$$;

create or replace function public.get_event_live_stats(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t0 timestamptz := clock_timestamp();
  e public.events;
  v_counts jsonb;
  v_rate numeric;
  v_rate_5m numeric;
  v_gps jsonb;
  v_zones jsonb;
  v_ms numeric;
  v_issues jsonb := '[]'::jsonb;
  v_level int := 0;
  v_rate_high numeric := coalesce((public.hp_setting('health.report_rate_high'))::text::numeric, 400);
  v_db_high numeric := coalesce((public.hp_setting('health.db_latency_high_ms'))::text::numeric, 250);
  v_assigned int;
  v_ready int;
  v_to_start numeric;
begin
  if not public.hp_can_view_event(p_event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = p_event_id;
  v_counts := public.hp_event_counts(p_event_id);

  select count(*) filter (where reported_at > now() - interval '60 seconds') / 60.0,
         count(*) filter (where reported_at > now() - interval '5 minutes') / 300.0
    into v_rate, v_rate_5m
  from public.participant_status where event_id = p_event_id;

  select jsonb_build_object(
    'median_accuracy_m', percentile_cont(0.5) within group (order by accuracy_m),
    'p90_accuracy_m', percentile_cont(0.9) within group (order by accuracy_m),
    'poor', count(*) filter (where accuracy_m > e.required_accuracy_m),
    'p95_clock_uncertainty_ms', percentile_cont(0.95) within group (order by clock_uncertainty_ms),
    'sampled', count(accuracy_m)
  ) into v_gps
  from public.participant_status
  where event_id = p_event_id and state <> 'JOINED' and reported_at > now() - interval '30 minutes';

  if e.active_formation_id is not null then
    select coalesce(jsonb_agg(z order by z.label), '[]'::jsonb) into v_zones from (
      select fz.label,
             fz.point_count as points,
             count(fp.member_id) as assigned,
             count(*) filter (where s.state in ('IN_POSITION', 'READY', 'COMPLETED')) as in_position
      from public.formation_zones fz
      left join public.formation_points fp on fp.formation_id = fz.formation_id and fp.zone = fz.zone
      left join public.participant_status s on s.member_id = fp.member_id
      where fz.formation_id = e.active_formation_id
      group by fz.label, fz.point_count
    ) z;
  end if;

  v_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  v_assigned := coalesce((v_counts ->> 'assigned')::int, 0);
  v_ready := coalesce((v_counts ->> 'ready')::int, 0);
  v_to_start := extract(epoch from e.starts_at - now());

  -- Health rules: 0 normal, 1 high load / warning, 2 critical.
  if v_ms > v_db_high then
    v_level := greatest(v_level, 1);
    v_issues := v_issues || jsonb_build_object('level', 'warning', 'code', 'DB_SLOW', 'message', format('Database answered in %s ms', round(v_ms)));
  end if;
  if v_rate > v_rate_high then
    v_level := greatest(v_level, 1);
    v_issues := v_issues || jsonb_build_object('level', 'warning', 'code', 'HIGH_LOAD', 'message', format('%s status reports/s', round(v_rate)));
  end if;
  if e.state in ('POSITIONING', 'READY') and v_rate_5m = 0 and v_assigned > 0 then
    v_level := greatest(v_level, 2);
    v_issues := v_issues || jsonb_build_object('level', 'critical', 'code', 'NO_REPORTS',
      'message', 'No participant reports in 5 minutes: possible mobile network outage at the venue. Phones keep working offline.');
  end if;
  if (v_gps ->> 'sampled')::int > 20 and (v_gps ->> 'poor')::numeric / greatest(1, (v_gps ->> 'sampled')::numeric) > 0.3 then
    v_level := greatest(v_level, 1);
    v_issues := v_issues || jsonb_build_object('level', 'warning', 'code', 'GPS_POOR',
      'message', 'More than 30% of participants report poor GPS accuracy.');
  end if;
  if e.state in ('POSITIONING', 'READY') and v_to_start between 0 and 300 and v_assigned > 0 and v_ready::numeric / v_assigned < 0.5 then
    v_level := greatest(v_level, 2);
    v_issues := v_issues || jsonb_build_object('level', 'critical', 'code', 'LOW_READINESS',
      'message', format('Only %s%% ready with %s s to start', round(100.0 * v_ready / v_assigned, 1), round(v_to_start)));
  end if;

  return jsonb_build_object(
    'event_id', e.id,
    'state', e.state,
    'starts_at', e.starts_at,
    'counts', v_counts,
    'readiness', case when v_assigned > 0 then round(100.0 * v_ready / v_assigned, 1) else 0 end,
    'report_rate_per_s', round(v_rate, 2),
    'gps', v_gps,
    'zones', coalesce(v_zones, '[]'::jsonb),
    'health', jsonb_build_object('level', (array['NORMAL', 'HIGH_LOAD', 'CRITICAL'])[v_level + 1], 'issues', v_issues, 'query_ms', round(v_ms, 1)),
    'server_time', clock_timestamp()
  );
end;
$$;

-- Per-point state string for the live formation map: one character per point, in idx order.
-- '0' free · '1' JOINED · '2' CHECKED_IN · '3' ARRIVED · '4' IN_POSITION · '5' READY · '6' LEFT · '7' COMPLETED
create or replace function public.get_formation_live(p_formation_id uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_event uuid;
  v text;
begin
  select event_id into v_event from public.formations where id = p_formation_id;
  if v_event is null or not public.hp_can_view_event(v_event) then perform public.hp_forbid(); end if;
  select string_agg(
    case
      when fp.member_id is null then '0'
      else case s.state
        when 'JOINED' then '1' when 'CHECKED_IN' then '2' when 'ARRIVED' then '3' when 'IN_POSITION' then '4'
        when 'READY' then '5' when 'LEFT_POSITION' then '6' when 'COMPLETED' then '7' else '1' end
    end, '' order by fp.idx)
  into v
  from public.formation_points fp
  left join public.participant_status s on s.member_id = fp.member_id
  where fp.formation_id = p_formation_id;
  return coalesce(v, '');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Photos & storage
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('event-photos', 'event-photos', false, 104857600, array['image/jpeg', 'image/webp', 'image/png', 'video/mp4']),
  ('formation-assets', 'formation-assets', false, 20971520, array['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create or replace function public.hp_photo_visible_to_me(p_object_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.event_photos ph
    join public.events e on e.id = ph.event_id
    join public.event_members m on m.event_id = e.id and m.user_id = auth.uid() and m.status = 'registered'
    left join public.participant_status s on s.member_id = m.id
    where ph.status = 'released'
      and e.state in ('PHOTO_RELEASED', 'COMPLETED')
      and p_object_name in (ph.display_path, ph.share_path, ph.thumb_path)
      and (e.photo_audience = 'registered' or coalesce(s.state, 'JOINED') <> 'JOINED')
  );
$$;

create policy event_photos_read on storage.objects for select to authenticated using (
  bucket_id = 'event-photos' and (
    public.hp_can_view_event(public.hp_try_uuid((storage.foldername(name))[1]))
    or public.hp_photo_visible_to_me(name)
  )
);
create policy event_photos_write on storage.objects for insert to authenticated with check (
  bucket_id = 'event-photos' and public.hp_can_manage_event(public.hp_try_uuid((storage.foldername(name))[1]))
);
create policy event_photos_update on storage.objects for update to authenticated using (
  bucket_id = 'event-photos' and public.hp_can_manage_event(public.hp_try_uuid((storage.foldername(name))[1]))
);
create policy event_photos_delete on storage.objects for delete to authenticated using (
  bucket_id = 'event-photos' and public.hp_can_manage_event(public.hp_try_uuid((storage.foldername(name))[1]))
);
create policy formation_assets_read on storage.objects for select to authenticated using (
  bucket_id = 'formation-assets' and public.hp_can_view_event(public.hp_try_uuid((storage.foldername(name))[1]))
);
create policy formation_assets_write on storage.objects for insert to authenticated with check (
  bucket_id = 'formation-assets' and public.hp_can_manage_event(public.hp_try_uuid((storage.foldername(name))[1]))
);

-- Registers a photo whose files were uploaded to event-photos/{event_id}/{photo_id}/...
create or replace function public.photo_register(
  p_event_id uuid, p_photo_id uuid, p_kind public.photo_kind, p_title text,
  p_master_path text, p_display_path text, p_share_path text, p_thumb_path text,
  p_width int, p_height int, p_bytes bigint, p_sha256 text, p_captured_at timestamptz, p_camera text
) returns public.event_photos
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  v public.event_photos;
  v_prefix text := p_event_id::text || '/' || p_photo_id::text || '/';
  v_missing int;
  v_org uuid;
begin
  if not public.hp_can_manage_event(p_event_id) then perform public.hp_forbid(); end if;
  if not (p_master_path like v_prefix || '%' and p_display_path like v_prefix || '%'
          and p_share_path like v_prefix || '%' and p_thumb_path like v_prefix || '%') then
    raise exception 'INVALID_PHOTO_PATHS' using errcode = 'P0001';
  end if;
  select count(*) into v_missing from unnest(array[p_master_path, p_display_path, p_share_path, p_thumb_path]) pth
  where not exists (select 1 from storage.objects o where o.bucket_id = 'event-photos' and o.name = pth);
  if v_missing > 0 then
    raise exception 'PHOTO_UPLOAD_INCOMPLETE: % file(s) missing', v_missing using errcode = 'P0001';
  end if;
  insert into public.event_photos (id, event_id, kind, title, master_path, display_path, share_path, thumb_path,
                                   width, height, bytes, sha256, captured_at, camera, uploaded_by,
                                   is_primary)
  values (p_photo_id, p_event_id, p_kind, p_title, p_master_path, p_display_path, p_share_path, p_thumb_path,
          p_width, p_height, p_bytes, lower(p_sha256), p_captured_at, p_camera, v_uid,
          p_kind = 'official' and not exists (select 1 from public.event_photos where event_id = p_event_id and is_primary))
  on conflict (id) do update set title = excluded.title
  returning * into v;
  select org_id into v_org from public.events where id = p_event_id;
  perform public.hp_audit('photo.register', v_org, p_event_id, 'photo', v.id::text,
    jsonb_build_object('sha256', v.sha256, 'bytes', v.bytes, 'kind', v.kind));
  return v;
end;
$$;

create or replace function public.photo_set_primary(p_photo_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v public.event_photos;
begin
  perform public.hp_require_user();
  select * into v from public.event_photos where id = p_photo_id;
  if not found or not public.hp_can_manage_event(v.event_id) then perform public.hp_forbid(); end if;
  if v.kind <> 'official' then raise exception 'ONLY_OFFICIAL_CAN_BE_PRIMARY' using errcode = 'P0001'; end if;
  update public.event_photos set is_primary = false where event_id = v.event_id and is_primary and id <> v.id;
  update public.event_photos set is_primary = true,
         status = case when exists (select 1 from public.events where id = v.event_id and state in ('PHOTO_RELEASED', 'COMPLETED'))
                       then 'released'::public.photo_status else status end,
         released_at = case when exists (select 1 from public.events where id = v.event_id and state in ('PHOTO_RELEASED', 'COMPLETED'))
                       then now() else released_at end
   where id = v.id;
  perform public.hp_audit('photo.set_primary', (select org_id from public.events where id = v.event_id), v.event_id, 'photo', v.id::text);
end;
$$;

-- The participant's "YOU WERE ONE OF 12,000 PIXELS" card.
create or replace function public.get_my_photo(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  e public.events;
  m public.event_members;
  ph public.event_photos;
  v_label int;
  v_total int;
  v_state public.participant_state;
begin
  select * into e from public.events where id = p_event_id;
  select * into m from public.event_members where event_id = p_event_id and user_id = v_uid and status = 'registered';
  if m.id is null then raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0002'; end if;
  if e.state not in ('PHOTO_RELEASED', 'COMPLETED') then
    return jsonb_build_object('released', false);
  end if;
  select state into v_state from public.participant_status where member_id = m.id;
  if e.photo_audience = 'checked_in' and coalesce(v_state, 'JOINED') = 'JOINED' then
    return jsonb_build_object('released', true, 'eligible', false);
  end if;
  select * into ph from public.event_photos where event_id = e.id and is_primary and status = 'released';
  select label into v_label from public.formation_points where member_id = m.id;
  select coalesce((counts ->> 'in_position')::int, (counts ->> 'registered')::int) into v_total
    from public.event_stat_snapshots where event_id = e.id and state = 'LIVE' order by at desc limit 1;
  if v_total is null then
    select registered into v_total from public.event_counters where event_id = e.id;
  end if;
  return jsonb_build_object(
    'released', true,
    'eligible', true,
    'event_name', e.name,
    'event_date', e.starts_at,
    'timezone', e.timezone,
    'pixel_label', v_label,
    'participant_number', m.participant_number,
    'participants', v_total,
    'share_message', e.share_message,
    'hashtags', to_jsonb(e.hashtags),
    'photo', case when ph.id is null then null else jsonb_build_object(
      'id', ph.id, 'display_path', ph.display_path, 'share_path', ph.share_path, 'thumb_path', ph.thumb_path,
      'width', ph.width, 'height', ph.height) end
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Record evidence (e.g. for a future world-record submission). Tamper-evident via SHA-256.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_event_evidence(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  e public.events;
  v jsonb;
begin
  if not public.hp_can_view_event(p_event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = p_event_id;
  v := jsonb_build_object(
    'generated_at', now(),
    'event', jsonb_build_object('id', e.id, 'name', e.name, 'state', e.state, 'timezone', e.timezone,
      'starts_at', e.starts_at, 'live_at', e.live_at, 'completed_at', e.completed_at,
      'venue_name', e.venue_name, 'center', jsonb_build_object('lat', e.center_lat, 'lng', e.center_lng),
      'tolerance_radius_m', e.tolerance_radius_m, 'required_accuracy_m', e.required_accuracy_m),
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name, 'contact_email', o.contact_email)
                     from public.organizations o where o.id = e.org_id),
    'perimeter', (select st_asgeojson(geom, 7)::jsonb from public.event_areas where event_id = e.id and kind = 'perimeter'),
    'perimeter_area_m2', (select round(st_area(geom::geography)) from public.event_areas where event_id = e.id and kind = 'perimeter'),
    'formation', (select jsonb_build_object('id', f.id, 'version', f.version, 'points', f.point_count, 'engine', f.engine_version,
                         'seed', f.seed, 'checksum', f.checksum, 'metrics', f.metrics, 'validation', f.validation, 'locked_at', f.locked_at)
                  from public.formations f where f.id = e.active_formation_id),
    'counts_now', public.hp_event_counts(e.id),
    'counts_at_live', (select counts from public.event_stat_snapshots where event_id = e.id and state = 'LIVE' order by at limit 1),
    'state_history', (select coalesce(jsonb_agg(jsonb_build_object('from', from_state, 'to', to_state, 'at', at, 'system', is_system) order by id), '[]')
                      from public.event_state_history where event_id = e.id),
    'assignment_actions', (select coalesce(jsonb_object_agg(action, n), '{}') from (
                             select action, count(*) n from public.assignment_log where event_id = e.id group by action) a),
    'photos', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'sha256', sha256, 'bytes', bytes,
                      'width', width, 'height', height, 'captured_at', captured_at, 'camera', camera, 'released_at', released_at)), '[]')
               from public.event_photos where event_id = e.id),
    'audit_entries', (select count(*) from public.audit_logs where event_id = e.id)
  );
  return v || jsonb_build_object('sha256', encode(digest(v::text, 'sha256'), 'hex'));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Platform administration
-- ---------------------------------------------------------------------------------------------
create or replace function public.hp_require_admin() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := public.hp_require_user();
begin
  if not public.hp_is_admin() then perform public.hp_forbid(); end if;
  return v;
end;
$$;

create or replace function public.admin_list_users(p_search text default null, p_limit int default 50, p_offset int default 0)
returns table (id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, platform_role public.platform_role,
               is_suspended boolean, organizations bigint, events_joined bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.hp_require_admin();
  return query
  select u.id, u.email::text, u.created_at, u.last_sign_in_at, p.platform_role, p.is_suspended,
         (select count(*) from public.organization_members om where om.user_id = u.id),
         (select count(*) from public.event_members em where em.user_id = u.id)
  from auth.users u
  left join public.profiles p on p.id = u.id
  where p_search is null or u.email ilike '%' || p_search || '%' or u.id::text = p_search
  order by u.created_at desc
  limit least(p_limit, 200) offset greatest(p_offset, 0);
end;
$$;

create or replace function public.admin_set_user(p_user_id uuid, p_role public.platform_role, p_suspended boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := public.hp_require_admin();
begin
  if p_user_id = v_admin and (p_role <> 'admin' or p_suspended) then
    raise exception 'CANNOT_DEMOTE_SELF' using errcode = 'P0001';
  end if;
  perform public.hp_internal();
  update public.profiles set platform_role = p_role, is_suspended = p_suspended where id = p_user_id;
  perform public.hp_audit('admin.user_set', null, null, 'user', p_user_id::text, jsonb_build_object('role', p_role, 'suspended', p_suspended));
end;
$$;

create or replace function public.admin_set_organization(p_org_id uuid, p_status public.org_status, p_plan text,
  p_max_participants int, p_max_events int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.hp_require_admin();
  perform public.hp_internal();
  update public.organizations set status = p_status where id = p_org_id;
  insert into public.organization_subscriptions (org_id, plan, max_participants_per_event, max_active_events, updated_at)
  values (p_org_id, p_plan, p_max_participants, p_max_events, now())
  on conflict (org_id) do update set plan = excluded.plan, max_participants_per_event = excluded.max_participants_per_event,
    max_active_events = excluded.max_active_events, updated_at = now();
  perform public.hp_audit('admin.organization_set', p_org_id, null, 'organization', p_org_id::text,
    jsonb_build_object('status', p_status, 'plan', p_plan, 'max_participants', p_max_participants, 'max_events', p_max_events));
end;
$$;

create or replace function public.admin_resolve_report(p_report_id uuid, p_status public.report_status, p_resolution text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := public.hp_require_admin();
begin
  update public.abuse_reports set status = p_status, resolution = p_resolution, handled_by = v_admin,
    resolved_at = case when p_status in ('resolved', 'dismissed') then now() end
  where id = p_report_id;
  perform public.hp_audit('admin.report_update', null, null, 'abuse_report', p_report_id::text, jsonb_build_object('status', p_status));
end;
$$;

create or replace function public.admin_set_setting(p_key text, p_value jsonb, p_is_public boolean default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := public.hp_require_admin();
begin
  insert into public.platform_settings (key, value, is_public, updated_by, updated_at)
  values (p_key, p_value, coalesce(p_is_public, false), v_admin, now())
  on conflict (key) do update set value = excluded.value, is_public = coalesce(p_is_public, public.platform_settings.is_public),
    updated_by = v_admin, updated_at = now();
  perform public.hp_audit('admin.setting_set', null, null, 'setting', p_key, jsonb_build_object('value', p_value));
end;
$$;

create or replace function public.admin_list_organizations(p_search text default null)
returns table (id uuid, name text, slug text, status public.org_status, plan text, max_participants_per_event int,
               max_active_events int, members bigint, events bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.hp_require_admin();
  return query
  select o.id, o.name, o.slug, o.status, s.plan, s.max_participants_per_event, s.max_active_events,
         (select count(*) from public.organization_members om where om.org_id = o.id),
         (select count(*) from public.events ev where ev.org_id = o.id), o.created_at
  from public.organizations o
  left join public.organization_subscriptions s on s.org_id = o.id
  where p_search is null or o.name ilike '%' || p_search || '%' or o.slug ilike '%' || p_search || '%'
  order by o.created_at desc
  limit 200;
end;
$$;

create or replace function public.admin_system_health() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.hp_require_admin();
  return jsonb_build_object(
    'at', now(),
    'db_size_bytes', pg_database_size(current_database()),
    'connections', (select coalesce(jsonb_object_agg(coalesce(state, 'unknown'), n), '{}') from (
                      select state, count(*) n from pg_stat_activity where datname = current_database() group by state) c),
    'max_connections', current_setting('max_connections')::int,
    'active_events', (select count(*) from public.events where state not in ('DRAFT', 'COMPLETED', 'CANCELLED')),
    'live_events', (select count(*) from public.events where state in ('PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY', 'LIVE')),
    'participants_total', (select count(*) from public.event_members where status = 'registered'),
    'reports_last_minute', (select count(*) from public.participant_status where reported_at > now() - interval '1 minute'),
    'open_abuse_reports', (select count(*) from public.abuse_reports where status in ('open', 'reviewing')),
    'largest_tables', (select jsonb_agg(t) from (
                         select relname as table, pg_total_relation_size(relid) as bytes, n_live_tup as rows
                         from pg_stat_user_tables where schemaname = 'public'
                         order by pg_total_relation_size(relid) desc limit 8) t),
    'cron', (select coalesce(jsonb_agg(j), '[]') from (
               select jb.jobname, max(d.start_time) as last_run,
                      count(*) filter (where d.status = 'failed' and d.start_time > now() - interval '1 day') as failures_24h
               from cron.job jb left join cron.job_run_details d on d.jobid = jb.jobid
               group by jb.jobname) j),
    'cache_hit_ratio', (select round(sum(blks_hit)::numeric / nullif(sum(blks_hit) + sum(blks_read), 0), 4) from pg_stat_database)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privacy
-- ---------------------------------------------------------------------------------------------
-- Anonymises a user's participation (evidence counts stay valid) and releases upcoming positions.
create or replace function public.hp_anonymize_user(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_upcoming int := 0;
  v_past int := 0;
begin
  if exists (
    select 1 from public.organization_members om
    where om.user_id = p_user_id and om.role = 'owner'
      and (select count(*) from public.organization_members o2 where o2.org_id = om.org_id and o2.role = 'owner') = 1
      and exists (select 1 from public.organization_members o3 where o3.org_id = om.org_id and o3.user_id <> p_user_id)
  ) then
    raise exception 'TRANSFER_OWNERSHIP_FIRST' using errcode = 'P0001';
  end if;
  for r in
    select m.id, m.event_id, m.status, e.state from public.event_members m join public.events e on e.id = m.event_id
    where m.user_id = p_user_id
  loop
    if r.state not in ('LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING', 'PHOTO_RELEASED', 'COMPLETED', 'CANCELLED')
       and r.status in ('registered', 'waitlisted') then
      perform public.hp_release_member(r.id, 'release', 'account_deleted');
      update public.event_members set status = 'cancelled', cancelled_at = now() where id = r.id;
      if r.status = 'registered' then
        update public.event_counters set registered = greatest(0, registered - 1) where event_id = r.event_id;
      end if;
      perform public.hp_promote_waitlist(r.event_id, 1);
      v_upcoming := v_upcoming + 1;
    else
      v_past := v_past + 1;
    end if;
  end loop;
  update public.participant_status s set device_id = null, app_version = null
   from public.event_members m where m.id = s.member_id and m.user_id = p_user_id;
  update public.event_members set user_id = null, anonymized_at = now() where user_id = p_user_id;
  delete from public.notifications where user_id = p_user_id;
  insert into public.audit_logs (actor_id, action, target_type, target_id, details)
  values (null, 'privacy.anonymize_user', 'user', md5(p_user_id::text),
          jsonb_build_object('upcoming_released', v_upcoming, 'past_anonymized', v_past));
  return jsonb_build_object('upcoming_released', v_upcoming, 'past_anonymized', v_past);
end;
$$;

-- Called by the account-delete edge function with the user's own JWT before deleting auth.users.
create or replace function public.prepare_account_deletion() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
begin
  return public.hp_anonymize_user(v_uid);
end;
$$;

-- Retention: anonymise participants of events finished more than retention_days ago.
create or replace function public.purge_expired_personal_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_members int;
  v_rate int;
begin
  with ev as (
    select id from public.events
    where state in ('COMPLETED', 'CANCELLED')
      and coalesce(completed_at, cancelled_at, updated_at) < now() - make_interval(days => retention_days)
  ), st as (
    update public.participant_status s set device_id = null, app_version = null
    from ev where s.event_id = ev.id and (s.device_id is not null or s.app_version is not null)
    returning 1
  ), mem as (
    update public.event_members m set user_id = null, anonymized_at = now()
    from ev where m.event_id = ev.id and m.user_id is not null
    returning 1
  )
  select (select count(*) from mem) into v_members;
  delete from public.notifications where created_at < now() - interval '180 days';
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_rate = row_count;
  insert into public.audit_logs (action, details) values ('privacy.retention_run', jsonb_build_object('members_anonymized', v_members));
  return jsonb_build_object('members_anonymized', v_members);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Scheduler (pg_cron). The LIVE transition is bookkeeping: phones never wait for it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.hp_scheduler_tick() returns void
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  for r in
    select id from public.events where state in ('POSITIONING', 'READY') and starts_at <= now()
  loop
    begin
      perform public.hp_transition_event(r.id, 'LIVE', null, 'scheduled start', true);
    exception when others then
      insert into public.audit_logs (action, event_id, details) values ('scheduler.error', r.id, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  -- Positioning-phase snapshots every tick for the attendance curve (≤ 1 row / event / 30 s).
  insert into public.event_stat_snapshots (event_id, at, state, counts)
  select e.id, date_trunc('second', now()), e.state, public.hp_event_counts(e.id)
  from public.events e
  where e.state in ('PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY', 'LIVE')
    and not exists (select 1 from public.event_stat_snapshots s where s.event_id = e.id and s.at > now() - interval '29 seconds')
  on conflict do nothing;
end;
$$;

select cron.schedule('hp-scheduler', '5 seconds', $$select public.hp_scheduler_tick()$$);
select cron.schedule('hp-retention', '17 3 * * *', $$select public.purge_expired_personal_data()$$);
