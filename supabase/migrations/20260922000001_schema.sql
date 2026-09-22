-- HUMAN PIXEL: core schema.
-- Conventions: every table has RLS (see 000002); writes to sensitive tables only through
-- SECURITY DEFINER functions. No GPS coordinates of participants are ever stored.

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------------------------
create type public.event_state as enum (
  'DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION',
  'POSITIONING', 'READY', 'LIVE', 'PHOTO_CAPTURED', 'PHOTO_PROCESSING', 'PHOTO_RELEASED', 'COMPLETED', 'CANCELLED'
);
create type public.participant_state as enum (
  'JOINED', 'CHECKED_IN', 'ARRIVED', 'IN_POSITION', 'READY', 'LEFT_POSITION', 'COMPLETED'
);
create type public.platform_role as enum ('user', 'admin');
create type public.org_role as enum ('member', 'admin', 'owner');
create type public.org_status as enum ('active', 'suspended');
create type public.member_status as enum ('registered', 'waitlisted', 'cancelled', 'removed');
create type public.area_kind as enum (
  'perimeter', 'formation_area', 'exclusion', 'no_go', 'emergency', 'access_point', 'assembly', 'entry_zone'
);
create type public.formation_status as enum ('uploading', 'ready', 'rejected', 'locked', 'archived');
create type public.allocation_mode as enum ('progressive', 'random', 'sequential');
create type public.photo_kind as enum ('official', 'alternate', 'video', 'evidence');
create type public.photo_status as enum ('ready', 'released', 'withdrawn');
create type public.assignment_action as enum ('assign', 'release', 'reassign', 'reclaim', 'remap', 'reserve', 'unreserve');
create type public.report_status as enum ('open', 'reviewing', 'resolved', 'dismissed');

-- ---------------------------------------------------------------------------------------------
-- Users & organizations
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  locale text not null default 'en' check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  platform_role public.platform_role not null default 'user',
  is_suspended boolean not null default false,
  privacy_version text,
  privacy_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,59}$'),
  status public.org_status not null default 'active',
  contact_email text check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

create table public.organization_subscriptions (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro', 'enterprise')),
  max_participants_per_event int not null default 1000 check (max_participants_per_event between 1 and 250000),
  max_active_events int not null default 1 check (max_active_events between 0 and 1000),
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled')),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(name) between 3 and 120),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  join_code text not null unique check (join_code ~ '^[A-Z0-9]{6,10}$'),
  state public.event_state not null default 'DRAFT',
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  venue_name text check (char_length(venue_name) <= 160),
  center_lat double precision check (center_lat between -90 and 90),
  center_lng double precision check (center_lng between -180 and 180),
  starts_at timestamptz,
  arrival_deadline timestamptz,
  positions_release_at timestamptz,
  capacity int not null default 1000 check (capacity between 1 and 250000),
  tolerance_radius_m real not null default 3 check (tolerance_radius_m between 0.5 and 50),
  required_accuracy_m real not null default 10 check (required_accuracy_m between 1 and 100),
  allocation_mode public.allocation_mode not null default 'progressive',
  allow_late_registration boolean not null default true,
  -- Instant join without email (anonymous auth). Faster gates, weaker anti-scraping: organizer's call.
  allow_anonymous_join boolean not null default false,
  countdown jsonb not null default '{"vibrate": true, "sound": false, "flash": true, "finalSeconds": 10}'::jsonb,
  share_message text check (char_length(share_message) <= 280),
  hashtags text[] not null default '{}' check (cardinality(hashtags) <= 10),
  announcement text check (char_length(announcement) <= 280),
  photo_audience text not null default 'registered' check (photo_audience in ('registered', 'checked_in')),
  retention_days int not null default 90 check (retention_days between 7 and 3650),
  consent_version text not null default '2026-09-v1',
  active_formation_id uuid,
  assignment_epoch int not null default 0,
  manifest_version int not null default 1,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  live_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  unique (org_id, slug),
  check (arrival_deadline is null or starts_at is null or arrival_deadline <= starts_at),
  check (jsonb_typeof(countdown) = 'object')
);
create index events_org_idx on public.events (org_id);
create index events_active_state_idx on public.events (state) where state not in ('COMPLETED', 'CANCELLED');

-- Hot counters live outside `events` so thousands of concurrent joins never lock the event row.
create table public.event_counters (
  event_id uuid primary key references public.events (id) on delete cascade,
  next_participant_number int not null default 0,
  registered int not null default 0
);

create table public.event_state_transitions (
  from_state public.event_state not null,
  to_state public.event_state not null,
  primary key (from_state, to_state)
);

-- Mirrored by packages/core/src/stateMachine.ts (a unit test asserts equality).
insert into public.event_state_transitions (from_state, to_state) values
  ('DRAFT', 'REGISTRATION_OPEN'), ('DRAFT', 'CANCELLED'),
  ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED'), ('REGISTRATION_OPEN', 'EVENT_PREPARATION'), ('REGISTRATION_OPEN', 'CANCELLED'),
  ('REGISTRATION_CLOSED', 'REGISTRATION_OPEN'), ('REGISTRATION_CLOSED', 'EVENT_PREPARATION'), ('REGISTRATION_CLOSED', 'CANCELLED'),
  ('EVENT_PREPARATION', 'PARTICIPANT_NAVIGATION'), ('EVENT_PREPARATION', 'CANCELLED'),
  ('PARTICIPANT_NAVIGATION', 'POSITIONING'), ('PARTICIPANT_NAVIGATION', 'CANCELLED'),
  ('POSITIONING', 'READY'), ('POSITIONING', 'PARTICIPANT_NAVIGATION'), ('POSITIONING', 'LIVE'), ('POSITIONING', 'CANCELLED'),
  ('READY', 'LIVE'), ('READY', 'POSITIONING'), ('READY', 'CANCELLED'),
  ('LIVE', 'PHOTO_CAPTURED'), ('LIVE', 'CANCELLED'),
  ('PHOTO_CAPTURED', 'PHOTO_PROCESSING'), ('PHOTO_CAPTURED', 'PHOTO_RELEASED'),
  ('PHOTO_PROCESSING', 'PHOTO_RELEASED'),
  ('PHOTO_RELEASED', 'COMPLETED');

create table public.event_state_history (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events (id) on delete cascade,
  from_state public.event_state,
  to_state public.event_state not null,
  actor_id uuid references auth.users (id) on delete set null,
  is_system boolean not null default false,
  reason text check (char_length(reason) <= 500),
  at timestamptz not null default now()
);
create index event_state_history_event_idx on public.event_state_history (event_id, at);

-- Boundaries & safety geometry (WGS84). `formation_area` is never public: it outlines the secret.
create table public.event_areas (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  kind public.area_kind not null,
  name text check (char_length(name) <= 120),
  geom extensions.geometry(Geometry, 4326) not null,
  safety_buffer_m real not null default 0 check (safety_buffer_m between 0 and 200),
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'formation_area' or not is_public),
  check (
    (kind = 'access_point' and extensions.geometrytype(geom) = 'POINT')
    or (kind <> 'access_point' and extensions.geometrytype(geom) in ('POLYGON', 'MULTIPOLYGON'))
  ),
  check (extensions.st_isvalid(geom))
);
create unique index event_areas_one_perimeter on public.event_areas (event_id) where kind = 'perimeter';
create index event_areas_event_idx on public.event_areas (event_id, kind);
create index event_areas_geom_idx on public.event_areas using gist (geom);

-- ---------------------------------------------------------------------------------------------
-- Formations (secret)
-- ---------------------------------------------------------------------------------------------
create table public.formation_assets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) <= 200),
  mime_type text not null check (mime_type in ('image/png', 'image/svg+xml', 'image/jpeg', 'image/webp')),
  bytes bigint not null check (bytes between 1 and 20971520),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index formation_assets_event_idx on public.formation_assets (event_id);

create table public.formations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  version int not null,
  status public.formation_status not null default 'uploading',
  source jsonb not null,
  params jsonb not null,
  engine_version text not null check (char_length(engine_version) <= 32),
  seed bigint not null,
  point_count int not null check (point_count between 1 and 250000),
  uploaded_count int not null default 0,
  checksum bigint,
  metrics jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  validation jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  locked_at timestamptz,
  archived_at timestamptz,
  unique (event_id, version)
);
create index formations_event_idx on public.formations (event_id);

alter table public.events
  add constraint events_active_formation_fk foreign key (active_formation_id)
  references public.formations (id) on delete set null deferrable initially deferred;

create table public.formation_zones (
  formation_id uuid not null references public.formations (id) on delete cascade,
  zone smallint not null check (zone >= 0),
  label text not null check (char_length(label) <= 4),
  point_count int not null,
  centroid_lat double precision not null,
  centroid_lng double precision not null,
  primary key (formation_id, zone)
);

create table public.event_groups (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  code text not null unique check (code ~ '^[A-Z0-9]{6,12}$'),
  capacity int check (capacity is null or capacity > 0),
  created_at timestamptz not null default now()
);
create index event_groups_event_idx on public.event_groups (event_id);

create table public.event_members (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  -- NULL after anonymisation (account deletion / retention). Evidence counts remain valid.
  user_id uuid references auth.users (id) on delete set null,
  participant_number int not null,
  status public.member_status not null default 'registered',
  group_id uuid references public.event_groups (id) on delete set null,
  consent_version text not null,
  consent_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  cancelled_at timestamptz,
  anonymized_at timestamptz,
  unique (event_id, participant_number)
);
create unique index event_members_event_user_uq on public.event_members (event_id, user_id) where user_id is not null;
create index event_members_user_idx on public.event_members (user_id);
create index event_members_event_status_idx on public.event_members (event_id, status, participant_number);

-- One row per target position. `member_id` IS the assignment: UNIQUE ⇒ no member holds two
-- points and no point has two holders, enforced by the database, not by application code.
create table public.formation_points (
  formation_id uuid not null references public.formations (id) on delete cascade,
  idx int not null check (idx >= 0),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  x_m real not null,
  y_m real not null,
  zone smallint not null,
  fill_rank int not null,
  label int not null,
  shuffle_key int not null,
  reserved_group_id uuid references public.event_groups (id) on delete set null,
  member_id uuid references public.event_members (id) on delete set null,
  assigned_at timestamptz,
  primary key (formation_id, idx)
) with (fillfactor = 90);
create unique index formation_points_member_uq on public.formation_points (member_id);
create unique index formation_points_label_uq on public.formation_points (formation_id, label);
create unique index formation_points_rank_uq on public.formation_points (formation_id, fill_rank);
-- Free-pool indexes, one per allocation mode: claiming a point is an index-ordered LIMIT 1 with SKIP LOCKED.
create index formation_points_free_progressive on public.formation_points (formation_id, fill_rank)
  where member_id is null and reserved_group_id is null;
create index formation_points_free_random on public.formation_points (formation_id, shuffle_key)
  where member_id is null and reserved_group_id is null;
create index formation_points_free_sequential on public.formation_points (formation_id, idx)
  where member_id is null and reserved_group_id is null;
create index formation_points_reserved on public.formation_points (reserved_group_id, fill_rank)
  where reserved_group_id is not null and member_id is null;

-- Updated in place (never appended): the state, not a history. Index only on event_id so the
-- frequent state updates stay HOT.
create table public.participant_status (
  member_id uuid primary key references public.event_members (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  state public.participant_state not null default 'JOINED',
  last_seq bigint not null default 0,
  last_client_at timestamptz,
  device_id text check (char_length(device_id) <= 64),
  app_version text check (char_length(app_version) <= 32),
  accuracy_m real,
  clock_uncertainty_ms int,
  report_count int not null default 0,
  state_changed_at timestamptz not null default now(),
  reported_at timestamptz,
  checked_in_at timestamptz,
  first_in_position_at timestamptz,
  ready_at timestamptz
) with (fillfactor = 80);
create index participant_status_event_idx on public.participant_status (event_id);

create table public.assignment_log (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events (id) on delete cascade,
  formation_id uuid not null,
  point_idx int,
  member_id uuid,
  action public.assignment_action not null,
  reason text,
  actor_id uuid,
  at timestamptz not null default now()
);
create index assignment_log_event_idx on public.assignment_log (event_id, at);
create index assignment_log_member_idx on public.assignment_log (member_id);

-- ---------------------------------------------------------------------------------------------
-- Media, notifications, operations
-- ---------------------------------------------------------------------------------------------
create table public.event_photos (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  kind public.photo_kind not null default 'official',
  status public.photo_status not null default 'ready',
  is_primary boolean not null default false,
  title text check (char_length(title) <= 120),
  master_path text not null,
  display_path text not null,
  share_path text not null,
  thumb_path text not null,
  width int check (width > 0),
  height int check (height > 0),
  bytes bigint check (bytes > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz,
  camera text check (char_length(camera) <= 120),
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create unique index event_photos_one_primary on public.event_photos (event_id) where is_primary;
create index event_photos_event_idx on public.event_photos (event_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_id uuid references public.events (id) on delete cascade,
  kind text not null check (char_length(kind) <= 40),
  title text not null check (char_length(title) <= 120),
  body text check (char_length(body) <= 500),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  org_id uuid,
  event_id uuid,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb
);
create index audit_logs_at_idx on public.audit_logs (at desc);
create index audit_logs_org_idx on public.audit_logs (org_id, at desc);
create index audit_logs_event_idx on public.audit_logs (event_id, at desc);

create table public.event_stat_snapshots (
  event_id uuid not null references public.events (id) on delete cascade,
  at timestamptz not null default now(),
  state public.event_state not null,
  counts jsonb not null,
  primary key (event_id, at)
);

create table public.platform_settings (
  key text primary key check (key ~ '^[a-z0-9_.]{2,64}$'),
  value jsonb not null,
  is_public boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (key, value, is_public) values
  ('default_plan', '{"plan": "free", "max_participants_per_event": 1000, "max_active_events": 1}', false),
  ('registration_enabled', 'true', true),
  ('maintenance_message', 'null', true),
  ('privacy_version', '"2026-09-v1"', true),
  ('health.report_rate_high', '400', false),
  ('health.db_latency_high_ms', '250', false);

create table public.abuse_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users (id) on delete set null,
  event_id uuid references public.events (id) on delete set null,
  org_id uuid references public.organizations (id) on delete set null,
  target_user_id uuid references auth.users (id) on delete set null,
  reason text not null check (reason in ('spam', 'harassment', 'unsafe_event', 'impersonation', 'privacy', 'other')),
  details text check (char_length(details) <= 2000),
  status public.report_status not null default 'open',
  resolution text check (char_length(resolution) <= 2000),
  handled_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index abuse_reports_status_idx on public.abuse_reports (status, created_at desc);

-- Fixed-window rate limiting. UNLOGGED: losing counters on a crash is harmless and writes are cheap.
create unlogged table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);
