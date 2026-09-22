-- HUMAN PIXEL: authorization helpers, guard triggers and Row Level Security.
-- Threat model: every participant is assumed to be inspecting and replaying API calls.

-- ---------------------------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER to avoid recursive RLS; STABLE; pinned search_path)
-- ---------------------------------------------------------------------------------------------
create or replace function public.hp_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'admin' and not p.is_suspended
  );
$$;

create or replace function public.hp_org_rank(p_role public.org_role) returns int
language sql immutable as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 else 0 end;
$$;

create or replace function public.hp_has_org_role(p_org uuid, p_min public.org_role) returns boolean
language sql stable security definer set search_path = public as $$
  select public.hp_is_admin() or exists (
    select 1 from public.organization_members om
    join public.organizations o on o.id = om.org_id
    where om.org_id = p_org and om.user_id = auth.uid()
      and public.hp_org_rank(om.role) >= public.hp_org_rank(p_min)
      and (o.status = 'active' or public.hp_org_rank(p_min) <= 1)
  );
$$;

-- Organization members (any role) can view an event's organizer data.
create or replace function public.hp_can_view_event(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.hp_is_admin() or exists (
    select 1 from public.events e
    join public.organization_members om on om.org_id = e.org_id
    where e.id = p_event and om.user_id = auth.uid()
  );
$$;

-- Organization owners/admins manage events of an active organization.
create or replace function public.hp_can_manage_event(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.hp_is_admin() or exists (
    select 1 from public.events e
    join public.organizations o on o.id = e.org_id and o.status = 'active'
    join public.organization_members om on om.org_id = e.org_id
    where e.id = p_event and om.user_id = auth.uid() and om.role in ('owner', 'admin')
  );
$$;

create or replace function public.hp_my_member_id(p_event uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select m.id from public.event_members m
  where m.event_id = p_event and m.user_id = auth.uid() and m.status in ('registered', 'waitlisted');
$$;

create or replace function public.hp_try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

create or replace function public.hp_require_user() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := auth.uid();
begin
  if v is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = v and is_suspended) then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = '42501';
  end if;
  return v;
end;
$$;

create or replace function public.hp_forbid() returns void
language plpgsql as $$
begin
  raise exception 'FORBIDDEN' using errcode = '42501';
end;
$$;

-- Marks the current transaction as trusted internal code (protected-column guard below).
create or replace function public.hp_internal() returns void
language sql as $$
  select set_config('hp.internal', 'on', true);
$$;

create or replace function public.hp_is_internal() returns boolean
language sql stable as $$
  select coalesce(current_setting('hp.internal', true), '') = 'on';
$$;

create or replace function public.hp_audit(
  p_action text, p_org uuid, p_event uuid, p_target_type text, p_target_id text, p_details jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_logs (actor_id, org_id, event_id, action, target_type, target_id, details)
  values (auth.uid(), p_org, p_event, p_action, p_target_type, p_target_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Fixed-window limiter. Returns true when allowed.
create or replace function public.hp_rate_limit(p_key text, p_max int, p_window interval) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / extract(epoch from p_window)) * extract(epoch from p_window));
  v_hits int;
begin
  insert into public.rate_limits (key, window_start, hits) values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  return v_hits <= p_max;
end;
$$;

create or replace function public.hp_setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from public.platform_settings where key = p_key;
$$;

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------
create or replace function public.hp_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles for each row execute function public.hp_touch_updated_at();
create trigger organizations_touch before update on public.organizations for each row execute function public.hp_touch_updated_at();
create trigger events_touch before update on public.events for each row execute function public.hp_touch_updated_at();
create trigger event_areas_touch before update on public.event_areas for each row execute function public.hp_touch_updated_at();

-- New auth user ⇒ profile.
create or replace function public.hp_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, locale)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'locale', ''), 'en'))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.hp_handle_new_user();

-- Profiles: users may edit their display fields only.
create or replace function public.hp_guard_profile() returns trigger
language plpgsql as $$
begin
  if not public.hp_is_internal() and (
    new.platform_role is distinct from old.platform_role or new.is_suspended is distinct from old.is_suspended or new.id <> old.id
  ) then
    raise exception 'PROTECTED_COLUMN' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger profiles_guard before update on public.profiles for each row execute function public.hp_guard_profile();

-- Events: protected columns + state-dependent rules.
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
      new.countdown, new.timezone, new.state)
     is distinct from
     (old.name, old.starts_at, old.arrival_deadline, old.positions_release_at, old.venue_name, old.announcement,
      old.countdown, old.timezone, old.state) then
    new.manifest_version := old.manifest_version + 1;
  end if;
  return new;
end;
$$;
create trigger events_guard before update on public.events for each row execute function public.hp_guard_event();

-- Areas that shape the formation are frozen once a formation is locked.
create or replace function public.hp_guard_area() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_event uuid := coalesce(new.event_id, old.event_id);
  v_kind public.area_kind := coalesce(new.kind, old.kind);
  v_state public.event_state;
  v_locked boolean;
begin
  select e.state, e.active_formation_id is not null into v_state, v_locked from public.events e where e.id = v_event;
  if v_state in ('LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING', 'PHOTO_RELEASED', 'COMPLETED', 'CANCELLED') and not public.hp_is_internal() then
    raise exception 'EVENT_AREAS_FROZEN' using errcode = 'P0001';
  end if;
  if v_locked and v_kind in ('perimeter', 'formation_area', 'exclusion', 'no_go', 'emergency') and not public.hp_is_internal() then
    raise exception 'FORMATION_LOCKED: generate and lock a new formation version to change constraint areas' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.event_id <> old.event_id then
    raise exception 'PROTECTED_COLUMN' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger event_areas_guard before insert or update or delete on public.event_areas
  for each row execute function public.hp_guard_area();

-- Keep the public manifest in sync when public areas change.
create or replace function public.hp_bump_manifest_from_area() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.hp_internal();
  update public.events set manifest_version = manifest_version + 1 where id = coalesce(new.event_id, old.event_id);
  return null;
end;
$$;
create trigger event_areas_bump after insert or update or delete on public.event_areas
  for each row execute function public.hp_bump_manifest_from_area();

-- Organizations: status only via admin functions.
create or replace function public.hp_guard_org() returns trigger
language plpgsql as $$
begin
  if not public.hp_is_internal() and (new.status is distinct from old.status or new.slug is distinct from old.slug or new.created_by is distinct from old.created_by) then
    raise exception 'PROTECTED_COLUMN' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger organizations_guard before update on public.organizations for each row execute function public.hp_guard_org();

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.events enable row level security;
alter table public.event_counters enable row level security;
alter table public.event_state_transitions enable row level security;
alter table public.event_state_history enable row level security;
alter table public.event_areas enable row level security;
alter table public.formation_assets enable row level security;
alter table public.formations enable row level security;
alter table public.formation_zones enable row level security;
alter table public.event_groups enable row level security;
alter table public.event_members enable row level security;
alter table public.formation_points enable row level security;
alter table public.participant_status enable row level security;
alter table public.assignment_log enable row level security;
alter table public.event_photos enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.event_stat_snapshots enable row level security;
alter table public.platform_settings enable row level security;
alter table public.abuse_reports enable row level security;
alter table public.rate_limits enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.hp_is_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- organizations
create policy organizations_select on public.organizations for select to authenticated
  using (public.hp_has_org_role(id, 'member'));
create policy organizations_update on public.organizations for update to authenticated
  using (public.hp_has_org_role(id, 'admin')) with check (public.hp_has_org_role(id, 'admin'));

create policy organization_members_select on public.organization_members for select to authenticated
  using (user_id = auth.uid() or public.hp_has_org_role(org_id, 'member'));

create policy organization_subscriptions_select on public.organization_subscriptions for select to authenticated
  using (public.hp_has_org_role(org_id, 'member'));

-- events: organizer view only. Participants use get_my_assignment() and the public manifest.
create policy events_select on public.events for select to authenticated
  using (public.hp_can_view_event(id));
create policy events_update on public.events for update to authenticated
  using (public.hp_can_manage_event(id)) with check (public.hp_can_manage_event(id));

create policy event_counters_select on public.event_counters for select to authenticated
  using (public.hp_can_view_event(event_id));

create policy event_state_transitions_select on public.event_state_transitions for select to authenticated using (true);

create policy event_state_history_select on public.event_state_history for select to authenticated
  using (public.hp_can_view_event(event_id));

create policy event_areas_select on public.event_areas for select to authenticated
  using (public.hp_can_view_event(event_id));
create policy event_areas_insert on public.event_areas for insert to authenticated
  with check (public.hp_can_manage_event(event_id));
create policy event_areas_update on public.event_areas for update to authenticated
  using (public.hp_can_manage_event(event_id)) with check (public.hp_can_manage_event(event_id));
create policy event_areas_delete on public.event_areas for delete to authenticated
  using (public.hp_can_manage_event(event_id));

-- The secret. Organizer eyes only; participants have no policy and therefore no rows.
create policy formation_assets_select on public.formation_assets for select to authenticated
  using (public.hp_can_view_event(event_id));
create policy formations_select on public.formations for select to authenticated
  using (public.hp_can_view_event(event_id));
create policy formation_zones_select on public.formation_zones for select to authenticated
  using (exists (select 1 from public.formations f where f.id = formation_id and public.hp_can_view_event(f.event_id)));
create policy formation_points_select on public.formation_points for select to authenticated
  using (exists (select 1 from public.formations f where f.id = formation_id and public.hp_can_view_event(f.event_id)));

create policy event_groups_select on public.event_groups for select to authenticated
  using (public.hp_can_view_event(event_id));
create policy event_groups_insert on public.event_groups for insert to authenticated
  with check (public.hp_can_manage_event(event_id));
create policy event_groups_update on public.event_groups for update to authenticated
  using (public.hp_can_manage_event(event_id)) with check (public.hp_can_manage_event(event_id));
create policy event_groups_delete on public.event_groups for delete to authenticated
  using (public.hp_can_manage_event(event_id));

create policy event_members_select on public.event_members for select to authenticated
  using (user_id = auth.uid() or public.hp_can_view_event(event_id));

create policy participant_status_select on public.participant_status for select to authenticated
  using (
    exists (select 1 from public.event_members m where m.id = member_id and m.user_id = auth.uid())
    or public.hp_can_view_event(event_id)
  );

create policy assignment_log_select on public.assignment_log for select to authenticated
  using (public.hp_can_view_event(event_id));

create policy event_photos_select on public.event_photos for select to authenticated
  using (public.hp_can_view_event(event_id));

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (public.hp_is_admin() or (org_id is not null and public.hp_has_org_role(org_id, 'admin')));

create policy event_stat_snapshots_select on public.event_stat_snapshots for select to authenticated
  using (public.hp_can_view_event(event_id));

create policy platform_settings_select on public.platform_settings for select to authenticated
  using (is_public or public.hp_is_admin());

create policy abuse_reports_select on public.abuse_reports for select to authenticated
  using (reporter_id = auth.uid() or public.hp_is_admin());
create policy abuse_reports_insert on public.abuse_reports for insert to authenticated
  with check (reporter_id = auth.uid() and status = 'open' and handled_by is null);

-- rate_limits: no policies at all (internal only).
