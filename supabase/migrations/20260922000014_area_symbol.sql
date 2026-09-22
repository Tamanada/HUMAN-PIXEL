-- Access points get a symbol (medical, exit, toilets…) independent of their free-text name, so a
-- point named "Medical tent north" still renders with the standard green first-aid sign. The
-- registry of symbols and their ISO 7010 / ISO 3864 colours lives in the console.

alter table public.event_areas
  add column if not exists symbol text check (symbol is null or symbol ~ '^[a-z_]{1,32}$');

grant insert (symbol) on public.event_areas to authenticated;
grant update (symbol) on public.event_areas to authenticated;

create or replace function public.get_event_areas(p_event_id uuid) returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'event_id', a.event_id, 'kind', a.kind, 'name', a.name, 'symbol', a.symbol,
    'geom', st_asgeojson(a.geom, 8)::jsonb, 'safety_buffer_m', a.safety_buffer_m, 'is_public', a.is_public,
    'area_m2', case when a.kind <> 'access_point' then round(st_area(a.geom::geography)) end
  ) order by a.kind, a.created_at), '[]'::jsonb)
  from public.event_areas a where a.event_id = p_event_id;
$$;

-- New parameter ⇒ new signature: drop the old one so PostgREST never sees two candidates.
drop function if exists public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid);

create function public.save_event_area(
  p_event_id uuid, p_kind public.area_kind, p_geojson jsonb, p_name text default null,
  p_safety_buffer_m real default 0, p_is_public boolean default null, p_area_id uuid default null,
  p_symbol text default null
) returns uuid
language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_geom extensions.geometry := st_setsrid(st_geomfromgeojson(p_geojson::text), 4326);
  v_polys extensions.geometry;
  v_best extensions.geometry;
  v_id uuid;
begin
  if geometrytype(v_geom) <> 'POINT' then
    if geometrytype(v_geom) not in ('POLYGON', 'MULTIPOLYGON') then
      raise exception 'INVALID_GEOMETRY: draw a closed shape (at least 3 corners)' using errcode = 'P0001';
    end if;
    if not st_isvalid(v_geom) then
      v_polys := st_collectionextract(st_makevalid(v_geom), 3);
      if st_isempty(v_polys) then
        raise exception 'INVALID_GEOMETRY: the outline has no area' using errcode = 'P0001';
      end if;
      select d.geom into v_best from st_dump(v_polys) d order by st_area(d.geom) desc limit 1;
      if st_area(v_best) < 0.9 * st_area(v_polys) then
        raise exception 'INVALID_GEOMETRY: the outline crosses itself; go around the zone once, in one direction' using errcode = 'P0001';
      end if;
      v_geom := v_best;
    end if;
    if st_area(v_geom::geography) < 1 then
      raise exception 'INVALID_GEOMETRY: the shape is too small' using errcode = 'P0001';
    end if;
  end if;
  if p_area_id is null then
    insert into public.event_areas (event_id, kind, name, geom, safety_buffer_m, is_public, symbol)
    values (p_event_id, p_kind, p_name, v_geom, coalesce(p_safety_buffer_m, 0),
            coalesce(p_is_public, p_kind not in ('formation_area', 'exclusion')), p_symbol)
    returning id into v_id;
  else
    update public.event_areas
       set name = p_name, geom = v_geom, safety_buffer_m = coalesce(p_safety_buffer_m, 0),
           is_public = coalesce(p_is_public, is_public), symbol = p_symbol
     where id = p_area_id and event_id = p_event_id
    returning id into v_id;
    if v_id is null then raise exception 'AREA_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

revoke all on function public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid, text) from public, anon;
grant execute on function public.save_event_area(uuid, public.area_kind, jsonb, text, real, boolean, uuid, text) to authenticated;
