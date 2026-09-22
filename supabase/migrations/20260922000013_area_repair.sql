-- Hand-drawn outlines (clicked corners or freehand traces) often cross themselves slightly: a
-- double-click spike, a lasso that overshoots its start. Repair instead of refusing:
--   ST_MakeValid → keep polygons only → keep the largest part, provided the parts dropped are
--   small (< 10 % of the area); otherwise the drawing is genuinely ambiguous and is refused.
-- One polygon per area keeps the engine's constraint model simple (one perimeter ring).

create or replace function public.save_event_area(
  p_event_id uuid, p_kind public.area_kind, p_geojson jsonb, p_name text default null,
  p_safety_buffer_m real default 0, p_is_public boolean default null, p_area_id uuid default null
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
