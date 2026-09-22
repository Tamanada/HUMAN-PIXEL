-- HUMAN PIXEL: formation_finalize v2.
-- The minimum-spacing check no longer needs a temporary table + GiST index: points are projected
-- to a local metric plane and bucketed on a grid (cell = min spacing); each point is compared with
-- the 9 neighbouring cells through a hash equi-join. O(n), no temp objects, statically checkable.

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
  v_lat0 float8;
  v_lng0 float8;
  v_mlat float8;
  v_mlng float8;
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
         coalesce(sum(((idx + 1)::bigint * label) % 2147483647) % 2147483647, 0), avg(lat), avg(lng)
    into v_count, v_min_idx, v_max_idx, v_min_label, v_max_label, v_min_rank, v_max_rank, v_checksum, v_lat0, v_lng0
  from public.formation_points where formation_id = p_formation_id;

  select count(*) into v_zone_bad from public.formation_points p
  where p.formation_id = p_formation_id
    and not exists (select 1 from public.formation_zones z where z.formation_id = p_formation_id and z.zone = p.zone);

  -- Safety geometry (5 cm / 2% tolerance for planar-vs-geodesic differences on buffers).
  select count(*) into v_outside from public.formation_points p
  where p.formation_id = p_formation_id
    and not exists (
      select 1 from public.event_areas a
      where a.event_id = f.event_id and a.kind = 'perimeter'
        and st_covers(a.geom, st_setsrid(st_makepoint(p.lng, p.lat), 4326))
    );
  if exists (select 1 from public.event_areas where event_id = f.event_id and kind = 'formation_area') then
    select count(*) into v_outside_area from public.formation_points p
    where p.formation_id = p_formation_id
      and not exists (
        select 1 from public.event_areas a
        where a.event_id = f.event_id and a.kind = 'formation_area'
          and st_covers(a.geom, st_setsrid(st_makepoint(p.lng, p.lat), 4326))
      );
  end if;
  select count(distinct p.idx) into v_excluded from public.formation_points p
  join public.event_areas a on a.event_id = f.event_id and a.kind in ('exclusion', 'no_go', 'emergency')
  where p.formation_id = p_formation_id
    and (st_intersects(a.geom, st_setsrid(st_makepoint(p.lng, p.lat), 4326))
         or st_dwithin(a.geom::geography, st_setsrid(st_makepoint(p.lng, p.lat), 4326)::geography,
                       greatest(0, a.safety_buffer_m * 0.98 - 0.05)));

  -- Minimum spacing: local plane (WGS84 metres per degree at the formation's latitude), grid hash.
  v_min_spacing := coalesce((f.params ->> 'minSpacingM')::float8, 0.9);
  v_mlat := 111132.954 - 559.822 * cos(2 * radians(coalesce(v_lat0, 0))) + 1.175 * cos(4 * radians(coalesce(v_lat0, 0)));
  v_mlng := 111412.84 * cos(radians(coalesce(v_lat0, 0))) - 93.5 * cos(3 * radians(coalesce(v_lat0, 0)));
  with pts as (
    select idx, (lng - v_lng0) * v_mlng as x, (lat - v_lat0) * v_mlat as y
    from public.formation_points where formation_id = p_formation_id
  ), cells as (
    select idx, x, y, floor(x / v_min_spacing)::int as cx, floor(y / v_min_spacing)::int as cy from pts
  ), probes as (
    select c.idx, c.x, c.y, c.cx + o.dx as ncx, c.cy + o.dy as ncy
    from cells c
    cross join (values (-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 0), (0, 1), (1, -1), (1, 0), (1, 1)) as o(dx, dy)
  )
  select count(*) into v_too_close
  from probes a
  join cells b on b.cx = a.ncx and b.cy = a.ncy and b.idx > a.idx
  where (a.x - b.x) ^ 2 + (a.y - b.y) ^ 2 < (v_min_spacing * 0.95) ^ 2;

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

create or replace function public.purge_expired_personal_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_members int;
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
  insert into public.audit_logs (action, details) values ('privacy.retention_run', jsonb_build_object('members_anonymized', v_members));
  return jsonb_build_object('members_anonymized', v_members);
end;
$$;

-- Re-assert the privilege whitelist for replaced functions.
revoke all on function public.formation_finalize(uuid, bigint) from public, anon;
grant execute on function public.formation_finalize(uuid, bigint) to authenticated;
revoke all on function public.purge_expired_personal_data() from public, anon, authenticated;
