-- Collection / control / bounty points are points, like access points.
alter table public.event_areas drop constraint if exists event_areas_check1;
alter table public.event_areas add constraint event_areas_geometry_kind_check check (
  case when kind in ('access_point', 'collection', 'control', 'bounty')
       then geometrytype(geom) = 'POINT'
       else geometrytype(geom) in ('POLYGON', 'MULTIPOLYGON') end
);
