-- A changed briefing (dress code, what to collect, bounty) is public information: bump the manifest
-- so phones re-read their bundle instead of showing yesterday's instructions. Rebalancing the
-- pickup points does the same through the assignment epoch.

create or replace function public.hp_guard_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_max int;
begin
  if not public.hp_is_internal() then
    if new.state is distinct from old.state
      or new.org_id is distinct from old.org_id
      or new.join_code is distinct from old.join_code
      or new.active_formation_id is distinct from old.active_formation_id
      or new.assignment_epoch is distinct from old.assignment_epoch
      or new.manifest_version is distinct from old.manifest_version
      or new.live_at is distinct from old.live_at
      or new.completed_at is distinct from old.completed_at
      or new.cancelled_at is distinct from old.cancelled_at
      or new.created_by is distinct from old.created_by then
      raise exception 'PROTECTED_COLUMN' using errcode = '42501';
    end if;
    if old.state in ('LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING', 'PHOTO_RELEASED', 'COMPLETED', 'CANCELLED')
      and (new.starts_at is distinct from old.starts_at or new.tolerance_radius_m is distinct from old.tolerance_radius_m
           or new.capacity is distinct from old.capacity) then
      raise exception 'EVENT_TIMING_FROZEN' using errcode = 'P0001';
    end if;
    -- A start-time change must reach every phone through the CDN manifest (≤ ~60 s propagation).
    if new.starts_at is distinct from old.starts_at and old.starts_at is not null
      and old.state in ('PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY')
      and (old.starts_at < now() + interval '90 seconds' or new.starts_at < now() + interval '90 seconds') then
      raise exception 'START_CHANGE_TOO_LATE: changes must be made at least 90 seconds ahead' using errcode = 'P0001';
    end if;
  end if;
  if new.capacity is distinct from old.capacity then
    select s.max_participants_per_event into v_max from public.organization_subscriptions s where s.org_id = new.org_id;
    if new.capacity > coalesce(v_max, 0) and not public.hp_is_admin() then
      raise exception 'PLAN_LIMIT_CAPACITY: plan allows % participants per event', coalesce(v_max, 0) using errcode = 'P0001';
    end if;
  end if;
  -- Public-facing fields changed ⇒ phones must re-read the manifest.
  if (new.name, new.starts_at, new.arrival_deadline, new.positions_release_at, new.venue_name, new.announcement,
      new.countdown, new.timezone, new.state, new.briefing)
     is distinct from
     (old.name, old.starts_at, old.arrival_deadline, old.positions_release_at, old.venue_name, old.announcement,
      old.countdown, old.timezone, old.state, old.briefing) then
    new.manifest_version := old.manifest_version + 1;
  end if;
  return new;
end;
$$;

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
    return jsonb_build_object('points', 0, 'moved', 0);
  end if;
  with points as (
    select a.id, row_number() over (order by a.created_at) rn, count(*) over () n
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
  if v_moved > 0 then
    -- Phones refetch their bundle when the epoch moves: they learn their new tent.
    perform public.hp_internal();
    update public.events set assignment_epoch = assignment_epoch + 1 where id = p_event_id;
  end if;
  perform public.hp_audit('event.rebalance_pickups', null, p_event_id, 'event', p_event_id::text, jsonb_build_object('moved', v_moved));
  return jsonb_build_object('points', v_points, 'moved', v_moved);
end;
$$;
