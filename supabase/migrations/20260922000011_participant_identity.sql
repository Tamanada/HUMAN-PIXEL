-- HUMAN PIXEL: participant identity (first name, age, sex, nationality) and the public Hall of Fame.
-- Privacy rules:
--   * first name + nationality are public ONLY for members who opted in for that event (default: anonymous)
--   * age and sex are never public: organizers get aggregated demographics only
--   * participants under 16 can never be listed publicly (GDPR digital consent age)
--   * the pixel number / position is never part of the Hall of Fame

alter table public.profiles
  add column first_name text check (first_name is null or char_length(first_name) between 1 and 40),
  add column birth_year smallint check (birth_year is null or birth_year between 1900 and 2100),
  add column sex text check (sex is null or sex in ('female', 'male', 'other', 'undisclosed')),
  add column nationality char(2) check (nationality is null or nationality ~ '^[A-Z]{2}$');

-- Per-event snapshot: demographics as of joining (statistics survive later profile edits) and the
-- public listing chosen for this event.
alter table public.event_members
  add column birth_year smallint,
  add column sex text,
  add column nationality char(2),
  add column public_listing boolean not null default false,
  add column public_name text check (public_name is null or char_length(public_name) between 1 and 40),
  add column public_nationality char(2),
  add constraint event_members_public_consistency check (
    (public_listing and public_name is not null) or (not public_listing and public_name is null and public_nationality is null)
  );
create index event_members_hall_idx on public.event_members (event_id, public_name) where public_listing;

create or replace function public.hp_age(p_birth_year smallint) returns int
language sql stable as $$
  select case when p_birth_year is null then null else extract(year from now())::int - p_birth_year end;
$$;

-- Name hygiene: letters (any script), spaces, apostrophes and hyphens only; no links, no digits.
create or replace function public.hp_clean_first_name(p text) returns text
language plpgsql immutable as $$
declare
  v text := regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g');
begin
  if char_length(v) < 1 or char_length(v) > 40 or v !~ '^[[:alpha:]][[:alpha:] ''’.-]*$' then
    raise exception 'INVALID_FIRST_NAME' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

create or replace function public.save_my_profile(p_first_name text, p_age int, p_sex text, p_nationality text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  v_name text := public.hp_clean_first_name(p_first_name);
  v_nat text := upper(trim(p_nationality));
begin
  if p_age is null or p_age < 5 or p_age > 110 then raise exception 'INVALID_AGE' using errcode = 'P0001'; end if;
  if p_sex not in ('female', 'male', 'other', 'undisclosed') then raise exception 'INVALID_SEX' using errcode = 'P0001'; end if;
  if v_nat !~ '^[A-Z]{2}$' then raise exception 'INVALID_NATIONALITY' using errcode = 'P0001'; end if;
  update public.profiles
     set first_name = v_name,
         birth_year = (extract(year from now())::int - p_age)::smallint,
         sex = p_sex,
         nationality = v_nat
   where id = v_uid;
  -- Keep this person's public Hall of Fame entries in sync; withdraw them if now under 16.
  update public.event_members
     set public_name = case when p_age >= 16 then v_name end,
         public_nationality = case when p_age >= 16 then v_nat end,
         public_listing = p_age >= 16
   where user_id = v_uid and public_listing;
  return public.get_my_profile();
end;
$$;

create or replace function public.get_my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'first_name', p.first_name,
    'age', public.hp_age(p.birth_year),
    'sex', p.sex,
    'nationality', p.nationality,
    'complete', p.first_name is not null and p.birth_year is not null and p.sex is not null and p.nationality is not null
  )
  from public.profiles p where p.id = auth.uid();
$$;

-- Opt in / out of the Hall of Fame for one event. Can be changed at any time.
create or replace function public.set_my_listing(p_event_id uuid, p_public boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  p public.profiles;
  v_member uuid;
begin
  select * into p from public.profiles where id = v_uid;
  select id into v_member from public.event_members
   where event_id = p_event_id and user_id = v_uid and status in ('registered', 'waitlisted');
  if v_member is null then raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0002'; end if;
  if p_public then
    if p.first_name is null or p.nationality is null then raise exception 'PROFILE_REQUIRED' using errcode = 'P0001'; end if;
    if public.hp_age(p.birth_year) < 16 then raise exception 'TOO_YOUNG_FOR_PUBLIC_LISTING' using errcode = 'P0001'; end if;
    update public.event_members set public_listing = true, public_name = p.first_name, public_nationality = p.nationality
     where id = v_member;
  else
    update public.event_members set public_listing = false, public_name = null, public_nationality = null
     where id = v_member;
  end if;
  return p_public;
end;
$$;

-- join_event v2: requires a complete profile, snapshots demographics, records the listing choice.
drop function if exists public.join_event(text, text, text, text);
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

  return public.get_my_assignment(e.id);
end;
$$;

-- The participant bundle now tells the phone whether this person is listed.
create or replace function public.get_my_listing(p_event_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public_listing from public.event_members where event_id = p_event_id and user_id = auth.uid()), false);
$$;

-- Public Hall of Fame (anon-callable, paginated). First name + nationality of opted-in members only.
create or replace function public.get_hall_of_fame(p_event_id uuid, p_limit int default 200, p_offset int default 0, p_nationality text default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with e as (
    select id, name, state, starts_at, timezone, venue_name from public.events where id = p_event_id and state <> 'DRAFT'
  ), listed as (
    select m.public_name, m.public_nationality, m.participant_number
    from public.event_members m, e
    where m.event_id = e.id and m.public_listing and m.status = 'registered'
  )
  select case when (select id from e) is null then null else jsonb_build_object(
    'event', (select jsonb_build_object('id', id, 'name', name, 'state', state, 'startsAt', starts_at, 'timezone', timezone, 'venueName', venue_name) from e),
    'participants', (select registered from public.event_counters where event_id = p_event_id),
    'listed', (select count(*) from listed),
    'countries', (select count(distinct public_nationality) from listed),
    'byNationality', (select coalesce(jsonb_agg(jsonb_build_object('code', n, 'count', c) order by c desc, n), '[]'::jsonb)
                      from (select public_nationality n, count(*) c from listed group by 1) x),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('name', public_name, 'nationality', public_nationality) order by participant_number), '[]'::jsonb)
               from (select * from listed
                     where p_nationality is null or public_nationality = upper(p_nationality)
                     order by participant_number
                     limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)) page)
  ) end;
$$;

-- Organizer demographics: aggregates only; any bucket under 3 people is suppressed.
create or replace function public.get_event_demographics(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  if not public.hp_can_view_event(p_event_id) then perform public.hp_forbid(); end if;
  with m as (
    select public.hp_age(birth_year) age, sex, nationality, public_listing
    from public.event_members where event_id = p_event_id and status = 'registered'
  ), ages as (
    select case when age is null then 'unknown' when age < 18 then '<18' when age < 25 then '18-24' when age < 35 then '25-34'
                when age < 45 then '35-44' when age < 55 then '45-54' when age < 65 then '55-64' else '65+' end bucket, count(*) c
    from m group by 1
  )
  select jsonb_build_object(
    'total', (select count(*) from m),
    'listed', (select count(*) from m where public_listing),
    'medianAge', (select percentile_cont(0.5) within group (order by age) from m),
    'ageBuckets', (select coalesce(jsonb_object_agg(bucket, case when c < 3 then null else c end), '{}'::jsonb) from ages),
    'sex', (select coalesce(jsonb_object_agg(coalesce(sex, 'unknown'), case when c < 3 then null else c end), '{}'::jsonb)
            from (select sex, count(*) c from m group by 1) s),
    'nationalities', (select coalesce(jsonb_agg(jsonb_build_object('code', nationality, 'count', c) order by c desc), '[]'::jsonb)
                      from (select nationality, count(*) c from m where nationality is not null group by 1 having count(*) >= 3) n),
    'countries', (select count(distinct nationality) from m)
  ) into v;
  return v;
end;
$$;

-- Account deletion also withdraws Hall of Fame entries and demographic snapshots.
create or replace function public.hp_scrub_identity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null and old.user_id is not null then
    new.public_listing := false;
    new.public_name := null;
    new.public_nationality := null;
  end if;
  return new;
end;
$$;
create trigger event_members_scrub_identity before update of user_id on public.event_members
  for each row execute function public.hp_scrub_identity();

-- Grants (whitelist discipline).
revoke all on function public.hp_age(smallint), public.hp_clean_first_name(text), public.hp_scrub_identity() from public, anon, authenticated;
revoke all on function public.save_my_profile(text, int, text, text), public.get_my_profile(), public.set_my_listing(uuid, boolean),
  public.join_event(text, text, text, text, boolean), public.get_my_listing(uuid), public.get_hall_of_fame(uuid, int, int, text),
  public.get_event_demographics(uuid) from public, anon;
grant execute on function public.save_my_profile(text, int, text, text), public.get_my_profile(), public.set_my_listing(uuid, boolean),
  public.join_event(text, text, text, text, boolean), public.get_my_listing(uuid), public.get_event_demographics(uuid) to authenticated;
grant execute on function public.get_hall_of_fame(uuid, int, int, text) to anon, authenticated;
-- Identity columns are written only through save_my_profile (validation); no direct column grants.

-- Individual age / sex / nationality snapshots are never readable through the API (organizers get
-- get_event_demographics aggregates). Column-level SELECT whitelist on event_members.
revoke select on public.event_members from authenticated;
grant select (id, event_id, user_id, participant_number, status, group_id, consent_version, consent_at, joined_at,
              cancelled_at, anonymized_at, public_listing, public_name, public_nationality)
  on public.event_members to authenticated;
