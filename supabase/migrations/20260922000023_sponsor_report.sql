-- ---------------------------------------------------------------------------------------------
-- SPONSOR REPORT
--
-- What a brand receives the morning after: how many people actually came, stood in position and
-- were sent to which collection point — the thing that is sold, and the thing no other activation
-- can prove.
--
-- Rule of the house: this function returns ONLY what the database witnessed. "Assigned" is a
-- decision we made; "checked in" is a phone that reported; "in position" is a phone that reported
-- from inside its tolerance radius. Nothing here is modelled, estimated or extrapolated, because
-- the moment one number is invented the whole report is worth nothing.
--
-- The peak matters more than the final count: people drift off after the photo, so the honest
-- headline is the largest simultaneous figure the snapshots recorded, with the time it happened.
-- ---------------------------------------------------------------------------------------------

alter table public.events add column if not exists sponsor jsonb not null default '{}'::jsonb;
grant update (sponsor) on public.events to authenticated;

create or replace function public.get_event_sponsor_report(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  e public.events;
  v jsonb;
  v_peak_pos record;
  v_peak_in record;
begin
  if not public.hp_can_view_event(p_event_id) then perform public.hp_forbid(); end if;
  select * into e from public.events where id = p_event_id;
  if e.id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  -- Largest simultaneous attendance the 30-second snapshots saw, and when.
  select (counts->>'in_position')::int n, at into v_peak_pos
  from public.event_stat_snapshots where event_id = e.id
  order by (counts->>'in_position')::int desc nulls last, at limit 1;
  select (counts->>'checked_in')::int n, at into v_peak_in
  from public.event_stat_snapshots where event_id = e.id
  order by (counts->>'checked_in')::int desc nulls last, at limit 1;

  v := jsonb_build_object(
    'generated_at', now(),
    'event', jsonb_build_object('id', e.id, 'name', e.name, 'state', e.state, 'timezone', e.timezone,
      'venue_name', e.venue_name, 'starts_at', e.starts_at, 'live_at', e.live_at, 'completed_at', e.completed_at),
    'organization', (select jsonb_build_object('name', o.name, 'contact_email', o.contact_email)
                     from public.organizations o where o.id = e.org_id),
    'sponsor', e.sponsor,
    'briefing', e.briefing,
    'design', (select jsonb_build_object(
                 'message', f.source->>'text', 'kind', f.source->>'kind', 'font', f.source->>'fontName',
                 'version', f.version, 'pixels', f.point_count, 'locked_at', f.locked_at,
                 'footprint_w_m', round((f.metrics->>'footprintWidthM')::numeric), 'footprint_h_m', round((f.metrics->>'footprintHeightM')::numeric),
                 'readability', f.metrics->>'readabilityScore')
               from public.formations f where f.id = e.active_formation_id),
    'audience', jsonb_build_object(
      'capacity', e.capacity,
      'registered', (select count(*) from public.event_members where event_id = e.id and status = 'registered'),
      'waitlisted', (select count(*) from public.event_members where event_id = e.id and status = 'waitlisted'),
      'cancelled', (select count(*) from public.event_members where event_id = e.id and status = 'cancelled')),
    'delivery', jsonb_build_object(
      'peak_in_position', coalesce(v_peak_pos.n, 0), 'peak_in_position_at', v_peak_pos.at,
      'peak_checked_in', coalesce(v_peak_in.n, 0), 'peak_checked_in_at', v_peak_in.at,
      'at_formation', (select counts from public.event_stat_snapshots where event_id = e.id and state = 'LIVE' order by at limit 1),
      'now', public.hp_event_counts(e.id)),
    -- Per collection / control / bounty point: how many people were sent there, and how many of
    -- them turned up at all. We never claim a t-shirt changed hands: nothing scans one.
    'pickups', (select coalesce(jsonb_agg(p order by p->>'kind', p->>'name'), '[]') from (
        select jsonb_build_object(
          'id', a.id, 'kind', a.kind, 'name', a.name, 'details', a.details, 'capacity', a.capacity,
          'assigned', count(m.id) filter (where m.status = 'registered'),
          'checked_in', count(m.id) filter (where m.status = 'registered' and coalesce(s.state::text, 'JOINED') <> 'JOINED')
        ) p
        from public.event_areas a
        left join public.event_members m on m.pickup_area_id = a.id
        left join public.participant_status s on s.member_id = m.id
        where a.event_id = e.id and a.kind in ('collection', 'control', 'bounty')
        group by a.id, a.kind, a.name, a.details, a.capacity) q),
    'curve', (select coalesce(jsonb_agg(jsonb_build_object(
                'at', at, 'checked_in', (counts->>'checked_in')::int, 'in_position', (counts->>'in_position')::int) order by at), '[]')
              from public.event_stat_snapshots where event_id = e.id),
    'photos', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', id, 'kind', kind, 'is_primary', is_primary, 'display_path', display_path,
                 'width', width, 'height', height, 'captured_at', captured_at, 'released_at', released_at) order by is_primary desc, captured_at), '[]')
               from public.event_photos where event_id = e.id and status = 'ready')
  );
  -- Same tamper-evident seal as the record evidence: the brand can have the figures checked.
  return v || jsonb_build_object('sha256', encode(digest(v::text, 'sha256'), 'hex'));
end;
$$;

-- House rule: strip Supabase's default privileges (anon included) before granting.
revoke all on function public.get_event_sponsor_report(uuid) from public, anon;
grant execute on function public.get_event_sponsor_report(uuid) to authenticated;
