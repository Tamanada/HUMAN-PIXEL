-- LOCAL DEVELOPMENT SEED ONLY (supabase db reset). Never runs in staging/production.
-- Sign in with these emails through the one-time code (Mailpit: http://127.0.0.1:55424).

-- The database linter (`supabase db lint`) is plpgsql_check running inside Postgres. Without the
-- extension the command reports nothing and passes, which is how thirteen warnings stayed red in
-- CI and green on every developer machine. Local only: production has no use for it.
create extension if not exists plpgsql_check;

do $$
declare
  v_admin uuid := '00000000-0000-4000-8000-00000000a001';
  v_org uuid := '00000000-0000-4000-8000-00000000b001';
  v_event uuid := '00000000-0000-4000-8000-00000000c001';
begin
  -- GoTrue expects empty strings (not NULL) in token columns and an email identity row.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change,
                          email_change_token_new, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@humanpixel.local', '', now(), now(), now(),
          '{"provider":"email","providers":["email"]}', '{}', '', '', '', '', '', '', '', '')
  on conflict (id) do nothing;
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_admin, v_admin::text, 'email',
          jsonb_build_object('sub', v_admin::text, 'email', 'admin@humanpixel.local', 'email_verified', true), now(), now(), now())
  on conflict do nothing;

  perform set_config('hp.internal', 'on', true);
  update public.profiles set platform_role = 'admin', display_name = 'Platform Admin' where id = v_admin;

  insert into public.organizations (id, name, slug, contact_email, created_by)
  values (v_org, 'Phangan Festivals', 'phangan-festivals', 'events@phangan.example', v_admin)
  on conflict (id) do nothing;
  insert into public.organization_members (org_id, user_id, role) values (v_org, v_admin, 'owner') on conflict do nothing;
  insert into public.organization_subscriptions (org_id, plan, max_participants_per_event, max_active_events)
  values (v_org, 'enterprise', 250000, 100) on conflict (org_id) do nothing;

  insert into public.events (id, org_id, name, slug, join_code, timezone, venue_name, center_lat, center_lng, starts_at, arrival_deadline,
                             positions_release_at, capacity, share_message, hashtags, created_by)
  values (v_event, v_org, 'PHANGAN HUMAN PIXEL 2027', 'phangan-human-pixel-2027', 'PHANGAN7', 'Asia/Bangkok', 'Haad Rin Beach, Koh Phangan',
          9.6768, 100.0674, now() + interval '3 days', now() + interval '3 days' - interval '45 minutes',
          now() + interval '3 days' - interval '6 hours', 12000,
          'I was one of 12,000 people who became ONE HUMAN PIXEL.', array['HumanPixel', 'Phangan'], v_admin)
  on conflict (id) do nothing;
  insert into public.event_counters (event_id) values (v_event) on conflict do nothing;
  insert into public.event_state_history (event_id, from_state, to_state, actor_id, reason) values (v_event, null, 'DRAFT', v_admin, 'seed');

  insert into public.event_areas (event_id, kind, name, geom, safety_buffer_m, is_public) values
    (v_event, 'perimeter', 'Haad Rin beach', extensions.st_geomfromtext(
      'POLYGON((100.0664 9.6748, 100.0684 9.6748, 100.0684 9.6789, 100.0664 9.6789, 100.0664 9.6748))', 4326), 0, true),
    (v_event, 'exclusion', 'Lifeguard tower', extensions.st_geomfromtext(
      'POLYGON((100.0672 9.6766, 100.0674 9.6766, 100.0674 9.6768, 100.0672 9.6768, 100.0672 9.6766))', 4326), 3, false),
    (v_event, 'access_point', 'Main gate', extensions.st_geomfromtext('POINT(100.0666 9.6770)', 4326), 0, true);
end $$;
