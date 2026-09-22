-- join_event v3: on top of v2 (profile + Hall of Fame choice), every participant leaves with the
-- collection point they must go to, chosen as the least loaded one.

create or replace function public.join_event(
  p_code text,
  p_consent_version text,
  p_group_code text default null,
  p_device_id text default null,
  p_public_listing boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  e public.events;
  m public.event_members;
  g public.event_groups;
  prof public.profiles;
  v_number int;
  v_registered int;
  v_idx int;
  v_public boolean;
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
  select * into prof from public.profiles where id = v_uid;
  if prof.first_name is null or prof.birth_year is null or prof.sex is null or prof.nationality is null then
    raise exception 'PROFILE_REQUIRED' using errcode = 'P0001';
  end if;
  v_public := coalesce(p_public_listing, false) and public.hp_age(prof.birth_year) >= 16;
  if p_group_code is not null and trim(p_group_code) <> '' then
    select * into g from public.event_groups where code = upper(trim(p_group_code)) and event_id = e.id;
    if not found then raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;

  update public.event_counters
     set next_participant_number = next_participant_number + 1
   where event_id = e.id
  returning next_participant_number, registered into v_number, v_registered;

  if g.id is not null and g.capacity is not null
     and (select count(*) from public.event_members where group_id = g.id and status = 'registered') >= g.capacity then
    raise exception 'GROUP_FULL' using errcode = 'P0001';
  end if;

  if m.id is not null then
    update public.event_members
       set status = 'waitlisted', cancelled_at = null, consent_version = p_consent_version, consent_at = now(), group_id = g.id,
           birth_year = prof.birth_year, sex = prof.sex, nationality = prof.nationality,
           public_listing = v_public,
           public_name = case when v_public then prof.first_name end,
           public_nationality = case when v_public then prof.nationality end
     where id = m.id returning * into m;
  else
    begin
      insert into public.event_members (event_id, user_id, participant_number, status, group_id, consent_version,
                                        birth_year, sex, nationality, public_listing, public_name, public_nationality)
      values (e.id, v_uid, v_number, 'waitlisted', g.id, p_consent_version,
              prof.birth_year, prof.sex, prof.nationality, v_public,
              case when v_public then prof.first_name end, case when v_public then prof.nationality end)
      returning * into m;
    exception when unique_violation then
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

  -- Spread the load over the collection points (t-shirts, wristbands…): one point per person.
  perform public.hp_assign_pickup(m.id);

  return public.get_my_assignment(e.id);
end;
$$;
