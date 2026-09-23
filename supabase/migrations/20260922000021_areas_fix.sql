-- get_event_areas counts the participants assigned to each collection point, but organizers have
-- no direct read on event_members (privacy: they go through RPCs). As SECURITY INVOKER the whole
-- listing failed with "permission denied for table event_members", which broke the map editor.
-- Run it as definer with an explicit access check instead.
create or replace function public.get_event_areas(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v jsonb;
begin
  if not public.hp_can_view_event(p_event_id) then perform public.hp_forbid(); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'event_id', a.event_id, 'kind', a.kind, 'name', a.name, 'symbol', a.symbol,
    'geom', st_asgeojson(a.geom, 8)::jsonb, 'safety_buffer_m', a.safety_buffer_m, 'is_public', a.is_public,
    'capacity', a.capacity, 'opens_at', a.opens_at, 'closes_at', a.closes_at, 'details', a.details,
    'assigned', (select count(*) from public.event_members m where m.pickup_area_id = a.id and m.status = 'registered'),
    'area_m2', case when a.kind not in ('access_point', 'collection', 'control', 'bounty') then round(st_area(a.geom::geography)) end
  ) order by a.kind, a.created_at), '[]'::jsonb) into v
  from public.event_areas a where a.event_id = p_event_id;
  return v;
end;
$$;
revoke all on function public.get_event_areas(uuid) from public, anon;
grant execute on function public.get_event_areas(uuid) to authenticated;

-- One perimeter (and one formation area) per event: say so in words the organizer can act on.
create or replace function public.hp_friendly_area_error() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.event_areas a where a.event_id = new.event_id and a.kind = new.kind
               and a.id is distinct from new.id and new.kind in ('perimeter', 'formation_area')) then
    raise exception 'AREA_EXISTS: this event already has a % — select it on the map and use "Edit shape", or delete it first',
      case when new.kind = 'perimeter' then 'perimeter' else 'formation area' end using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.hp_friendly_area_error() from public, anon, authenticated;
drop trigger if exists event_areas_unique_msg on public.event_areas;
create trigger event_areas_unique_msg before insert or update on public.event_areas
  for each row execute function public.hp_friendly_area_error();
