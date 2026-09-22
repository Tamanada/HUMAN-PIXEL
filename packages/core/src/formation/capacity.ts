/**
 * How many people a surface can hold: the organizer's first number, before any design exists.
 * The allowed area is the formation area (else the perimeter) minus exclusions and their buffers,
 * rasterized in a local metric frame; people = area of a hex packing at the given spacing.
 */
import { bboxOf, distanceToRing, LocalFrame, pointInBufferedPolygon, pointInPolygon, polygonToLocal, type LatLng, type Polygon } from '../geo';

export interface SurfaceInput {
  perimeter: Polygon<LatLng> | null;
  formationArea: Polygon<LatLng> | null;
  exclusions: { polygon: Polygon<LatLng>; bufferM: number }[];
}

export interface SurfaceCapacity {
  /** Allowed area in m² after exclusions. */
  usableAreaM2: number;
  /** Upper bound: the whole surface filled solid at each spacing. */
  bySpacing: { spacingM: number; people: number }[];
}

/** People in a hex packing of `areaM2` at centre-to-centre `spacingM`. */
export function hexPeople(areaM2: number, spacingM: number): number {
  return Math.floor((2 * areaM2) / (Math.sqrt(3) * spacingM * spacingM));
}

export function surfaceCapacity(input: SurfaceInput, spacingsM: number[] = [1.2, 1.3, 1.5]): SurfaceCapacity | null {
  const area = input.formationArea ?? input.perimeter;
  if (!area || area.outer.length < 3) return null;
  const n = area.outer.length;
  const frame = new LocalFrame({
    lat: area.outer.reduce((s, p) => s + p.lat, 0) / n,
    lng: area.outer.reduce((s, p) => s + p.lng, 0) / n,
  });
  const main = polygonToLocal(frame, area);
  const perimeter = input.formationArea && input.perimeter ? polygonToLocal(frame, input.perimeter) : null;
  const exclusions = input.exclusions.map((e) => {
    const poly = polygonToLocal(frame, e.polygon);
    const buf = Math.max(0, e.bufferM);
    const b = bboxOf(poly.outer);
    return { poly, buf, minX: b.minX - buf, minY: b.minY - buf, maxX: b.maxX + buf, maxY: b.maxY + buf };
  });
  const box = bboxOf(main.outer);
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  // ~1M cells whatever the size: sub-metre resolution up to ~1 km².
  const cell = Math.max(0.1, Math.sqrt((w * h) / 1_000_000));
  let inside = 0;
  const p = { x: 0, y: 0 };
  for (let y = box.minY + cell / 2; y < box.maxY; y += cell) {
    for (let x = box.minX + cell / 2; x < box.maxX; x += cell) {
      p.x = x;
      p.y = y;
      if (!pointInPolygon(p, main)) continue;
      if (perimeter && !pointInPolygon(p, perimeter)) continue;
      if (exclusions.some((e) => x >= e.minX && x <= e.maxX && y >= e.minY && y <= e.maxY && pointInBufferedPolygon(p, e.poly, e.buf))) continue;
      inside++;
    }
  }
  const usableAreaM2 = inside * cell * cell;
  return { usableAreaM2, bySpacing: spacingsM.map((s) => ({ spacingM: s, people: hexPeople(usableAreaM2, s) })) };
}

/**
 * The point deepest inside a polygon (farthest from its edges, "pole of inaccessibility"), by a
 * coarse grid search refined around the best cell. Used as the default design anchor: the fitted
 * design is centred there, so it gets the most room. The average of the corners is not enough:
 * on a curved beach it sits near the shore or even outside the shape.
 */
export function deepestPoint(poly: Polygon<LatLng>): LatLng {
  const n = poly.outer.length;
  const frame = new LocalFrame({ lat: poly.outer.reduce((s, p) => s + p.lat, 0) / n, lng: poly.outer.reduce((s, p) => s + p.lng, 0) / n });
  const local = polygonToLocal(frame, poly);
  const box = bboxOf(local.outer);
  const depth = (x: number, y: number) => {
    const p = { x, y };
    if (!pointInPolygon(p, local)) return -Infinity;
    let d = distanceToRing(p, local.outer);
    for (const h of local.holes ?? []) d = Math.min(d, distanceToRing(p, h));
    return d;
  };
  let best = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, d: -Infinity };
  let step = Math.max(box.maxX - box.minX, box.maxY - box.minY) / 48;
  let x0 = box.minX, x1 = box.maxX, y0 = box.minY, y1 = box.maxY;
  for (let round = 0; round < 4; round++) {
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const d = depth(x, y);
        if (d > best.d) best = { x, y, d };
      }
    }
    x0 = best.x - step; x1 = best.x + step; y0 = best.y - step; y1 = best.y + step;
    step /= 6;
  }
  return frame.toLatLng({ x: best.x, y: best.y });
}
