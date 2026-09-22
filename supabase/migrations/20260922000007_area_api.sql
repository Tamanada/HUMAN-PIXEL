-- HUMAN PIXEL: GeoJSON API for event areas (the console's map editor speaks GeoJSON, not WKB).
-- RLS and the area guard trigger still apply: these are SECURITY INVOKER.

create or replace function public.get_event_areas(p_event_id uuid) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'event_id', a.event_id, 'kind', a.kind, 'name', a.name,
    'geom', st_asgeojson(a.geom, 8)::jsonb, 'safety_buffer_m', a.safety_buffer_m, 'is_public', a.is_public,
    'area_m2', case when a.kind <> 'access_point' then round(st_area(a.geom::geography)) end
  ) order by a.kind, a.created_at), '[]'::jsonb)
  from public.event_areas a where a.event_id = p_event_id;
$$;

create or replace function public.save_event_area(
  p_event_id uuid, p_kind public.area_kind, p_geojson jsonb, p_name text default null,
  p_safety_buffer_m real default 0, p_is_public boolean default null, p_area_id uuid default null
) returns uuid
language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_geom extensions.geometry := st_setsrid(st_geomfromgeojson(p_geojson::text), 4326);
  v_id uuid;
begin
  if not st_isvalid(v_geom) then
    v_geom := st_makevalid(v_geom);
    if geometrytype(v_geom) not in ('POLYGON', 'MULTIPOLYGON', 'POINT') then
      raise exception 'INVALID_GEOMETRY: the shape intersects itself' using errcode = 'P0001';
    end if;
  end if;
  if p_area_id is null then
    insert into public.event_areas (event_id, kind, name, geom, safety_buffer_m, is_public)
    values (p_event_id, p_kind, p_name, v_geom, coalesce(p_safety_buffer_m, 0),
            coalesce(p_is_public, p_kind not in ('formation_area', 'exclusion')))
    returning id into v_id;
  else
    update public.event_areas
       set name = p_name, geom = v_geom, safety_buffer_m = coalesce(p_safety_buffer_m, 0),
           is_public = coalesce(p_is_public, is_public)
     where id = p_area_id and event_id = p_event_id
    returning id into v_id;
    if v_id is null then raise exception 'AREA_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

grant execute on function public.get_event_areas(uuid) to authenticated;
grant execute on function public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid) to authenticated;
-- SECURITY INVOKER functions run PostGIS as the caller.
grant usage on schema extensions to authenticated;
