-- HUMAN PIXEL: privilege whitelist. Default deny, then grant exactly what clients may use.
-- RULE FOR FUTURE MIGRATIONS: every new table/function must be added here explicitly
-- (Supabase's default privileges would otherwise expose it to anon/authenticated).

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- Read access (still filtered row-by-row by RLS).
grant select on
  public.profiles, public.organizations, public.organization_members, public.organization_subscriptions,
  public.events, public.event_counters, public.event_state_transitions, public.event_state_history,
  public.event_areas, public.formation_assets, public.formations, public.formation_zones, public.formation_points,
  public.event_groups, public.event_members, public.participant_status, public.assignment_log,
  public.event_photos, public.notifications, public.audit_logs, public.event_stat_snapshots,
  public.platform_settings, public.abuse_reports
to authenticated;

-- Column-level write grants: clients cannot even address protected columns.
grant update (display_name, locale, privacy_version, privacy_accepted_at) on public.profiles to authenticated;
grant update (name, contact_email) on public.organizations to authenticated;
grant update (
  name, timezone, venue_name, center_lat, center_lng, starts_at, arrival_deadline, positions_release_at, capacity,
  tolerance_radius_m, required_accuracy_m, allocation_mode, allow_late_registration, countdown, share_message,
  hashtags, announcement, photo_audience, retention_days, allow_anonymous_join
) on public.events to authenticated;
grant insert (event_id, kind, name, geom, safety_buffer_m, is_public) on public.event_areas to authenticated;
grant update (name, geom, safety_buffer_m, is_public) on public.event_areas to authenticated;
grant delete on public.event_areas to authenticated;
grant insert (event_id, name, code, capacity) on public.event_groups to authenticated;
grant update (name, capacity) on public.event_groups to authenticated;
grant delete on public.event_groups to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant insert (reporter_id, event_id, org_id, target_user_id, reason, details) on public.abuse_reports to authenticated;
grant insert (event_id, storage_path, file_name, mime_type, bytes, created_by) on public.formation_assets to authenticated;
create policy formation_assets_insert on public.formation_assets for insert to authenticated
  with check (public.hp_can_manage_event(event_id) and created_by = auth.uid());

-- RLS helpers are referenced by policies (evaluated as the calling role).
grant execute on function
  public.hp_is_admin(), public.hp_has_org_role(uuid, public.org_role), public.hp_org_rank(public.org_role),
  public.hp_can_view_event(uuid), public.hp_can_manage_event(uuid), public.hp_my_member_id(uuid),
  public.hp_try_uuid(text), public.hp_photo_visible_to_me(text), public.hp_is_internal()
to authenticated;

-- Public manifest (anon: served through the CDN function).
grant execute on function public.get_event_manifest(uuid), public.get_event_preview(text) to anon, authenticated;

-- Participant API.
grant execute on function
  public.join_event(text, text, text, text),
  public.get_my_assignment(uuid),
  public.report_status(uuid, public.participant_state, bigint, timestamptz, real, int, text, text),
  public.cancel_my_participation(uuid),
  public.get_my_photo(uuid),
  public.prepare_account_deletion()
to authenticated;

-- Organizer API (each function re-checks organization role).
grant execute on function
  public.create_organization(text, text),
  public.add_organization_member(uuid, text, public.org_role),
  public.remove_organization_member(uuid, uuid),
  public.create_event(uuid, text, timestamptz, text, int, text, double precision, double precision),
  public.regenerate_join_code(uuid),
  public.transition_event(uuid, public.event_state, text),
  public.formation_create(uuid, jsonb, jsonb, int, bigint, text, jsonb, jsonb, jsonb),
  public.formation_upload_points(uuid, jsonb),
  public.formation_finalize(uuid, bigint),
  public.formation_lock(uuid),
  public.get_formation_points(uuid),
  public.get_formation_live(uuid),
  public.reserve_points_for_group(uuid, smallint, int),
  public.organizer_reassign_member(uuid, int),
  public.organizer_remove_member(uuid, text),
  public.reclaim_no_shows(uuid, int),
  public.get_event_live_stats(uuid),
  public.photo_register(uuid, uuid, public.photo_kind, text, text, text, text, text, int, int, bigint, text, timestamptz, text),
  public.photo_set_primary(uuid),
  public.get_event_evidence(uuid)
to authenticated;

-- Admin API (each function re-checks platform admin).
grant execute on function
  public.admin_list_users(text, int, int),
  public.admin_set_user(uuid, public.platform_role, boolean),
  public.admin_set_organization(uuid, public.org_status, text, int, int),
  public.admin_resolve_report(uuid, public.report_status, text),
  public.admin_set_setting(text, jsonb, boolean),
  public.admin_list_organizations(text),
  public.admin_system_health()
to authenticated;

-- Realtime: organizers subscribe to their events' state changes (RLS-filtered).
alter publication supabase_realtime add table public.events;
