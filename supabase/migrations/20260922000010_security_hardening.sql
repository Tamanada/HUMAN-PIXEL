-- HUMAN PIXEL: security hardening from the adversarial review (2026-09-22).

-- F3: suspended users lose organizer access immediately (RLS helpers, not only RPC entry points).
create or replace function public.hp_has_org_role(p_org uuid, p_min public.org_role) returns boolean
language sql stable security definer set search_path = public as $$
  select public.hp_is_admin() or exists (
    select 1 from public.organization_members om
    join public.organizations o on o.id = om.org_id
    join public.profiles p on p.id = om.user_id and not p.is_suspended
    where om.org_id = p_org and om.user_id = auth.uid()
      and public.hp_org_rank(om.role) >= public.hp_org_rank(p_min)
      and (o.status = 'active' or public.hp_org_rank(p_min) <= 1)
  );
$$;

create or replace function public.hp_can_view_event(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.hp_is_admin() or exists (
    select 1 from public.events e
    join public.organizations o on o.id = e.org_id and o.status = 'active'
    join public.organization_members om on om.org_id = e.org_id
    join public.profiles p on p.id = om.user_id and not p.is_suspended
    where e.id = p_event and om.user_id = auth.uid()
  );
$$;

create or replace function public.hp_can_manage_event(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.hp_is_admin() or exists (
    select 1 from public.events e
    join public.organizations o on o.id = e.org_id and o.status = 'active'
    join public.organization_members om on om.org_id = e.org_id
    join public.profiles p on p.id = om.user_id and not p.is_suspended
    where e.id = p_event and om.user_id = auth.uid() and om.role in ('owner', 'admin')
  );
$$;

-- F4: only owners may change or remove owners; never demote/remove the last owner.
create or replace function public.add_organization_member(p_org_id uuid, p_email text, p_role public.org_role default 'member')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.hp_require_user();
  v_target uuid;
  v_current public.org_role;
begin
  if not public.hp_has_org_role(p_org_id, 'admin') then perform public.hp_forbid(); end if;
  if not public.hp_rate_limit('invite:' || v_uid, 30, interval '1 hour') then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  select id into v_target from auth.users where lower(email) = lower(trim(p_email));
  if v_target is null then
    raise exception 'USER_NOT_FOUND: the person must sign in to HUMAN PIXEL once before being added' using errcode = 'P0001';
  end if;
  select role into v_current from public.organization_members where org_id = p_org_id and user_id = v_target;
  if (p_role = 'owner' or v_current = 'owner') and not public.hp_has_org_role(p_org_id, 'owner') then
    perform public.hp_forbid();
  end if;
  if v_current = 'owner' and p_role <> 'owner'
     and (select count(*) from public.organization_members where org_id = p_org_id and role = 'owner') <= 1 then
    raise exception 'LAST_OWNER' using errcode = 'P0001';
  end if;
  insert into public.organization_members (org_id, user_id, role) values (p_org_id, v_target, p_role)
  on conflict (org_id, user_id) do update set role = excluded.role;
  perform public.hp_audit('organization.member_set', p_org_id, null, 'user', v_target::text, jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.remove_organization_member(p_org_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role public.org_role;
begin
  perform public.hp_require_user();
  if not public.hp_has_org_role(p_org_id, 'admin') then perform public.hp_forbid(); end if;
  select role into v_role from public.organization_members where org_id = p_org_id and user_id = p_user_id;
  if v_role = 'owner' then
    if not public.hp_has_org_role(p_org_id, 'owner') then perform public.hp_forbid(); end if;
    if (select count(*) from public.organization_members where org_id = p_org_id and role = 'owner') <= 1 then
      raise exception 'LAST_OWNER' using errcode = 'P0001';
    end if;
  end if;
  delete from public.organization_members where org_id = p_org_id and user_id = p_user_id;
  perform public.hp_audit('organization.member_remove', p_org_id, null, 'user', p_user_id::text);
end;
$$;

-- F5: photo_register may only update a row of the same event.
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
  if exists (select 1 from public.event_photos where id = p_photo_id and event_id <> p_event_id) then
    perform public.hp_forbid();
  end if;
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
                                   width, height, bytes, sha256, captured_at, camera, uploaded_by, is_primary)
  values (p_photo_id, p_event_id, p_kind, p_title, p_master_path, p_display_path, p_share_path, p_thumb_path,
          p_width, p_height, p_bytes, lower(p_sha256), p_captured_at, p_camera, v_uid,
          p_kind = 'official' and not exists (select 1 from public.event_photos where event_id = p_event_id and is_primary))
  on conflict (id) do update set title = excluded.title
    where public.event_photos.event_id = excluded.event_id
  returning * into v;
  if v.id is null then perform public.hp_forbid(); end if;
  select org_id into v_org from public.events where id = p_event_id;
  perform public.hp_audit('photo.register', v_org, p_event_id, 'photo', v.id::text,
    jsonb_build_object('sha256', v.sha256, 'bytes', v.bytes, 'kind', v.kind));
  return v;
end;
$$;

-- F8: the area trigger scopes the internal bypass to its own statement.
create or replace function public.hp_bump_manifest_from_area() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_prev text := coalesce(current_setting('hp.internal', true), '');
begin
  perform public.hp_internal();
  update public.events set manifest_version = manifest_version + 1 where id = coalesce(new.event_id, old.event_id);
  perform set_config('hp.internal', v_prev, true);
  return null;
end;
$$;

-- F9: plan limit race — serialize event creation per organization.
create or replace function public.hp_lock_org_for_event_create() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_sub public.organization_subscriptions;
  v_active int;
begin
  select * into v_sub from public.organization_subscriptions where org_id = new.org_id for update;
  select count(*) into v_active from public.events where org_id = new.org_id and state not in ('COMPLETED', 'CANCELLED');
  if v_active >= coalesce(v_sub.max_active_events, 0) and not public.hp_is_admin() and auth.uid() is not null then
    raise exception 'PLAN_LIMIT_EVENTS: plan allows % active events', coalesce(v_sub.max_active_events, 0) using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger events_plan_limit before insert on public.events
  for each row execute function public.hp_lock_org_for_event_create();

-- F1 (partial): IP-keyed join limit in front of per-user limits (tolerant of carrier NAT), and
-- late registration off by default (organizers opt in).
create or replace function public.hp_client_ip() returns text
language sql stable as $$
  select coalesce(
    nullif(split_part(coalesce((current_setting('request.headers', true)::jsonb) ->> 'x-forwarded-for', ''), ',', 1), ''),
    (current_setting('request.headers', true)::jsonb) ->> 'cf-connecting-ip',
    'unknown');
$$;

create or replace function public.hp_join_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_ip text := public.hp_client_ip();
begin
  if v_ip <> 'unknown' and not public.hp_rate_limit('join-ip:' || v_ip, 600, interval '10 minutes') then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger event_members_join_guard before insert on public.event_members
  for each row execute function public.hp_join_guard();

alter table public.events alter column allow_late_registration set default false;

-- F2: the deploy guard only counts events with real crowds (a free tenant cannot block deploys).
create or replace function public.deploy_guard() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.events e
  join public.event_counters c on c.event_id = e.id and c.registered >= 100
  where e.state in ('PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY', 'LIVE')
     or (e.state in ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EVENT_PREPARATION')
         and e.starts_at between now() - interval '1 hour' and now() + interval '3 hours');
$$;

-- F7 / F10: privilege whitelist re-asserted; organizers read points only through RPCs, so no
-- client role keeps table SELECT on the formation's geometry (removes planner-statistics leaks).
revoke all on function public.get_event_areas(uuid) from public, anon;
revoke all on function public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid) from public, anon;
revoke all on function public.hp_client_ip(), public.hp_join_guard(), public.hp_lock_org_for_event_create() from public, anon, authenticated;
revoke all on function public.add_organization_member(uuid, text, public.org_role), public.remove_organization_member(uuid, uuid),
  public.photo_register(uuid, uuid, public.photo_kind, text, text, text, text, text, int, int, bigint, text, timestamptz, text)
  from public, anon;
grant execute on function public.add_organization_member(uuid, text, public.org_role), public.remove_organization_member(uuid, uuid),
  public.photo_register(uuid, uuid, public.photo_kind, text, text, text, text, text, int, int, bigint, text, timestamptz, text)
  to authenticated;
revoke select on public.formation_points, public.formation_zones, public.assignment_log from authenticated;
