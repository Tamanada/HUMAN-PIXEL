/**
 * MapLibre wrapper for the organizer: event areas, formation points (up to 250k as a single
 * GeoJSON source rendered by the GPU), and a minimal, dependable polygon/point drawing tool.
 */
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LngLatLike, Map as MlMap } from 'maplibre-gl';
import { Layers } from 'lucide-react';
import { config } from '../lib/supabase';
import type { AreaRow } from '../lib/types';

export const AREA_STYLE: Record<AreaRow['kind'], { color: string; label: string; fill: number }> = {
  perimeter: { color: '#8c7cff', label: 'Event perimeter', fill: 0.05 },
  formation_area: { color: '#4fe3ff', label: 'Formation area (secret)', fill: 0.08 },
  exclusion: { color: '#ff4d5e', label: 'Exclusion (obstacle)', fill: 0.25 },
  no_go: { color: '#ff8a3d', label: 'No-go zone', fill: 0.25 },
  emergency: { color: '#ffd23f', label: 'Emergency corridor', fill: 0.25 },
  access_point: { color: '#2be38f', label: 'Access point', fill: 0 },
  assembly: { color: '#2be38f', label: 'Assembly area', fill: 0.12 },
  entry_zone: { color: '#9ad0ff', label: 'Entry zone', fill: 0.12 },
};

export type DrawMode = { kind: 'polygon' | 'point'; onDone: (geom: GeoJSON.Polygon | GeoJSON.Point) => void } | null;

export interface PointsLayer {
  lng: Float64Array | number[];
  lat: Float64Array | number[];
  /** Optional per-point category (0..7) for coloring, e.g. live participant state. */
  category?: Uint8Array | number[];
  palette?: string[];
  radius?: number;
}

interface Props {
  areas?: AreaRow[];
  points?: PointsLayer | null;
  center?: { lat: number; lng: number } | null;
  draw?: DrawMode;
  height?: number | string;
  selectedAreaId?: string | null;
  onAreaClick?: (id: string) => void;
  onMapClick?: (lngLat: { lat: number; lng: number }) => void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function MapView({ areas = [], points, center, draw, height = 520, selectedAreaId, onAreaClick, onMapClick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const drawState = useRef<{ coords: [number, number][] }>({ coords: [] });
  const fitted = useRef(false);

  // Init once.
  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: config.mapStyleUrl,
      center: center ? [center.lng, center.lat] : [100.0402, 9.6664],
      zoom: center ? 16 : 3,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => {
      if (config.satelliteTiles) {
        m.addSource('sat', { type: 'raster', tiles: [config.satelliteTiles], tileSize: 256, attribution: config.satelliteAttribution });
        m.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } });
      }
      m.addSource('areas', { type: 'geojson', data: EMPTY });
      m.addLayer({ id: 'areas-fill', type: 'fill', source: 'areas', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'] } });
      m.addLayer({
        id: 'areas-line',
        type: 'line',
        source: 'areas',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'selected'], 3.5, 2], 'line-dasharray': ['case', ['==', ['get', 'kind'], 'formation_area'], ['literal', [2, 2]], ['literal', [1, 0]]] },
      });
      m.addLayer({ id: 'areas-point', type: 'circle', source: 'areas', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } });
      m.addSource('points', { type: 'geojson', data: EMPTY });
      m.addLayer({
        id: 'points',
        type: 'circle',
        source: 'points',
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 14, 0.6, 18, 3.2, 21, 20],
          'circle-color': ['coalesce', ['get', 'c'], '#8c7cff'],
          'circle-opacity': 0.95,
        },
      });
      m.addSource('draft', { type: 'geojson', data: EMPTY });
      m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1] } });
      m.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff' } });
      setReady(true);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Areas.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: areas.map((a) => ({
        type: 'Feature',
        id: a.id,
        geometry: a.geom,
        properties: { id: a.id, kind: a.kind, color: AREA_STYLE[a.kind].color, fill: AREA_STYLE[a.kind].fill, selected: a.id === selectedAreaId },
      })),
    };
    (m.getSource('areas') as GeoJSONSource).setData(fc);
    if (!fitted.current && areas.length) {
      const b = new maplibregl.LngLatBounds();
      for (const a of areas) visitCoords(a.geom, (c) => b.extend(c as LngLatLike));
      if (!b.isEmpty()) {
        m.fitBounds(b, { padding: 60, duration: 0, maxZoom: 18 });
        fitted.current = true;
      }
    }
  }, [areas, ready, selectedAreaId]);

  // Points.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource('points') as GeoJSONSource;
    if (!points) return void src.setData(EMPTY);
    const n = points.lng.length;
    const features: GeoJSON.Feature[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const cat = points.category?.[i];
      features[i] = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [points.lng[i]!, points.lat[i]!] },
        properties: cat != null && points.palette ? { c: points.palette[cat] } : {},
      };
    }
    src.setData({ type: 'FeatureCollection', features });
    if (!fitted.current && n) {
      const b = new maplibregl.LngLatBounds();
      for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 500))) b.extend([points.lng[i]!, points.lat[i]!]);
      m.fitBounds(b, { padding: 60, duration: 0, maxZoom: 19 });
      fitted.current = true;
    }
  }, [points, ready]);

  // Center changes (e.g. geocoded venue).
  useEffect(() => {
    if (center && map.current && ready && !fitted.current) map.current.jumpTo({ center: [center.lng, center.lat], zoom: 16 });
  }, [center, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getLayer('sat')) return;
    m.setLayoutProperty('sat', 'visibility', satellite ? 'visible' : 'none');
  }, [satellite, ready]);

  // Interaction: draw / click.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const draft = m.getSource('draft') as GeoJSONSource;
    drawState.current.coords = [];
    draft.setData(EMPTY);
    m.getCanvas().style.cursor = draw ? 'crosshair' : '';
    if (draw) m.doubleClickZoom.disable();
    else m.doubleClickZoom.enable();

    const render = () => {
      const c = drawState.current.coords;
      draft.setData({
        type: 'FeatureCollection',
        features: [
          ...(c.length > 1 ? [{ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: [...c, ...(c.length > 2 ? [c[0]!] : [])] }, properties: {} }] : []),
          ...c.map((p) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: p }, properties: {} })),
        ],
      });
    };
    const finish = () => {
      const c = drawState.current.coords;
      if (draw?.kind === 'polygon' && c.length >= 3) {
        draw.onDone({ type: 'Polygon', coordinates: [[...c, c[0]!]] });
      }
      drawState.current.coords = [];
      draft.setData(EMPTY);
    };
    const click = (e: maplibregl.MapMouseEvent) => {
      if (draw) {
        if (draw.kind === 'point') return draw.onDone({ type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] });
        drawState.current.coords.push([e.lngLat.lng, e.lngLat.lat]);
        render();
        return;
      }
      const hit = m.queryRenderedFeatures(e.point, { layers: ['areas-fill', 'areas-point'] })[0];
      if (hit && onAreaClick) onAreaClick(String(hit.properties?.id));
      else onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    };
    const dbl = (e: maplibregl.MapMouseEvent) => {
      if (!draw) return;
      e.preventDefault();
      finish();
    };
    const key = (e: KeyboardEvent) => {
      if (!draw) return;
      if (e.key === 'Enter') finish();
      if (e.key === 'Escape') {
        drawState.current.coords = [];
        draft.setData(EMPTY);
      }
      if (e.key === 'Backspace') {
        drawState.current.coords.pop();
        render();
      }
    };
    m.on('click', click);
    m.on('dblclick', dbl);
    window.addEventListener('keydown', key);
    return () => {
      m.off('click', click);
      m.off('dblclick', dbl);
      window.removeEventListener('keydown', key);
    };
  }, [draw, ready, onAreaClick, onMapClick]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line" style={{ height }}>
      <div ref={el} className="absolute inset-0" />
      {config.satelliteTiles && (
        <button
          onClick={() => setSatellite((s) => !s)}
          className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-line bg-surface/90 px-2.5 py-1.5 text-xs backdrop-blur"
        >
          <Layers size={14} /> {satellite ? 'Map' : 'Satellite'}
        </button>
      )}
      {draw && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs backdrop-blur">
          {draw.kind === 'polygon' ? 'Click to add corners · double-click or Enter to finish · Backspace undo · Esc restart' : 'Click the map to place the point'}
        </div>
      )}
    </div>
  );
}

function visitCoords(g: GeoJSON.Geometry, fn: (c: [number, number]) => void) {
  if (g.type === 'Point') fn(g.coordinates as [number, number]);
  else if (g.type === 'Polygon') g.coordinates.forEach((r) => r.forEach((c) => fn(c as [number, number])));
  else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((r) => r.forEach((c) => fn(c as [number, number]))));
}
