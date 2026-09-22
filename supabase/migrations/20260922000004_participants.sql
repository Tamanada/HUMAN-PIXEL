-- HUMAN PIXEL: participant API. A participant can only ever learn ONE coordinate: their own.

-- The participant's complete offline bundle. Coordinates are withheld until release.
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
    'areas', v_areas,
    'server_time', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

create or replace function public.join_event(
  p_code text,
  p_consent_version text,
  p_group_code text default null,
  p_device_id text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  e public.events;
  m public.event_members;
  g public.event_groups;
  v_number int;
  v_registered int;
  v_idx int;
begin
  if not public.hp_rate_limit('join:' || v_uid, 20, interval '10 minutes') then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  if coalesce(public.hp_setting('registration_enabled'), 'true'::jsonb) = 'false'::jsonb then
    raise exception 'REGISTRATION_DISABLED' using errcode = 'P0001';
  end if;
  select * into e from public.events where join_code = upper(trim(p_code));
  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.organizations o where o.id = e.org_id and o.status <> 'active') then
    raise exception 'EVENT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  select * into m from public.event_members where event_id = e.id and user_id = v_uid;
  if found and m.status in ('registered', 'waitlisted') then
    return public.get_my_assignment(e.id); -- idempotent re-join (new device, reinstall)
  end if;
  if found and m.status = 'removed' then
    raise exception 'REMOVED_FROM_EVENT' using errcode = '42501';
  end if;

  if not (e.state = 'REGISTRATION_OPEN'
          or (e.allow_late_registration and e.state in ('EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION', 'POSITIONING'))) then
    raise exception 'REGISTRATION_CLOSED' using errcode = 'P0001';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) and not e.allow_anonymous_join then
    raise exception 'EMAIL_SIGN_IN_REQUIRED' using errcode = 'P0001';
  end if;
  if p_consent_version is distinct from e.consent_version then
    raise exception 'CONSENT_REQUIRED' using errcode = 'P0001';
  end if;
  if p_group_code is not null and trim(p_group_code) <> '' then
    select * into g from public.event_groups where code = upper(trim(p_group_code)) and event_id = e.id;
    if not found then raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002'; end if;
    if g.capacity is not null and (select count(*) from public.event_members where group_id = g.id and status = 'registered') >= g.capacity then
      raise exception 'GROUP_FULL' using errcode = 'P0001';
    end if;
  end if;

  -- The counters row serializes number allocation and capacity per event (short lock, own row).
  update public.event_counters
     set next_participant_number = next_participant_number + 1
   where event_id = e.id
  returning next_participant_number, registered into v_number, v_registered;

  if m.id is not null then
    -- Previously cancelled: reactivate, keep the original participant number.
    update public.event_members
       set status = 'waitlisted', cancelled_at = null, consent_version = p_consent_version, consent_at = now(), group_id = g.id
     where id = m.id returning * into m;
  else
    begin
      insert into public.event_members (event_id, user_id, participant_number, status, group_id, consent_version)
      values (e.id, v_uid, v_number, 'waitlisted', g.id, p_consent_version)
      returning * into m;
    exception when unique_violation then
      -- Concurrent duplicate join from the same user (double tap / two devices): converge.
      return public.get_my_assignment(e.id);
    end;
    insert into public.participant_status (member_id, event_id, device_id) values (m.id, e.id, left(p_device_id, 64));
  end if;

  if e.active_formation_id is not null then
    v_idx := public.hp_assign_member(m.id, 'assign', 'join');
    if v_idx is not null then
      update public.event_counters set registered = registered + 1 where event_id = e.id;
    end if;
  elsif v_registered < e.capacity then
    update public.event_members set status = 'registered' where id = m.id;
    update public.event_counters set registered = registered + 1 where event_id = e.id;
  end if;

  return public.get_my_assignment(e.id);
end;
$$;

-- Idempotent, replay-safe status report. Accepted when the sequence moves forward on the same
-- device, or when a different device reports a later client time (device switch).
create or replace function public.report_status(
  p_event_id uuid,
  p_state public.participant_state,
  p_seq bigint,
  p_client_at timestamptz,
  p_accuracy_m real default null,
  p_clock_uncertainty_ms int default null,
  p_device_id text default null,
  p_app_version text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  v_member uuid;
  s public.participant_status;
  v_now timestamptz := now();
begin
  select m.id into v_member from public.event_members m
   where m.event_id = p_event_id and m.user_id = v_uid and m.status in ('registered', 'waitlisted');
  if v_member is null then
    raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0002';
  end if;
  select * into s from public.participant_status where member_id = v_member for update;
  if s.reported_at is not null and s.reported_at > v_now - interval '2 seconds' then
    return jsonb_build_object('accepted', false, 'reason', 'RATE_LIMITED', 'retry_after_ms', 2000);
  end if;
  if p_client_at > v_now + interval '5 minutes' then
    return jsonb_build_object('accepted', false, 'reason', 'CLOCK_SKEW');
  end if;
  if (s.device_id is not distinct from p_device_id and p_seq <= s.last_seq)
     or (s.device_id is distinct from p_device_id and s.last_client_at is not null and p_client_at <= s.last_client_at) then
    -- Stale or replayed: report success so the client drops it, but change nothing.
    return jsonb_build_object('accepted', false, 'reason', 'STALE', 'state', s.state, 'seq', s.last_seq);
  end if;
  update public.participant_status set
    state = p_state,
    last_seq = p_seq,
    last_client_at = p_client_at,
    device_id = coalesce(left(p_device_id, 64), device_id),
    app_version = coalesce(left(p_app_version, 32), app_version),
    accuracy_m = case when p_accuracy_m is null or p_accuracy_m < 0 or p_accuracy_m > 10000 then accuracy_m else p_accuracy_m end,
    clock_uncertainty_ms = case when p_clock_uncertainty_ms between 0 and 600000 then p_clock_uncertainty_ms else clock_uncertainty_ms end,
    report_count = report_count + 1,
    reported_at = v_now,
    state_changed_at = case when state is distinct from p_state then v_now else state_changed_at end,
    checked_in_at = coalesce(checked_in_at, case when p_state <> 'JOINED' then v_now end),
    first_in_position_at = coalesce(first_in_position_at, case when p_state in ('IN_POSITION', 'READY') then v_now end),
    ready_at = case when p_state = 'READY' then coalesce(ready_at, v_now) else ready_at end
  where member_id = v_member;
  return jsonb_build_object('accepted', true, 'state', p_state, 'seq', p_seq);
end;
$$;

create or replace function public.cancel_my_participation(p_event_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  m public.event_members;
  v_state public.event_state;
  v_idx int;
begin
  select * into m from public.event_members where event_id = p_event_id and user_id = v_uid for update;
  if not found or m.status not in ('registered', 'waitlisted') then
    raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0002';
  end if;
  select state into v_state from public.events where id = p_event_id;
  if v_state in ('LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING', 'PHOTO_RELEASED', 'COMPLETED') then
    raise exception 'EVENT_ALREADY_HAPPENED' using errcode = 'P0001';
  end if;
  v_idx := public.hp_release_member(m.id, 'release', 'participant_cancelled');
  update public.event_members set status = 'cancelled', cancelled_at = now() where id = m.id;
  if m.status = 'registered' then
    update public.event_counters set registered = greatest(0, registered - 1) where event_id = p_event_id;
  end if;
  -- The freed point goes straight to the next person on the waitlist (same transaction).
  if v_idx is not null then
    if public.hp_promote_waitlist(p_event_id, 1) > 0 then
      update public.event_counters set registered = registered + 1 where event_id = p_event_id;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Organizer: member recovery tools
-- ---------------------------------------------------------------------------------------------
create or replace function public.organizer_reassign_member(p_member_id uuid, p_target_idx int default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  m public.event_members;
  e public.events;
  v_idx int;
begin
  perform public.hp_require_user();
  select * into m from public.event_members where id = p_member_id;
  if not found or not public.hp_can_manage_event(m.event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = m.event_id;
  if e.active_formation_id is null then raise exception 'NO_ACTIVE_FORMATION' using errcode = 'P0001'; end if;
  if m.status not in ('registered', 'waitlisted') then raise exception 'MEMBER_INACTIVE' using errcode = 'P0001'; end if;

  if p_target_idx is not null then
    perform 1 from public.formation_points
     where formation_id = e.active_formation_id and idx = p_target_idx and member_id is null for update;
    if not found then raise exception 'TARGET_NOT_FREE' using errcode = 'P0001'; end if;
    perform public.hp_release_member(m.id, 'reassign', 'organizer_manual');
    update public.formation_points set member_id = m.id, assigned_at = now()
     where formation_id = e.active_formation_id and idx = p_target_idx;
    insert into public.assignment_log (event_id, formation_id, point_idx, member_id, action, reason, actor_id)
    values (e.id, e.active_formation_id, p_target_idx, m.id, 'reassign', 'organizer_manual', auth.uid());
    v_idx := p_target_idx;
    if m.status = 'waitlisted' then
      update public.event_members set status = 'registered' where id = m.id;
      update public.event_counters set registered = registered + 1 where event_id = e.id;
    end if;
  else
    perform public.hp_release_member(m.id, 'reassign', 'organizer_manual');
    v_idx := public.hp_assign_member(m.id, 'reassign', 'organizer_manual');
  end if;
  insert into public.notifications (user_id, event_id, kind, title, body)
  select m.user_id, e.id, 'position_changed', 'Your pixel has moved', 'Open the app to see your new position.'
  where m.user_id is not null;
  perform public.hp_audit('member.reassign', e.org_id, e.id, 'member', m.id::text, jsonb_build_object('idx', v_idx));
  return v_idx;
end;
$$;

create or replace function public.organizer_remove_member(p_member_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.event_members;
  v_org uuid;
begin
  perform public.hp_require_user();
  select * into m from public.event_members where id = p_member_id for update;
  if not found or not public.hp_can_manage_event(m.event_id) then perform public.hp_forbid(); end if;
  perform public.hp_release_member(m.id, 'release', 'organizer_removed');
  update public.event_members set status = 'removed', cancelled_at = now() where id = m.id;
  if m.status = 'registered' then
    update public.event_counters set registered = greatest(0, registered - 1) where event_id = m.event_id;
  end if;
  if public.hp_promote_waitlist(m.event_id, 1) > 0 then
    update public.event_counters set registered = registered + 1 where event_id = m.event_id;
  end if;
  select org_id into v_org from public.events where id = m.event_id;
  perform public.hp_audit('member.remove', v_org, m.event_id, 'member', m.id::text, jsonb_build_object('reason', p_reason));
end;
$$;

-- Event-day recovery: points held by people who never checked in go to checked-in standby
-- participants (waitlist), most important points (lowest fill_rank) first.
create or replace function public.reclaim_no_shows(p_event_id uuid, p_limit int default 100000) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.events;
  v_standby int;
  v_released int := 0;
  v_assigned int := 0;
  r record;
begin
  perform public.hp_require_user();
  if not public.hp_can_manage_event(p_event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = p_event_id for update;
  if e.state not in ('PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY') then
    raise exception 'RECLAIM_NOT_ALLOWED_IN_STATE %', e.state using errcode = 'P0001';
  end if;
  select count(*) into v_standby from public.event_members m
  join public.participant_status s on s.member_id = m.id
  where m.event_id = e.id and m.status = 'waitlisted' and s.state <> 'JOINED';
  -- Release only as many no-show points as there are standby people to fill them.
  for r in
    select fp.member_id from public.formation_points fp
    join public.participant_status s on s.member_id = fp.member_id
    where fp.formation_id = e.active_formation_id and s.state = 'JOINED'
    order by fp.fill_rank
    limit least(v_standby, p_limit)
  loop
    perform public.hp_release_member(r.member_id, 'reclaim', 'no_show');
    update public.event_members set status = 'waitlisted' where id = r.member_id;
    v_released := v_released + 1;
  end loop;
  v_assigned := public.hp_promote_waitlist(e.id, v_released);
  update public.event_counters set registered = (select count(*) from public.event_members where event_id = e.id and status = 'registered')
   where event_id = e.id;
  perform public.hp_audit('event.reclaim_no_shows', e.org_id, e.id, 'event', e.id::text,
    jsonb_build_object('standby', v_standby, 'released', v_released, 'assigned', v_assigned));
  return jsonb_build_object('standby', v_standby, 'released', v_released, 'assigned', v_assigned);
end;
$$;

-- Public preview by join code (QR / link / typed code) before signing in. Codes are 8 chars
-- from a 31-letter alphabet (~8.5e11 combinations) and the caller is rate limited per IP-less key.
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
    'consentVersion', e.consent_version
  )
  from public.events e
  join public.organizations o on o.id = e.org_id and o.status = 'active'
  where e.join_code = upper(trim(p_code)) and e.state <> 'DRAFT';
$$;
