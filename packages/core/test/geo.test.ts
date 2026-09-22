import { describe, expect, it } from 'vitest';
import {
  LocalFrame,
  angleDelta,
  compassPoint,
  geoJsonPolygonToLatLng,
  haversineDistance,
  initialBearing,
  latLngPolygonToGeoJson,
  pointInBufferedPolygon,
  pointInPolygon,
  polygonArea,
} from '../src';

const PHANGAN = { lat: 9.6804, lng: 100.0663 };

describe('distance & bearing', () => {
  it('haversine matches known distance (Paris → London ≈ 343.5 km)', () => {
    const d = haversineDistance({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 });
    expect(d / 1000).toBeCloseTo(343.5, 0);
  });

  it('is accurate at human scale (1e-5° lat ≈ 1.1 m)', () => {
    const d = haversineDistance(PHANGAN, { lat: PHANGAN.lat + 1e-5, lng: PHANGAN.lng });
    expect(d).toBeGreaterThan(1.09);
    expect(d).toBeLessThan(1.12);
  });

  it('bearing to the north/east/south/west', () => {
    expect(initialBearing(PHANGAN, { lat: PHANGAN.lat + 0.001, lng: PHANGAN.lng })).toBeCloseTo(0, 3);
    expect(initialBearing(PHANGAN, { lat: PHANGAN.lat, lng: PHANGAN.lng + 0.001 })).toBeCloseTo(90, 1);
    expect(initialBearing(PHANGAN, { lat: PHANGAN.lat - 0.001, lng: PHANGAN.lng })).toBeCloseTo(180, 3);
    expect(initialBearing(PHANGAN, { lat: PHANGAN.lat, lng: PHANGAN.lng - 0.001 })).toBeCloseTo(270, 1);
    expect(compassPoint(44)).toBe('NE');
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
  });
});

describe('LocalFrame', () => {
  it('round-trips with sub-millimetre error over 2 km', () => {
    const f = new LocalFrame(PHANGAN);
    for (const p of [{ x: 0, y: 0 }, { x: 1234.5, y: -876.1 }, { x: -2000, y: 2000 }]) {
      const back = f.toLocal(f.toLatLng(p));
      expect(Math.abs(back.x - p.x)).toBeLessThan(1e-6);
      expect(Math.abs(back.y - p.y)).toBeLessThan(1e-6);
    }
  });

  it('agrees with haversine within 0.1% at 1 km', () => {
    const f = new LocalFrame(PHANGAN);
    const q = f.toLatLng({ x: 600, y: 800 });
    expect(haversineDistance(PHANGAN, q)).toBeCloseTo(1000, -1);
  });
});

describe('polygons', () => {
  const square = { outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], holes: [[{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }]] };
  it('handles holes', () => {
    expect(pointInPolygon({ x: 1, y: 1 }, square)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 11, y: 5 }, square)).toBe(false);
    expect(polygonArea(square)).toBe(96);
  });
  it('applies buffers', () => {
    expect(pointInBufferedPolygon({ x: 11, y: 5 }, square, 1.5)).toBe(true);
    expect(pointInBufferedPolygon({ x: 12, y: 5 }, square, 1.5)).toBe(false);
  });
  it('GeoJSON round trip closes and reopens rings', () => {
    const g = latLngPolygonToGeoJson({ outer: [PHANGAN, { lat: 9.69, lng: 100.07 }, { lat: 9.67, lng: 100.08 }] });
    expect(g.coordinates[0]).toHaveLength(4);
    expect(geoJsonPolygonToLatLng(g).outer).toHaveLength(3);
  });
});
