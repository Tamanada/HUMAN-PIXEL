/**
 * AUTO-PLACEMENT: rotation + position + size that make the design cover as much of the formation
 * area as possible (without distorting it).
 *
 * The design is kept rigid (its aspect ratio is the message's), so "cover the most" means "the
 * largest width that still fits". For each candidate rotation:
 *   1. the allowed area is rasterised once in the design's own frame (rotated grid, O(1) lookups);
 *   2. the design's ink is sampled into ~1,200 points;
 *   3. a bisection on the width, where "fits" = some anchor on a grid keeps at most maxClip of the
 *      ink outside the area (the anchor range shrinks as the width grows, so bigger is cheaper).
 * Candidates: the area's long axis and short axis (minimum-area bounding rectangle), each in the
 * reading direction closest to the preferred rotation (the organizer's map view), plus the
 * preferred rotation itself, then a ±6° refinement around the winner.
 * Only the outer boundary limits the size; exclusions inside it remove pixels later, as usual.
 */
import { LocalFrame, bboxOf, pointInPolygon, polygonToLocal, type LatLng, type Polygon, type XY } from '../geo';
import { sampleMask, type Mask } from './mask';

export interface PlacementInput {
  mask: Mask;
  perimeter?: Polygon<LatLng> | null;
  formationArea?: Polygon<LatLng> | null;
  /** Rotation the text should read closest to (e.g. aligned with the map view). Default 0. */
  preferredRotationDeg?: number;
  maxClippedFraction?: number;
  coverageThreshold?: number;
}

export interface Placement {
  anchor: LatLng;
  widthM: number;
  heightM: number;
  rotationDeg: number;
  /** Share of the allowed area covered by the design's bounding box. */
  boxCoverage: number;
}

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

function rotateXY(p: XY, deg: number): XY {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Orientation (deg) of the area's minimum-area bounding rectangle, and whether that axis is the long one. */
function principalAxis(pts: XY[]): { deg: number; long: number; short: number } {
  let best = { deg: 0, area: Infinity, w: 0, h: 0 };
  for (let a = 0; a < 180; a += 1) {
    const b = bboxOf(pts.map((p) => rotateXY(p, -a)));
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w * h < best.area) best = { deg: a, area: w * h, w, h };
  }
  // Angle of the rectangle's long side, measured CCW from east.
  return best.w >= best.h ? { deg: best.deg, long: best.w, short: best.h } : { deg: best.deg + 90, long: best.h, short: best.w };
}

/** Ink points of the design, normalised to [-0.5, 0.5] × [-0.5, 0.5] (y up). */
function inkSamples(mask: Mask, threshold: number, target = 4000): { x: number; y: number }[] {
  const step = Math.max(1, Math.sqrt((mask.width * mask.height) / target));
  const out: { x: number; y: number }[] = [];
  for (let v = step / 2; v < mask.height; v += step) {
    for (let u = step / 2; u < mask.width; u += step) {
      if (sampleMask(mask, u, v) >= threshold) out.push({ x: u / mask.width - 0.5, y: 0.5 - v / mask.height });
    }
  }
  return out;
}

export function fitPlacement(input: PlacementInput): Placement {
  const area = input.formationArea ?? input.perimeter;
  if (!area) throw new Error('Draw the event perimeter (or a formation area) first.');
  const n = area.outer.length;
  const frame = new LocalFrame({ lat: area.outer.reduce((s, p) => s + p.lat, 0) / n, lng: area.outer.reduce((s, p) => s + p.lng, 0) / n });
  const main = polygonToLocal(frame, area);
  const clipBy = input.formationArea && input.perimeter ? polygonToLocal(frame, input.perimeter) : null;
  const aspect = input.mask.height / input.mask.width;
  const ink = inkSamples(input.mask, input.coverageThreshold ?? 0.5);
  if (ink.length === 0) throw new Error('The design is empty.');
  const maxOut = Math.floor(ink.length * (input.maxClippedFraction ?? 0.005));
  const preferred = input.preferredRotationDeg ?? 0;
  const axis = principalAxis(main.outer);
  const areaM2 = Math.abs(main.outer.reduce((s, p, i) => {
    const q = main.outer[(i + 1) % main.outer.length]!;
    return s + p.x * q.y - q.x * p.y;
  }, 0)) / 2;

  /** Best width and anchor for one rotation (design frame = world rotated by −rotation). */
  const solve = (rot: number) => {
    const poly = main.outer.map((p) => rotateXY(p, -rot));
    const box = bboxOf(poly);
    const bw = box.maxX - box.minX;
    const bh = box.maxY - box.minY;
    // Allowed-area raster in the design frame: ~500 cells along the long side.
    const cell = Math.max(bw, bh) / 500;
    const gw = Math.ceil(bw / cell) + 1;
    const gh = Math.ceil(bh / cell) + 1;
    const grid = new Uint8Array(gw * gh);
    const outer = { outer: poly };
    const per = clipBy ? { outer: clipBy.outer.map((p) => rotateXY(p, -rot)) } : null;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const p = { x: box.minX + (i + 0.5) * cell, y: box.minY + (j + 0.5) * cell };
        if (pointInPolygon(p, outer) && (!per || pointInPolygon(p, per))) grid[j * gw + i] = 1;
      }
    }
    const inside = (x: number, y: number) => {
      const i = Math.floor((x - box.minX) / cell);
      const j = Math.floor((y - box.minY) / cell);
      return i >= 0 && j >= 0 && i < gw && j < gh && grid[j * gw + i] === 1;
    };
    const tryAt = (w: number, ax: number, ay: number) => {
      const h = w * aspect;
      let out = 0;
      for (const s of ink) {
        if (!inside(ax + s.x * w, ay + s.y * h) && ++out > maxOut) return false;
      }
      return true;
    };
    const findAnchor = (w: number, around?: { x: number; y: number; r: number }): { x: number; y: number } | null => {
      const h = w * aspect;
      const x0 = around ? around.x - around.r : box.minX + w / 2;
      const x1 = around ? around.x + around.r : box.maxX - w / 2;
      const y0 = around ? around.y - around.r : box.minY + h / 2;
      const y1 = around ? around.y + around.r : box.maxY - h / 2;
      if (x1 < x0 || y1 < y0) return null;
      const steps = around ? 12 : 28;
      const sx = (x1 - x0) / steps || 1;
      const sy = (y1 - y0) / steps || 1;
      for (let a = 0; a <= steps; a++) {
        for (let b = 0; b <= steps; b++) {
          // Centre-out order: the first fit found is the most central one.
          const x = x0 + sx * (steps / 2 + (a % 2 ? -1 : 1) * Math.ceil(a / 2));
          const y = y0 + sy * (steps / 2 + (b % 2 ? -1 : 1) * Math.ceil(b / 2));
          if (x < x0 - 1e-9 || x > x1 + 1e-9 || y < y0 - 1e-9 || y > y1 + 1e-9) continue;
          if (tryAt(w, x, y)) return { x, y };
        }
      }
      return null;
    };
    let lo = 0;
    let loAnchor: { x: number; y: number } | null = null;
    let hi = Math.min(bw, bh / aspect) * 1.02;
    for (let it = 0; it < 18 && hi - lo > Math.max(0.2, lo * 0.004); it++) {
      const mid = (lo + hi) / 2;
      const a = findAnchor(mid);
      if (a) {
        lo = mid;
        loAnchor = a;
      } else hi = mid;
    }
    if (!loAnchor) return null;
    // Local refinement: finer anchor search lets the width grow a little more.
    const r = Math.max(cell * 4, lo * 0.05);
    let grow = lo;
    for (let it = 0; it < 8; it++) {
      const w = grow * 1.01;
      const a = findAnchor(w, { ...loAnchor, r });
      if (!a) break;
      grow = w;
      loAnchor = a;
    }
    return { rot, w: grow, anchor: loAnchor };
  };

  // Reading direction: of θ and θ+180, the one closest to the preferred rotation.
  const readable = (deg: number) => {
    const a = norm180(deg);
    const b = norm180(deg + 180);
    return Math.abs(norm180(a - preferred)) <= Math.abs(norm180(b - preferred)) ? a : b;
  };
  const candidates = [...new Set([readable(axis.deg), readable(axis.deg + 90), norm180(preferred)].map((d) => Math.round(d * 10) / 10))];
  let best: { rot: number; w: number; anchor: { x: number; y: number } } | null = null;
  for (const rot of candidates) {
    const s = solve(rot);
    if (s && (!best || s.w > best.w)) best = s;
  }
  if (!best) throw new Error('The design does not fit in the formation area.');
  for (const d of [-6, -3, 3, 6]) {
    const s = solve(norm180(best.rot + d));
    if (s && s.w > best.w * 1.01) best = s;
  }
  const widthM = best.w * 0.97; // margin for the finer final raster
  const heightM = widthM * aspect;
  const world = rotateXY(best.anchor, best.rot);
  return {
    anchor: frame.toLatLng(world),
    widthM,
    heightM,
    rotationDeg: Math.round(best.rot * 10) / 10,
    boxCoverage: areaM2 > 0 ? Math.min(1, (widthM * heightM) / areaM2) : 0,
  };
}
