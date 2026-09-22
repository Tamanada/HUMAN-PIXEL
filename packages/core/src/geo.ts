/**
 * Geodesy utilities. Everything here runs on the participant's phone and in the
 * organizer's formation engine: no network, no allocation-heavy code in hot paths.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Local east/north coordinates in meters relative to a frame origin. */
export interface XY {
  x: number;
  y: number;
}

/** A polygon ring (closed implicitly) and optional holes. */
export interface Polygon<P = XY> {
  outer: P[];
  holes?: P[][];
}

export const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export function toRad(deg: number): number {
  return deg * DEG;
}

export function toDeg(rad: number): number {
  return rad / DEG;
}

export function isValidLatLng(p: LatLng): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/** Great-circle distance in meters (haversine). Accurate to well under 0.5% at any range. */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from true north in [0, 360). */
export function initialBearing(a: LatLng, b: LatLng): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDegrees(toDeg(Math.atan2(y, x)));
}

export function normalizeDegrees(d: number): number {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/** Signed smallest difference b - a in degrees, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = normalizeDegrees(b - a);
  if (d > 180) d -= 360;
  return d;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export function compassPoint(bearing: number): (typeof COMPASS)[number] {
  return COMPASS[Math.round(normalizeDegrees(bearing) / 45) % 8]!;
}

/**
 * Local tangent-plane frame (equirectangular with WGS84 meridian/parallel lengths).
 * Error is < 1 cm over the few-kilometre extent of any human formation.
 */
export class LocalFrame {
  readonly origin: LatLng;
  readonly mPerDegLat: number;
  readonly mPerDegLng: number;

  constructor(origin: LatLng) {
    if (!isValidLatLng(origin)) throw new RangeError('Invalid frame origin');
    this.origin = origin;
    const φ = toRad(origin.lat);
    this.mPerDegLat = 111_132.954 - 559.822 * Math.cos(2 * φ) + 1.175 * Math.cos(4 * φ);
    this.mPerDegLng = 111_412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ);
  }

  toLocal(p: LatLng): XY {
    return {
      x: (p.lng - this.origin.lng) * this.mPerDegLng,
      y: (p.lat - this.origin.lat) * this.mPerDegLat,
    };
  }

  toLatLng(p: XY): LatLng {
    return {
      lat: this.origin.lat + p.y / this.mPerDegLat,
      lng: this.origin.lng + p.x / this.mPerDegLng,
    };
  }
}

/** Rotate a point counter-clockwise by `deg` degrees around the origin. */
export function rotate(p: XY, deg: number): XY {
  const r = toRad(deg);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Even-odd ray casting on a single ring. */
export function pointInRing(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(p: XY, poly: Polygon): boolean {
  if (!pointInRing(p, poly.outer)) return false;
  for (const h of poly.holes ?? []) if (pointInRing(p, h)) return false;
  return true;
}

export function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToRing(p: XY, ring: readonly XY[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, distanceToSegment(p, ring[j]!, ring[i]!));
  }
  return best;
}

/** True when p is inside the polygon or within `buffer` meters of its boundary. */
export function pointInBufferedPolygon(p: XY, poly: Polygon, buffer: number): boolean {
  if (pointInPolygon(p, poly)) return true;
  if (buffer <= 0) return false;
  if (distanceToRing(p, poly.outer) <= buffer) return true;
  return false;
}

/** Shoelace area (absolute), square meters for local polygons. */
export function ringArea(ring: readonly XY[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j]!.x + ring[i]!.x) * (ring[j]!.y - ring[i]!.y);
  }
  return Math.abs(s) / 2;
}

export function polygonArea(poly: Polygon): number {
  return ringArea(poly.outer) - (poly.holes ?? []).reduce((acc, h) => acc + ringArea(h), 0);
}

export function ringCentroid(ring: readonly XY[]): XY {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxOf(points: Iterable<XY>): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

/** GeoJSON helpers: the DB and the map layer both speak GeoJSON [lng, lat]. */
export type GeoJsonPosition = [number, number];
export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: GeoJsonPosition[][];
}
export interface GeoJsonPoint {
  type: 'Point';
  coordinates: GeoJsonPosition;
}

export function geoJsonPolygonToLatLng(g: GeoJsonPolygon): Polygon<LatLng> {
  const [outer, ...holes] = g.coordinates.map((ring) => {
    const pts = ring.map(([lng, lat]) => ({ lat, lng }));
    // GeoJSON rings repeat the first vertex; our rings are implicitly closed.
    if (pts.length > 1) {
      const f = pts[0]!;
      const l = pts[pts.length - 1]!;
      if (f.lat === l.lat && f.lng === l.lng) pts.pop();
    }
    return pts;
  });
  return { outer: outer ?? [], holes };
}

export function latLngPolygonToGeoJson(p: Polygon<LatLng>): GeoJsonPolygon {
  const close = (ring: LatLng[]): GeoJsonPosition[] => {
    const c = ring.map((q) => [q.lng, q.lat] as GeoJsonPosition);
    if (c.length) c.push([...c[0]!] as GeoJsonPosition);
    return c;
  };
  return { type: 'Polygon', coordinates: [close(p.outer), ...(p.holes ?? []).map(close)] };
}

export function polygonToLocal(frame: LocalFrame, p: Polygon<LatLng>): Polygon {
  return {
    outer: p.outer.map((q) => frame.toLocal(q)),
    holes: (p.holes ?? []).map((h) => h.map((q) => frame.toLocal(q))),
  };
}
