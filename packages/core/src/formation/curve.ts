/**
 * CURVED LAYOUT: the message is cut into segments laid along the spine of the area, each with its
 * own rotation, all at the SAME height.
 *
 * Why: a rigid rectangle on a curving beach is capped by the bend, not by the width of the sand,
 * so the letters stay small. Short segments sit almost straight in the local strip, so the height
 * is limited only by the width of the area — far bigger letters, far more people.
 *
 * Why one shared height: sized independently, a short word would come out twice as tall as a long
 * one and the message would read like a ransom note. The gain comes from following the curve, not
 * from resizing words.
 *
 * Method:
 *   1. spine     traced from the deepest point of the area outwards, re-centring across the band
 *                at every step, so the centre line turns with the beach;
 *   2. layout    for a candidate height, every segment's width follows from its aspect ratio; the
 *                blocks are walked along the spine by arc length, each turned to the local chord;
 *   3. fit       the segment's ink samples must stay inside the area (maxClippedFraction tolerated);
 *   4. size      bisection on the shared height, largest first.
 * The reading direction is the one closest to the organizer's map view, as in fitPlacement.
 */
import { LocalFrame, bboxOf, pointInPolygon, polygonToLocal, rotate, type LatLng, type Polygon, type XY } from '../geo';
import { principalAxis } from './placement';
import { sampleMask, type Mask } from './mask';

/** One segment of the message, placed on the ground. */
export interface PlacedBlock {
  /** Centre of the block. */
  anchor: LatLng;
  widthM: number;
  heightM: number;
  /** Counter-clockwise rotation on the ground, degrees. */
  rotationDeg: number;
}

export interface CurvedPlacementInput {
  /** One mask per segment, in reading order, all sharing the same pixel height. */
  masks: Mask[];
  perimeter?: Polygon<LatLng> | null;
  formationArea?: Polygon<LatLng> | null;
  /** Rotation the message should read closest to (e.g. aligned with the map view). Default 0. */
  preferredRotationDeg?: number;
  maxClippedFraction?: number;
  coverageThreshold?: number;
  /** Space between two segments, in block heights. Default 0.4. */
  gapEm?: number;
}

export interface CurvedPlacement {
  blocks: PlacedBlock[];
  /** The shared block height (letter size) in metres. */
  heightM: number;
  /** Length of the message measured along the curve. */
  lengthM: number;
  /** Total turn between the first and the last segment: how much the message bends. */
  bendDeg: number;
}

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Ink of a mask as points normalised to [-0.5, 0.5] × [-0.5, 0.5] (y up). */
function inkSamples(mask: Mask, threshold: number, target: number): XY[] {
  const step = Math.max(1, Math.sqrt((mask.width * mask.height) / target));
  const out: XY[] = [];
  for (let v = step / 2; v < mask.height; v += step) {
    for (let u = step / 2; u < mask.width; u += step) {
      if (sampleMask(mask, u, v) >= threshold) out.push({ x: u / mask.width - 0.5, y: 0.5 - v / mask.height });
    }
  }
  return out;
}

/**
 * Centre line of the area, traced from its deepest point outwards.
 *
 * Slicing along one global axis fails on a strongly bent shape — near the tips of a crescent a
 * vertical slice runs ALONG the sand instead of across it. So the trace is local: re-centre across
 * the band, step forward, re-centre again; the direction from one centre to the next is the local
 * tangent, so the line turns with the beach.
 */
function traceSpine(inside: (x: number, y: number) => boolean, seed: XY, step: number, maxSteps: number): XY[] {
  const scan = step / 2;
  /** Centre of the band through p along (nx, ny): the run containing p, else the nearest one. */
  const centre = (p: XY, nx: number, ny: number, reach: number): { p: XY; half: number } | null => {
    let bestMid = 0;
    let bestHalf = 0;
    let bestKey = Infinity;
    let from = NaN;
    for (let t = -reach; t <= reach + scan; t += scan) {
      const on = t <= reach && inside(p.x + nx * t, p.y + ny * t);
      if (on && Number.isNaN(from)) from = t;
      if (!on && !Number.isNaN(from)) {
        const to = t - scan;
        // Prefer the run around p; failing that (p has drifted off the sand), the closest one.
        const key = from <= 0 && to >= 0 ? 0 : Math.min(Math.abs(from), Math.abs(to));
        if (key < bestKey || (key === bestKey && to - from > bestHalf * 2)) {
          bestKey = key;
          bestMid = (from + to) / 2;
          bestHalf = (to - from) / 2;
        }
        from = NaN;
      }
    }
    if (!Number.isFinite(bestKey)) return null;
    return { p: { x: p.x + nx * bestMid, y: p.y + ny * bestMid }, half: bestHalf };
  };

  /** Local direction of the band: the one whose cross-section through p is narrowest. */
  const heading = (p: XY, reach: number): { hx: number; hy: number; half: number } => {
    let best = { hx: 1, hy: 0, half: Infinity };
    for (let a = 0; a < 180; a += 5) {
      const r = (a * Math.PI) / 180;
      const c = centre(p, Math.cos(r), Math.sin(r), reach);
      if (c && c.half < best.half) best = { hx: -Math.sin(r), hy: Math.cos(r), half: c.half };
    }
    return best.half === Infinity ? { hx: 1, hy: 0, half: reach } : best;
  };

  const reach0 = step * maxSteps;
  const h0 = heading(seed, reach0);
  const walk = (sign: number): XY[] => {
    const out: XY[] = [];
    let hx = h0.hx * sign;
    let hy = h0.hy * sign;
    let half = Math.max(h0.half, step);
    let c = centre(seed, -hy, hx, half * 3)?.p ?? seed;
    for (let i = 0; i < maxSteps; i++) {
      const next = centre({ x: c.x + hx * step, y: c.y + hy * step }, -hy, hx, Math.max(half * 3, step * 2));
      if (!next) break;
      const dx = next.p.x - c.x;
      const dy = next.p.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d < step * 0.25) break; // stalled against the end of the area
      hx = dx / d;
      hy = dy / d;
      half = Math.max(next.half, step);
      c = next.p;
      out.push(c);
    }
    return out;
  };

  const back = walk(-1);
  const fwd = walk(1);
  const start = centre(seed, -h0.hy, h0.hx, Math.max(h0.half, step) * 3)?.p ?? seed;
  return [...back.reverse(), start, ...fwd];
}

/** The point of the area furthest from its edge: the safest place to start the trace from. */
function deepestCell(grid: Uint8Array, gw: number, gh: number, box: { minX: number; minY: number }, cell: number): { p: XY; depth: number } | null {
  // Two-pass chamfer distance to the outside, in cells.
  const d = new Float32Array(gw * gh);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = grid[i] ? INF : 0;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= gw || j >= gh ? 0 : d[j * gw + i]!);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      if (!grid[j * gw + i]) continue;
      d[j * gw + i] = Math.min(d[j * gw + i]!, at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + 1.414, at(i + 1, j - 1) + 1.414);
    }
  }
  let best = -1;
  let bi = 0;
  let bj = 0;
  for (let j = gh - 1; j >= 0; j--) {
    for (let i = gw - 1; i >= 0; i--) {
      if (!grid[j * gw + i]) continue;
      const v = Math.min(d[j * gw + i]!, at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + 1.414, at(i - 1, j + 1) + 1.414);
      d[j * gw + i] = v;
      if (v > best) {
        best = v;
        bi = i;
        bj = j;
      }
    }
  }
  if (best <= 0) return null;
  return { p: { x: box.minX + (bi + 0.5) * cell, y: box.minY + (bj + 0.5) * cell }, depth: best * cell };
}

/** Point on the spine at arc length s (clamped at both ends). */
function pointAt(pts: XY[], cum: number[], s: number): XY {
  const total = cum[cum.length - 1]!;
  const t = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < t) i++;
  const a = pts[i - 1]!;
  const b = pts[i]!;
  const span = cum[i]! - cum[i - 1]!;
  const f = span > 1e-9 ? (t - cum[i - 1]!) / span : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

export function fitCurvedPlacement(input: CurvedPlacementInput): CurvedPlacement {
  const area = input.formationArea ?? input.perimeter;
  if (!area) throw new Error('Draw the event perimeter (or a formation area) first.');
  if (input.masks.length === 0) throw new Error('The design is empty.');
  const threshold = input.coverageThreshold ?? 0.5;
  const aspects = input.masks.map((m) => m.width / m.height);
  const inks = input.masks.map((m) => inkSamples(m, threshold, 700));
  if (inks.some((s) => s.length === 0)) throw new Error('One of the segments is empty.');
  const maxOut = inks.map((s) => Math.floor(s.length * (input.maxClippedFraction ?? 0.005)));

  const n = area.outer.length;
  const frame = new LocalFrame({ lat: area.outer.reduce((s, p) => s + p.lat, 0) / n, lng: area.outer.reduce((s, p) => s + p.lng, 0) / n });
  const main = polygonToLocal(frame, area);
  const clipBy = input.formationArea && input.perimeter ? polygonToLocal(frame, input.perimeter) : null;

  // Allowed area rasterised once: the fit test runs it millions of times.
  const box = bboxOf(main.outer);
  const bw = box.maxX - box.minX;
  const bh = box.maxY - box.minY;
  const cell = Math.max(bw, bh) / 600;
  const gw = Math.ceil(bw / cell) + 1;
  const gh = Math.ceil(bh / cell) + 1;
  const grid = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const p = { x: box.minX + (i + 0.5) * cell, y: box.minY + (j + 0.5) * cell };
      if (pointInPolygon(p, main) && (!clipBy || pointInPolygon(p, clipBy))) grid[j * gw + i] = 1;
    }
  }
  const inside = (x: number, y: number) => {
    const i = Math.floor((x - box.minX) / cell);
    const j = Math.floor((y - box.minY) / cell);
    return i >= 0 && j >= 0 && i < gw && j < gh && grid[j * gw + i] === 1;
  };

  const axis = principalAxis(main.outer);
  const preferred = input.preferredRotationDeg ?? 0;
  const deep = deepestCell(grid, gw, gh, box, cell);
  if (!deep) throw new Error('The formation area is too small for a curved layout.');
  const step = Math.max(cell * 2, Math.min(deep.depth, Math.max(bw, bh) / 30));
  const raw = traceSpine(inside, deep.p, step, Math.ceil(((bw + bh) * 3) / step) + 4);
  if (raw.length < 2) throw new Error('The formation area is too small for a curved layout.');
  // Reading direction: of the traced line and its reverse, the one closest to the organizer's view.
  const chord = (Math.atan2(raw[raw.length - 1]!.y - raw[0]!.y, raw[raw.length - 1]!.x - raw[0]!.x) * 180) / Math.PI;
  const pts = Math.abs(norm180(chord - preferred)) <= 90 ? raw : [...raw].reverse();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = cum[cum.length - 1]!;

  const gap = input.gapEm ?? 0.4;
  const unit = aspects.reduce((s, a) => s + a, 0) + gap * (aspects.length - 1); // message length ÷ height

  /** Blocks for a shared height, walked along the spine from arc length `start`. */
  const layout = (h: number, start: number): { centre: XY; rot: number; w: number }[] => {
    const out: { centre: XY; rot: number; w: number }[] = [];
    let s = start;
    for (const a of aspects) {
      const w = a * h;
      // The block spans the curve from s to s+w: its chord gives both its centre and its angle.
      const p0 = pointAt(pts, cum, s);
      const p1 = pointAt(pts, cum, s + w);
      const rot = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
      out.push({ centre: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, rot, w });
      s += w + gap * h;
    }
    return out;
  };

  const fits = (blocks: { centre: XY; rot: number; w: number }[], h: number): boolean => {
    for (let b = 0; b < blocks.length; b++) {
      const { centre, rot, w } = blocks[b]!;
      const r = (rot * Math.PI) / 180;
      const c = Math.cos(r);
      const sn = Math.sin(r);
      let out = 0;
      for (const p of inks[b]!) {
        const lx = p.x * w;
        const ly = p.y * h;
        if (!inside(centre.x + lx * c - ly * sn, centre.y + lx * sn + ly * c) && ++out > maxOut[b]!) return false;
      }
    }
    return true;
  };

  /** Largest feasible layout for a height, trying a few positions along the curve. */
  const solve = (h: number): { centre: XY; rot: number; w: number }[] | null => {
    const len = unit * h;
    if (len > total) return null;
    const slack = total - len;
    for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.05, 0.95]) {
      const blocks = layout(h, slack * f);
      if (fits(blocks, h)) return blocks;
    }
    return null;
  };

  let lo = 0;
  let hi = Math.min(axis.short * 1.2, total / unit);
  let best: { centre: XY; rot: number; w: number }[] | null = null;
  for (let it = 0; it < 22 && hi - lo > Math.max(0.05, lo * 0.004); it++) {
    const mid = (lo + hi) / 2;
    const blocks = solve(mid);
    if (blocks) {
      lo = mid;
      best = blocks;
    } else hi = mid;
  }
  if (!best) throw new Error('The message does not fit along the formation area.');
  // Margin for the finer raster of the generation itself, as in fitPlacement.
  let heightM = lo * 0.97;
  const shrunk = solve(heightM);
  if (shrunk) best = shrunk;
  else heightM = lo;

  const rots = best.map((b) => b.rot);
  return {
    blocks: best.map((b) => ({
      anchor: frame.toLatLng(b.centre),
      widthM: b.w,
      heightM,
      rotationDeg: Math.round(b.rot * 10) / 10,
    })),
    heightM,
    lengthM: unit * heightM,
    bendDeg: Math.round((Math.max(...rots) - Math.min(...rots)) * 10) / 10,
  };
}
