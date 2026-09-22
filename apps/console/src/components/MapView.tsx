/**
 * MapLibre wrapper for the organizer: event areas, formation points (up to 250k as a single
 * GeoJSON source rendered by the GPU), and a minimal, dependable polygon/point drawing tool.
 */
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LngLatLike, Map as MlMap } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Check, Layers, Lock, LockOpen, RotateCcw, RotateCw, Undo2, X } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { config } from '../lib/supabase';
import { loadSymbolImages, SYMBOL_DRAG_TYPE, KIND_DRAG_TYPE, type PointSymbol } from '../lib/symbols';
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
  collection: { color: '#2be38f', label: 'Collection point', fill: 0 },
  control: { color: '#ffd23f', label: 'Control point', fill: 0 },
  bounty: { color: '#ff8a3d', label: 'Bounty point', fill: 0 },
};

export type DrawMode = { kind: 'polygon' | 'point'; color?: string; onDone: (geom: GeoJSON.Polygon | GeoJSON.Point) => void; onCancel?: () => void } | null;

/** Reshape an existing polygon: drag corners, add corners on edges, remove corners. */
export type EditMode = { geom: GeoJSON.Polygon; color?: string; busy?: boolean; onSave: (geom: GeoJSON.Polygon) => void; onCancel: () => void } | null;

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
  edit?: EditMode;
  height?: number | string;
  selectedAreaId?: string | null;
  /** Fly to this area (e.g. picked in a list); change `n` to fly again to the same one. */
  focus?: { id: string; n: number } | null;
  onAreaClick?: (id: string) => void;
  onMapClick?: (lngLat: { lat: number; lng: number }) => void;
  /** Start on satellite imagery (drawing the ground needs to see it). */
  defaultSatellite?: boolean;
  /** Error to show on the map itself (e.g. a refused shape), where the eyes are while drawing. */
  message?: string | null;
  /** Remember and share the map orientation under this key (the event id). */
  bearingKey?: string;
  /** A symbol pill was dropped on the map at this position. */
  onDropSymbol?: (symbolId: string, at: { lat: number; lng: number }) => void;
  /** A point kind (collection / control / bounty) was dropped on the map. */
  onDropKind?: (kind: AreaRow['kind'], at: { lat: number; lng: number }) => void;
  /** A point (access point) was dragged to a new position. Omitted ⇒ points cannot be moved. */
  onMovePoint?: (areaId: string, to: { lat: number; lng: number }) => void;
  /** The event's custom point types, drawn with their colour and logo. */
  customSymbols?: PointSymbol[];
  onBearingChange?: (deg: number) => void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const DRAFT_COLOR = '#ffffff';

// MapLibre 6 finds its worker next to its own module file. Vite moves that file (dev pre-bundling,
// production chunks) without the worker, so every vector/GeoJSON layer silently stayed empty: no
// basemap, no areas, no drawing, only raster imagery. Hand it the worker bundled by Vite.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

/** Map orientation per event (degrees clockwise from north at the top of the screen), shared by every tab. */
export function readBearing(key: string | undefined): number {
  if (!key) return 0;
  try {
    const v = Number(localStorage.getItem(`hp.mapBearing.${key}`));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
function writeBearing(key: string | undefined, deg: number) {
  if (!key) return;
  try {
    localStorage.setItem(`hp.mapBearing.${key}`, String(Math.round(deg * 10) / 10));
  } catch {
    /* private mode: orientation is simply not remembered */
  }
}
const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export function MapView({ areas = [], points, center, draw, edit = null, height = 520, selectedAreaId, focus = null, onAreaClick, onMapClick, defaultSatellite = false, message, bearingKey, onBearingChange, onDropSymbol, onDropKind, onMovePoint, customSymbols }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [satellite, setSatellite] = useState(defaultSatellite && !!config.satelliteTiles);
  const drawState = useRef<{ coords: [number, number][]; tracing?: boolean; shaping?: boolean; closed?: boolean; start?: maplibregl.Point }>({ coords: [] });
  // How a polygon is drawn: corner by corner, traced by hand, or dragged as a simple shape.
  const [shape, setShape] = useState<ShapeMode>('corners');
  const freehand = shape === 'freehand';
  const dragShape = DRAG_SHAPES.includes(shape);
  // Corners placed so far (drives the Undo / Finish buttons) and the actions of the active tool.
  const [draftCount, setDraftCount] = useState(0);
  const [editDepth, setEditDepth] = useState(0);
  const [dropping, setDropping] = useState(false);
  const actions = useRef<{ undo?: () => void; cancel?: () => void; finish?: () => void; save?: () => void }>({});
  // Locked: the view cannot move at all (no pan, zoom, rotate), so clicks only place corners.
  const [locked, setLocked] = useState(false);
  const fitted = useRef(false);
  const [bearing, setBearing] = useState(() => readBearing(bearingKey));
  const bearingCb = useRef(onBearingChange);
  bearingCb.current = onBearingChange;

  // Init once.
  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: config.mapStyleUrl,
      center: center ? [center.lng, center.lat] : [100.0402, 9.6664],
      zoom: center ? 16 : 3,
      attributionControl: { compact: true },
      maxZoom: 22,
      bearing: readBearing(bearingKey),
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    // 'style.load', not 'load': 'load' also waits for every background tile, and a slow or stuck
    // tile server would leave the map without our layers (no areas, no drawing).
    m.once('style.load', () => {
      if (config.satelliteTiles) {
        // Beyond the provider's last real zoom, its tiles are upscaled (not replaced by "no data" placeholders),
        // so corners can still be placed to the metre.
        m.addSource('sat', { type: 'raster', tiles: [config.satelliteTiles], tileSize: 256, maxzoom: config.satelliteMaxZoom, attribution: config.satelliteAttribution });
        m.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } });
      }
      m.addSource('areas', { type: 'geojson', data: EMPTY });
      m.addLayer({ id: 'areas-fill', type: 'fill', source: 'areas', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'selected'], 0.4, ['get', 'fill']] } });
      // Selection: a white glow around the chosen zone, a pulsing ring around the chosen point.
      m.addLayer({ id: 'areas-sel-glow', type: 'line', source: 'areas', filter: ['==', ['get', 'id'], ''], layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 12, 'line-opacity': 0.6, 'line-blur': 5 } });
      m.addLayer({
        id: 'areas-line',
        type: 'line',
        source: 'areas',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'selected'], 3.5, 2], 'line-dasharray': ['case', ['==', ['get', 'kind'], 'formation_area'], ['literal', [2, 2]], ['literal', [1, 0]]] },
      });
      // Symbol icons (ISO safety colours) for typed access points; a plain dot for untyped ones.
      void loadSymbolImages((id, img) => {
        if (!m.hasImage(id)) m.addImage(id, img, { pixelRatio: 2 });
      });
      m.addLayer({ id: 'areas-sel-ring', type: 'circle', source: 'areas', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': 20, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
      m.addLayer({
        id: 'areas-symbol',
        type: 'symbol',
        source: 'areas',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'symbol'], '']],
        layout: { 'icon-image': ['concat', 'hp-sym-', ['get', 'symbol']], 'icon-size': 1.2, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      });
      m.addLayer({ id: 'areas-point', type: 'circle', source: 'areas', filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'symbol'], '']], paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } });
      // Names next to points (Medical point, Entrance…) and inside named zones.
      m.addLayer({
        id: 'areas-label',
        type: 'symbol',
        source: 'areas',
        filter: ['!=', ['get', 'name'], ''],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-offset': ['case', ['==', ['geometry-type'], 'Point'], ['literal', [0, 1.5]], ['literal', [0, 0]]],
          'text-anchor': ['case', ['==', ['geometry-type'], 'Point'], 'top', 'center'],
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 },
      });
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
      const isRole = (role: string) => ['==', ['get', 'role'], role] as maplibregl.FilterSpecification;
      m.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: isRole('fill'), paint: { 'fill-color': DRAFT_COLOR, 'fill-opacity': 0.18 } });
      m.addLayer({ id: 'draft-casing', type: 'line', source: 'draft', filter: ['in', ['get', 'role'], ['literal', ['edge', 'rubber']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 6, 'line-opacity': 0.55 } });
      m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: isRole('edge'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': DRAFT_COLOR, 'line-width': 3 } });
      m.addLayer({ id: 'draft-rubber', type: 'line', source: 'draft', filter: isRole('rubber'), paint: { 'line-color': DRAFT_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
      m.addLayer({
        id: 'draft-pts',
        type: 'circle',
        source: 'draft',
        filter: isRole('vertex'),
        paint: { 'circle-radius': ['case', ['get', 'first'], 8, 5], 'circle-color': '#fff', 'circle-stroke-color': DRAFT_COLOR, 'circle-stroke-width': 3 },
      });
      m.addSource('edit', { type: 'geojson', data: EMPTY });
      const editRole = (role: string) => ['==', ['get', 'role'], role] as maplibregl.FilterSpecification;
      m.addLayer({ id: 'edit-fill', type: 'fill', source: 'edit', filter: editRole('fill'), paint: { 'fill-color': DRAFT_COLOR, 'fill-opacity': 0.18 } });
      m.addLayer({ id: 'edit-casing', type: 'line', source: 'edit', filter: editRole('fill'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 6, 'line-opacity': 0.55 } });
      m.addLayer({ id: 'edit-line', type: 'line', source: 'edit', filter: editRole('fill'), layout: { 'line-join': 'round' }, paint: { 'line-color': DRAFT_COLOR, 'line-width': 3 } });
      m.addLayer({ id: 'edit-mid', type: 'circle', source: 'edit', filter: editRole('mid'), paint: { 'circle-radius': 4.5, 'circle-color': '#000', 'circle-opacity': 0.55, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
      m.addLayer({ id: 'edit-vertex', type: 'circle', source: 'edit', filter: editRole('vertex'), paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-color': DRAFT_COLOR, 'circle-stroke-width': 3 } });
      setReady(true);
    });
    // Rotate: right-click drag / Ctrl+drag (built in), two fingers, or the ↺ ↻ buttons.
    m.on('rotate', () => setBearing(m.getBearing()));
    m.on('rotateend', () => {
      writeBearing(bearingKey, m.getBearing());
      bearingCb.current?.(m.getBearing());
    });
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __hpMap?: MlMap }).__hpMap = m;
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
        properties: { id: a.id, kind: a.kind, name: a.name ?? '', symbol: a.symbol ?? '', area: a.area_m2 ?? 0, color: AREA_STYLE[a.kind].color, fill: AREA_STYLE[a.kind].fill, selected: a.id === selectedAreaId },
      })),
    };
    (m.getSource('areas') as GeoJSONSource).setData(fc);
    if (!fitted.current && areas.length) {
      const b = new maplibregl.LngLatBounds();
      for (const a of areas) visitCoords(a.geom, (c) => b.extend(c as LngLatLike));
      if (!b.isEmpty()) {
        m.fitBounds(b, { padding: 60, duration: 0, maxZoom: 18, bearing: m.getBearing() });
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
      m.fitBounds(b, { padding: 60, duration: 0, maxZoom: 19, bearing: m.getBearing() });
      fitted.current = true;
    }
  }, [points, ready]);

  // Selected area: glow (zones) or ring (points), with a few pulses so the eye finds it.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const id = selectedAreaId ?? '';
    m.setFilter('areas-sel-glow', ['all', ['==', ['get', 'id'], id], ['==', ['geometry-type'], 'Polygon']]);
    m.setFilter('areas-sel-ring', ['all', ['==', ['get', 'id'], id], ['==', ['geometry-type'], 'Point']]);
    if (!id) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 900; // three pulses of 0.9 s, then a steady highlight
      if (t >= 3) {
        m.setPaintProperty('areas-sel-ring', 'circle-radius', 20);
        m.setPaintProperty('areas-sel-ring', 'circle-stroke-opacity', 1);
        m.setPaintProperty('areas-sel-glow', 'line-opacity', 0.6);
        return;
      }
      const f = t % 1;
      m.setPaintProperty('areas-sel-ring', 'circle-radius', 14 + 30 * f);
      m.setPaintProperty('areas-sel-ring', 'circle-stroke-opacity', 1 - f);
      m.setPaintProperty('areas-sel-glow', 'line-opacity', 0.25 + 0.65 * (1 - f));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selectedAreaId, ready]);

  // Fly to an area picked outside the map (the list).
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !focus) return;
    const a = areas.find((x) => x.id === focus.id);
    if (!a) return;
    if (a.geom.type === 'Point') {
      m.easeTo({ center: a.geom.coordinates as [number, number], zoom: Math.max(m.getZoom(), 18), duration: 700 });
    } else {
      const b = new maplibregl.LngLatBounds();
      visitCoords(a.geom, (c) => b.extend(c as LngLatLike));
      if (!b.isEmpty()) m.fitBounds(b, { padding: 90, maxZoom: 19, duration: 700, bearing: m.getBearing() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n, ready]);

  // Center changes (e.g. geocoded venue).
  useEffect(() => {
    if (center && map.current && ready && !fitted.current) map.current.jumpTo({ center: [center.lng, center.lat], zoom: 16 });
  }, [center, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getLayer('sat')) return;
    m.setLayoutProperty('sat', 'visibility', satellite ? 'visible' : 'none');
  }, [satellite, ready]);

  // Interaction: draw / click. Callbacks go through refs so a parent re-render never resets a
  // drawing in progress.
  const cb = useRef({ onAreaClick, onMapClick, draw, edit, selectedAreaId });
  cb.current = { onAreaClick, onMapClick, draw, edit, selectedAreaId };
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const draft = m.getSource('draft') as GeoJSONSource;
    const st = drawState.current;
    st.coords = [];
    draft.setData(EMPTY);
    const polygon = draw?.kind === 'polygon';
    const trace = polygon && freehand;
    const drag = polygon && dragShape;
    m.getCanvas().style.cursor = draw ? 'crosshair' : '';

    const color = draw?.color ?? '#ffffff';
    for (const id of ['draft-line', 'draft-rubber']) m.setPaintProperty(id, 'line-color', color);
    m.setPaintProperty('draft-fill', 'fill-color', color);
    m.setPaintProperty('draft-pts', 'circle-stroke-color', color);

    // Placed edges are solid; the edge being drawn (last corner → cursor → first corner) is dashed.
    const render = (cursor?: [number, number]) => {
      const c = st.coords;
      const feat = (geometry: GeoJSON.Geometry, props: Record<string, unknown>): GeoJSON.Feature => ({ type: 'Feature', geometry, properties: props });
      const features: GeoJSON.Feature[] = [];
      const ring = cursor && !trace ? [...c, cursor] : c;
      if (ring.length >= 3) features.push(feat({ type: 'Polygon', coordinates: [[...ring, ring[0]!]] }, { role: 'fill' }));
      if (c.length >= 2) features.push(feat({ type: 'LineString', coordinates: (trace && !st.tracing) || st.closed ? [...c, c[0]!] : c }, { role: 'edge' }));
      if (cursor && c.length >= 1 && !trace && !drag) {
        features.push(feat({ type: 'LineString', coordinates: c.length >= 2 ? [c[c.length - 1]!, cursor, c[0]!] : [c[0]!, cursor] }, { role: 'rubber' }));
      }
      if (trace && st.tracing && c.length >= 3) features.push(feat({ type: 'LineString', coordinates: [c[c.length - 1]!, c[0]!] }, { role: 'rubber' }));
      if (!trace && !drag) c.forEach((p, i) => features.push(feat({ type: 'Point', coordinates: p }, { role: 'vertex', first: i === 0 && c.length >= 3 })));
      draft.setData({ type: 'FeatureCollection', features });
      setDraftCount(c.length);
    };
    const reset = () => {
      st.coords = [];
      st.tracing = false;
      st.shaping = false;
      st.closed = false;
      draft.setData(EMPTY);
      setDraftCount(0);
    };
    const finish = () => {
      const d = cb.current.draw;
      let c = st.coords;
      if (trace && !st.closed) c = simplifyOnScreen(m, c, 1.5);
      c = dedupeOnScreen(m, c, 2);
      if (d?.kind === 'polygon' && c.length >= 3) d.onDone({ type: 'Polygon', coordinates: [[...c, c[0]!]] });
      reset();
    };
    if (draw) {
      actions.current = {
        undo: () => {
          st.coords.pop();
          render();
        },
        // Cancel = forget this shape and leave the tool.
        cancel: () => {
          reset();
          cb.current.draw?.onCancel?.();
        },
        finish,
      };
    }
    const click = (e: maplibregl.MapMouseEvent) => {
      if (cb.current.edit) return;
      const d = cb.current.draw;
      if (d) {
        if (d.kind === 'point') return d.onDone({ type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] });
        if (trace || drag) return;
        // The 2nd click of a double-click is the "finish" gesture, not a new corner.
        if (e.originalEvent.detail > 1) return;
        // Clicking the first corner again closes the shape.
        if (st.coords.length >= 3) {
          const first = m.project(st.coords[0]!);
          if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) return finish();
        }
        st.coords.push([e.lngLat.lng, e.lngLat.lat]);
        render();
        return;
      }
      const hit = pickArea(m, e.point, cb.current.selectedAreaId);
      if (hit && cb.current.onAreaClick) cb.current.onAreaClick(hit);
      else cb.current.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    };
    const dbl = (e: maplibregl.MapMouseEvent) => {
      if (!cb.current.draw) return;
      e.preventDefault();
      if (!trace && !drag) finish();
    };
    const down = (e: maplibregl.MapMouseEvent) => {
      if (drag && e.originalEvent.button === 0) {
        st.start = e.point;
        st.shaping = true;
        return;
      }
      if (!trace || e.originalEvent.button !== 0) return;
      st.coords = [[e.lngLat.lng, e.lngLat.lat]];
      st.tracing = true;
      render();
    };
    const move = (e: maplibregl.MapMouseEvent) => {
      if (st.shaping && st.start) {
        st.coords = shapeRing(m, st.start, e.point, shape);
        st.closed = true;
        render();
        return;
      }
      if (!st.tracing) {
        if (!trace && cb.current.draw?.kind === 'polygon' && st.coords.length) render([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      const last = m.project(st.coords[st.coords.length - 1]!);
      if (Math.hypot(last.x - e.point.x, last.y - e.point.y) < 3) return;
      st.coords.push([e.lngLat.lng, e.lngLat.lat]);
      render();
    };
    const up = (e: maplibregl.MapMouseEvent) => {
      if (st.shaping && st.start) {
        const tooSmall = Math.hypot(e.point.x - st.start.x, e.point.y - st.start.y) < 6;
        st.shaping = false;
        if (tooSmall) reset();
        else {
          st.coords = shapeRing(m, st.start, e.point, shape);
          finish();
        }
        return;
      }
      if (!st.tracing) return;
      st.tracing = false;
      finish();
    };
    const key = (e: KeyboardEvent) => {
      if (!cb.current.draw) return;
      if (e.key === 'Enter') finish();
      if (e.key === 'Escape') reset();
      if (e.key === 'Backspace' && !trace && !drag) {
        st.coords.pop();
        render();
      }
    };
    m.on('click', click);
    m.on('dblclick', dbl);
    m.on('mousedown', down);
    m.on('mousemove', move);
    m.on('mouseup', up);
    window.addEventListener('keydown', key);
    return () => {
      m.off('click', click);
      m.off('dblclick', dbl);
      m.off('mousedown', down);
      m.off('mousemove', move);
      m.off('mouseup', up);
      window.removeEventListener('keydown', key);
    };
  }, [draw, ready, shape]);

  // Reshape: drag a corner to move it, drag a small edge handle to add a corner there, double-click a
  // corner to remove it. Every change is undoable; nothing is saved until "Save shape".
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource('edit') as GeoJSONSource;
    if (!edit) {
      src.setData(EMPTY);
      return;
    }
    const color = edit.color ?? '#ffffff';
    m.setPaintProperty('edit-line', 'line-color', color);
    m.setPaintProperty('edit-fill', 'fill-color', color);
    m.setPaintProperty('edit-vertex', 'circle-stroke-color', color);
    const holes = edit.geom.coordinates.slice(1);
    let ring = edit.geom.coordinates[0]!.slice(0, -1).map((c) => [c[0]!, c[1]!] as [number, number]);
    const history: [number, number][][] = [];
    let dragging: number | null = null;
    const snapshot = () => {
      history.push(ring.map((c) => [...c] as [number, number]));
      setEditDepth(history.length);
    };
    const render = () => {
      const f = (geometry: GeoJSON.Geometry, props: Record<string, unknown>): GeoJSON.Feature => ({ type: 'Feature', geometry, properties: props });
      const mids = ring.map((a, i) => {
        const b = ring[(i + 1) % ring.length]!;
        return f({ type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }, { role: 'mid', i });
      });
      src.setData({
        type: 'FeatureCollection',
        features: [
          f({ type: 'Polygon', coordinates: [[...ring, ring[0]!], ...holes] }, { role: 'fill' }),
          ...mids,
          ...ring.map((c, i) => f({ type: 'Point', coordinates: c }, { role: 'vertex', i })),
        ],
      });
    };
    const hitAt = (pt: maplibregl.Point) => {
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [[pt.x - 8, pt.y - 8], [pt.x + 8, pt.y + 8]];
      const v = m.queryRenderedFeatures(box, { layers: ['edit-vertex'] })[0];
      if (v) return { role: 'vertex' as const, i: Number(v.properties?.i) };
      const mid = m.queryRenderedFeatures(box, { layers: ['edit-mid'] })[0];
      if (mid) return { role: 'mid' as const, i: Number(mid.properties?.i) };
      return null;
    };
    const down = (e: maplibregl.MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return;
      const hit = hitAt(e.point);
      if (!hit) return;
      e.preventDefault(); // keeps the map still while a corner moves
      snapshot();
      if (hit.role === 'mid') {
        ring.splice(hit.i + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
        dragging = hit.i + 1;
      } else dragging = hit.i;
      render();
    };
    const move = (e: maplibregl.MapMouseEvent) => {
      if (dragging == null) {
        const hit = hitAt(e.point);
        m.getCanvas().style.cursor = hit ? (hit.role === 'vertex' ? 'move' : 'copy') : '';
        return;
      }
      ring[dragging] = [e.lngLat.lng, e.lngLat.lat];
      render();
    };
    const up = () => {
      dragging = null;
    };
    const dbl = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault();
      const hit = hitAt(e.point);
      if (hit?.role !== 'vertex' || ring.length <= 3) return;
      // The double-click's first press already pushed a snapshot of the untouched ring.
      ring.splice(hit.i, 1);
      render();
    };
    const undo = () => {
      const prev = history.pop();
      if (!prev) return;
      ring = prev;
      setEditDepth(history.length);
      render();
    };
    const save = () => cb.current.edit?.onSave({ type: 'Polygon', coordinates: [[...ring, ring[0]!], ...holes] });
    actions.current = { undo, save, cancel: () => cb.current.edit?.onCancel() };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'Escape') cb.current.edit?.onCancel();
      else if (e.key === 'Enter') save();
    };
    setEditDepth(0);
    render();
    m.on('mousedown', down);
    m.on('mousemove', move);
    m.on('mouseup', up);
    m.on('dblclick', dbl);
    window.addEventListener('keydown', key);
    return () => {
      m.off('mousedown', down);
      m.off('mousemove', move);
      m.off('mouseup', up);
      m.off('dblclick', dbl);
      window.removeEventListener('keydown', key);
      m.getCanvas().style.cursor = '';
      src.setData(EMPTY);
    };
    // Re-initialise only when another shape is opened for editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.geom, ready]);

  // Move a placed point: press on it and drag (only when no drawing or reshaping is in progress).
  const moveCb = useRef(onMovePoint);
  moveCb.current = onMovePoint;
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource('areas') as GeoJSONSource;
    let moving: { id: string; fc: GeoJSON.FeatureCollection; feature: GeoJSON.Feature; from: maplibregl.Point } | null = null;
    const down = (e: maplibregl.MapMouseEvent) => {
      if (!moveCb.current || cb.current.draw || cb.current.edit || e.originalEvent.button !== 0) return;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
      const hit = m.queryRenderedFeatures(box, { layers: ['areas-symbol', 'areas-point'] })[0];
      if (!hit) return;
      e.preventDefault(); // the map stays still while the point moves
      const id = String(hit.properties?.id);
      const fc = structuredClone((src as unknown as { _data: { geojson: GeoJSON.FeatureCollection } })._data.geojson);
      const feature = fc.features.find((f) => f.properties?.id === id);
      if (!feature) return;
      moving = { id, fc, feature, from: e.point };
      m.getCanvas().style.cursor = 'grabbing';
    };
    const move = (e: maplibregl.MapMouseEvent) => {
      if (!moving) return;
      moving.feature.geometry = { type: 'Point', coordinates: [e.lngLat.lng, e.lngLat.lat] };
      src.setData(moving.fc);
    };
    const up = (e: maplibregl.MapMouseEvent) => {
      if (!moving) return;
      const { id, from } = moving;
      moving = null;
      m.getCanvas().style.cursor = '';
      // A plain click (no real drag) only selects the point.
      if (Math.hypot(e.point.x - from.x, e.point.y - from.y) > 3) moveCb.current?.(id, { lat: e.lngLat.lat, lng: e.lngLat.lng });
    };
    m.on('mousedown', down);
    m.on('mousemove', move);
    m.on('mouseup', up);
    return () => {
      m.off('mousedown', down);
      m.off('mousemove', move);
      m.off('mouseup', up);
    };
  }, [ready]);

  // Custom types: (re)register their icons whenever the list changes (new colour, new logo).
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !customSymbols?.length) return;
    void loadSymbolImages((id, img) => {
      if (m.hasImage(id)) m.updateImage(id, img);
      else m.addImage(id, img, { pixelRatio: 2 });
    }, customSymbols);
  }, [customSymbols, ready]);

  // Which gestures move the view: none when locked; in freehand the left drag draws instead of panning.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const trace = draw?.kind === 'polygon' && (freehand || dragShape);
    const set = (h: { enable: () => void; disable: () => void }, on: boolean) => (on ? h.enable() : h.disable());
    set(m.dragPan, !locked && !trace);
    set(m.scrollZoom, !locked);
    set(m.boxZoom, !locked);
    set(m.dragRotate, !locked);
    set(m.keyboard, !locked);
    set(m.touchZoomRotate, !locked);
    set(m.doubleClickZoom, !locked && !draw && !edit);
    m.getContainer().classList.toggle('hp-map-locked', locked);
  }, [locked, draw, edit, shape, ready]);

  const rotateTo = (deg: number) => {
    const m = map.current;
    if (!m) return;
    m.rotateTo(norm180(deg), { duration: 250 });
  };
  const step = (e: ReactMouseEvent) => (e.shiftKey ? 1 : 5);

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border ${dropping ? 'border-pixel' : 'border-line'}`}
      style={{ height }}
      onDragOver={(e) => {
        const ok = (onDropSymbol && e.dataTransfer.types.includes(SYMBOL_DRAG_TYPE)) || (onDropKind && e.dataTransfer.types.includes(KIND_DRAG_TYPE));
        if (!ok) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const id = e.dataTransfer.getData(SYMBOL_DRAG_TYPE);
        const kind = e.dataTransfer.getData(KIND_DRAG_TYPE) as AreaRow['kind'] | '';
        const mm = map.current;
        if ((!id && !kind) || !mm) return;
        e.preventDefault();
        const rect = mm.getCanvas().getBoundingClientRect();
        const ll = mm.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        if (id && onDropSymbol) onDropSymbol(id, { lat: ll.lat, lng: ll.lng });
        else if (kind && onDropKind) onDropKind(kind, { lat: ll.lat, lng: ll.lng });
      }}
    >
      {/* Inline, not a class: maplibre-gl.css (unlayered) sets .maplibregl-map { position: relative },
          which beats Tailwind's layered utilities and would collapse the map to 0 px height. */}
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {config.satelliteTiles && (
        <button
          onClick={() => setSatellite((s) => !s)}
          className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-line bg-surface/90 px-2.5 py-1.5 text-xs backdrop-blur"
        >
          <Layers size={14} /> {satellite ? 'Map' : 'Satellite'}
        </button>
      )}
      <div
        className="absolute left-3 flex items-center gap-0.5 rounded-lg border border-line bg-surface/90 p-0.5 text-xs backdrop-blur"
        style={{ top: config.satelliteTiles ? 48 : 12 }}
        title="Rotate the map: buttons (Shift = 1°), right-click drag, or Ctrl + drag"
      >
        <button
          aria-label={locked ? 'Unlock the map' : 'Lock the map'}
          title={locked ? 'Unlock: the map can move again' : 'Lock the view: no pan, zoom or rotation while you click corners'}
          onClick={() => setLocked((v) => !v)}
          className={`flex items-center gap-1 rounded-md px-1.5 py-1 ${locked ? 'bg-pixel text-on-pixel' : 'hover:bg-surface-2'}`}
        >
          {locked ? <Lock size={14} /> : <LockOpen size={14} />}
          {locked && <span>Locked</span>}
        </button>
        <span className="mx-0.5 h-4 w-px bg-line" />
        <button disabled={locked} aria-label="Rotate left" onClick={(e) => rotateTo(bearing - step(e))} className="rounded-md p-1.5 hover:bg-surface-2 disabled:opacity-40"><RotateCcw size={14} /></button>
        <button disabled={locked} aria-label="Reset to north" onClick={() => rotateTo(0)} className="hp-digits min-w-12 rounded-md px-1.5 py-1 hover:bg-surface-2 disabled:opacity-60">{Math.round(norm180(bearing))}°</button>
        <button disabled={locked} aria-label="Rotate right" onClick={(e) => rotateTo(bearing + step(e))} className="rounded-md p-1.5 hover:bg-surface-2 disabled:opacity-40"><RotateCw size={14} /></button>
      </div>
      {dropping && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg border border-pixel bg-surface/95 px-3 py-1.5 text-xs backdrop-blur">
          Drop to place the point here
        </div>
      )}
      {(draw || edit || message) && (
        <div className="absolute bottom-3 left-1/2 flex w-[min(92%,560px)] -translate-x-1/2 flex-col items-center gap-2">
          {message && <div role="alert" className="w-full rounded-lg border border-bad/60 bg-surface/95 px-3 py-2 text-xs text-bad backdrop-blur">{message}</div>}
          {draw && (
            <div className="flex w-full flex-wrap items-center justify-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs backdrop-blur">
              {draw.kind === 'polygon' && (
                <div className="flex flex-wrap gap-0.5 rounded-md bg-bg p-0.5">
                  {SHAPE_MODES.map(([k, label]) => (
                    <button key={k} onClick={() => setShape(k)} className={`rounded px-2 py-1 ${shape === k ? 'bg-surface-2 text-text' : 'text-muted'}`}>{label}</button>
                  ))}
                </div>
              )}
              <span className="text-muted">
                {draw.kind === 'point'
                  ? 'Click the map to place the point'
                  : SHAPE_HINT[shape]}
              </span>
              <div className="flex gap-1">
                {draw.kind === 'polygon' && shape === 'corners' && (
                  <>
                    <BarButton icon={<Undo2 size={13} />} disabled={draftCount === 0} onClick={() => actions.current.undo?.()} title="Remove the last corner (Backspace)">Undo</BarButton>
                    <BarButton icon={<Check size={13} />} disabled={draftCount < 3} onClick={() => actions.current.finish?.()} title="Close and save the shape (Enter)" primary>Finish</BarButton>
                  </>
                )}
                <BarButton icon={<X size={13} />} onClick={() => actions.current.cancel?.()} title="Throw this shape away">Cancel</BarButton>
              </div>
            </div>
          )}
          {edit && (
            <div className="flex w-full flex-wrap items-center justify-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs backdrop-blur">
              <span className="text-muted">Drag a corner to move it · drag a small dot on an edge to add a corner · double-click a corner to remove it</span>
              <div className="flex gap-1">
                <BarButton icon={<Undo2 size={13} />} disabled={editDepth === 0} onClick={() => actions.current.undo?.()} title="Undo the last change (Ctrl+Z)">Undo</BarButton>
                <BarButton icon={<X size={13} />} onClick={() => actions.current.cancel?.()} title="Discard the changes (Esc)">Cancel</BarButton>
                <BarButton icon={<Check size={13} />} disabled={edit.busy} onClick={() => actions.current.save?.()} title="Save the new shape (Enter)" primary>Save shape</BarButton>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Which zone a click means. Zones overlap (everything sits inside the perimeter), so: points first,
 * then the SMALLEST zone under the cursor; clicking again on an already selected zone cycles to the
 * next larger one below it (reach the perimeter under a formation area). A few pixels of tolerance
 * make thin zones (corridors) and edges clickable.
 */
function pickArea(m: MlMap, pt: maplibregl.Point, selected: string | null | undefined): string | null {
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]];
  const pts = m.queryRenderedFeatures(box, { layers: ['areas-symbol', 'areas-point'] });
  if (pts.length) return String(pts[0]!.properties?.id);
  const polys = m.queryRenderedFeatures(box, { layers: ['areas-fill', 'areas-line'] });
  const seen = new Map<string, number>();
  for (const f of polys) seen.set(String(f.properties?.id), Number(f.properties?.area) || Infinity);
  const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  if (!ordered.length) return null;
  const i = selected ? ordered.indexOf(selected) : -1;
  return i >= 0 ? ordered[(i + 1) % ordered.length]! : ordered[0]!;
}

type ShapeMode = 'corners' | 'freehand' | 'rect' | 'square' | 'circle' | 'oval';
const DRAG_SHAPES: ShapeMode[] = ['rect', 'square', 'circle', 'oval'];
const SHAPE_MODES: [ShapeMode, string][] = [
  ['corners', 'Corners'],
  ['freehand', 'Freehand'],
  ['rect', 'Rectangle'],
  ['square', 'Square'],
  ['circle', 'Circle'],
  ['oval', 'Oval'],
];
const SHAPE_HINT: Record<ShapeMode, string> = {
  corners: 'Click each corner · click the first corner or double-click to finish',
  freehand: 'Hold the left button and trace the outline; release to finish · right-drag rotates',
  rect: 'Drag from one corner to the opposite corner (aligned with your map view)',
  square: 'Drag from one corner; the square follows the mouse',
  circle: 'Drag from the centre outwards; release at the radius you want',
  oval: 'Drag across the box that holds the oval (aligned with your map view)',
};

/**
 * A simple shape between the press point `a` and the current point `b`, built in SCREEN space so
 * it follows the map view (rotate the map to the beach first and the rectangle lines up with it),
 * then converted to coordinates. Round shapes get 48 corners: smooth, still easy to reshape.
 */
function shapeRing(m: MlMap, a: maplibregl.Point, b: maplibregl.Point, shape: ShapeMode): [number, number][] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let pts: [number, number][];
  if (shape === 'rect' || shape === 'square') {
    const e = shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) : 0;
    const bx = shape === 'square' ? a.x + Math.sign(dx || 1) * e : b.x;
    const by = shape === 'square' ? a.y + Math.sign(dy || 1) * e : b.y;
    pts = [[a.x, a.y], [bx, a.y], [bx, by], [a.x, by]];
  } else {
    const circle = shape === 'circle';
    const cx = circle ? a.x : (a.x + b.x) / 2;
    const cy = circle ? a.y : (a.y + b.y) / 2;
    const rx = circle ? Math.hypot(dx, dy) : Math.abs(dx) / 2;
    const ry = circle ? rx : Math.abs(dy) / 2;
    pts = Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2;
      return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as [number, number];
    });
  }
  return pts.map(([x, y]) => {
    const ll = m.unproject([x, y]);
    return [ll.lng, ll.lat];
  });
}

function BarButton({ icon, children, onClick, disabled, title, primary }: { icon: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean; title?: string; primary?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium disabled:opacity-40 ${primary ? 'bg-pixel text-on-pixel' : 'bg-surface-2 text-text hover:bg-line'}`}
    >
      {icon}
      {children}
    </button>
  );
}

function visitCoords(g: GeoJSON.Geometry, fn: (c: [number, number]) => void) {
  if (g.type === 'Point') fn(g.coordinates as [number, number]);
  else if (g.type === 'Polygon') g.coordinates.forEach((r) => r.forEach((c) => fn(c as [number, number])));
  else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((r) => r.forEach((c) => fn(c as [number, number]))));
}

/** Drops consecutive vertices closer than `px` on screen (double-click leftovers, jitter). */
function dedupeOnScreen(m: MlMap, c: [number, number][], px: number): [number, number][] {
  const out: [number, number][] = [];
  let prev: { x: number; y: number } | null = null;
  for (const p of c) {
    const q = m.project(p);
    if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) < px) continue;
    out.push(p);
    prev = q;
  }
  // The closing vertex is added by the caller: drop a last point sitting on the first.
  if (out.length > 3) {
    const a = m.project(out[0]!);
    const b = m.project(out[out.length - 1]!);
    if (Math.hypot(a.x - b.x, a.y - b.y) < px * 3) out.pop();
  }
  return out;
}

/** Douglas–Peucker in screen pixels: a hand trace keeps its curves with a few dozen vertices. */
function simplifyOnScreen(m: MlMap, c: [number, number][], tolerancePx: number): [number, number][] {
  if (c.length < 4) return c;
  const pts = c.map((p) => m.project(p));
  const keep = new Uint8Array(c.length);
  keep[0] = keep[c.length - 1] = 1;
  const stack: [number, number][] = [[0, c.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i]!;
    const b = pts[j]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
    let far = -1;
    let dmax = tolerancePx;
    for (let k = i + 1; k < j; k++) {
      const p = pts[k]!;
      const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
      if (d > dmax) {
        dmax = d;
        far = k;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return c.filter((_, k) => keep[k]);
}
