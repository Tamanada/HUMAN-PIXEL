/**
 * FORMATION ENGINE: design (coverage mask) + physical constraints → N human positions.
 *
 * Pipeline (see docs/ARCHITECTURE.md §7):
 *  1. constraint field   valid = design ∧ perimeter ∧ formationArea ∧ ¬(exclusions ⊕ buffers)
 *  2. spacing solve       hex packing, binary search so the lattice holds ≥ N points
 *  3. surplus removal     drop the tail of the progressive order (holes spread evenly)
 *  4. Lloyd relaxation    centroidal Voronoi on the valid field: uniform density, smooth edges
 *  5. separation          enforce the minimum human spacing
 *  6. metrics, zones, fill rank, labels
 */
import {
  LocalFrame,
  pointInPolygon,
  pointInBufferedPolygon,
  polygonToLocal,
  rotate,
  bboxOf,
  type LatLng,
  type Polygon,
  type XY,
  type BBox,
} from '../geo';
import { sampleMask, coverageFraction, type Mask } from './mask';
import { SpatialGrid } from './grid';
import { progressiveFillOrder } from './fillOrder';
import { mulberry32, shuffleInPlace } from './random';

export interface ExclusionInput {
  polygon: Polygon<LatLng>;
  bufferM: number;
}

export interface FormationInput {
  mask: Mask;
  /** Geographic centre of the design. */
  anchor: LatLng;
  widthM: number;
  /** Defaults to widthM × mask aspect ratio (no distortion). */
  heightM?: number;
  /** Counter-clockwise rotation of the design on the ground, degrees. 0 = design "up" faces north. */
  rotationDeg?: number;
  targetCount: number;
  /** Minimum centre-to-centre distance between two people. */
  minSpacingM?: number;
  perimeter?: Polygon<LatLng> | null;
  formationArea?: Polygon<LatLng> | null;
  exclusions?: ExclusionInput[];
  seed?: number;
  lloydIterations?: number;
  /** Target participants per zone. */
  zoneSize?: number;
  coverageThreshold?: number;
  onProgress?: (stage: FormationStage, fraction: number) => void;
}

export type FormationStage = 'field' | 'spacing' | 'relax' | 'separate' | 'metrics' | 'finalize';

export interface FormationPoint {
  /** Stable index 0..N-1 in reading order (top-left → bottom-right of the design). */
  idx: number;
  lat: number;
  lng: number;
  /** East/north meters from the anchor. */
  x: number;
  y: number;
  /** Design-frame coordinates (before rotation), for previews. */
  dx: number;
  dy: number;
  zone: number;
  /** Progressive fill rank, 0 = filled first. */
  fillRank: number;
  /** Public pixel number (random permutation of 1..N), leaks nothing spatial. */
  label: number;
}

export interface ZoneInfo {
  zone: number;
  label: string;
  count: number;
  centroid: LatLng;
}

export interface FormationMetrics {
  pointCount: number;
  spacingM: number;
  nnMinM: number;
  nnMeanM: number;
  nnP5M: number;
  densityPerM2: number;
  designAreaM2: number;
  usableAreaM2: number;
  clippedFraction: number;
  footprintWidthM: number;
  footprintHeightM: number;
  strokeWidthMedianM: number;
  strokeWidthP20M: number;
  strokePersonsP20: number;
  readabilityScore: number;
  lloydIterations: number;
  generationMs: number;
}

export interface FormationWarning {
  code: 'THIN_STROKES' | 'SPARSE' | 'VERY_DENSE' | 'CLIPPED' | 'SPACING_VIOLATION' | 'LOW_READABILITY';
  message: string;
}

export interface FormationResult {
  points: FormationPoint[];
  zones: ZoneInfo[];
  metrics: FormationMetrics;
  warnings: FormationWarning[];
  seed: number;
  widthM: number;
  heightM: number;
  rotationDeg: number;
}

export class FormationError extends Error {
  constructor(
    readonly code: 'EMPTY_DESIGN' | 'DESIGN_TOO_SMALL' | 'INVALID_INPUT' | 'NO_VALID_AREA',
    message: string,
    readonly details: Record<string, number> = {},
  ) {
    super(message);
    this.name = 'FormationError';
  }
}

const SQRT3 = Math.sqrt(3);
const MAX_FIELD_CELLS = 6_000_000;
const MAX_LLOYD_SAMPLES_PER_POINT = 48;

interface Field {
  data: Uint8Array;
  fw: number;
  fh: number;
  cell: number;
  W: number;
  H: number;
  validCells: number;
  designCells: number;
}

export function zoneLabel(i: number): string {
  // A..Z, then AA, AB, ...
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function generateFormation(input: FormationInput): FormationResult {
  const started = performance.now();
  const progress = input.onProgress ?? (() => {});
  const N = input.targetCount;
  if (!Number.isInteger(N) || N < 1 || N > 250_000) throw new FormationError('INVALID_INPUT', 'targetCount must be an integer in [1, 250000]');
  if (!(input.widthM > 0)) throw new FormationError('INVALID_INPUT', 'widthM must be positive');
  const minSpacing = input.minSpacingM ?? 0.9;
  if (!(minSpacing > 0.3)) throw new FormationError('INVALID_INPUT', 'minSpacingM must be > 0.3 m');
  const seed = (input.seed ?? 1) >>> 0;
  const rotationDeg = input.rotationDeg ?? 0;
  const W = input.widthM;
  const H = input.heightM ?? (W * input.mask.height) / input.mask.width;
  const frame = new LocalFrame(input.anchor);
  const rand = mulberry32(seed);

  // ---- 1. constraint field -------------------------------------------------------------
  progress('field', 0);
  const coverage = coverageFraction(input.mask);
  if (coverage <= 0) throw new FormationError('EMPTY_DESIGN', 'The design is empty.');
  const estArea = coverage * W * H;
  const sEst = Math.sqrt((2 * estArea) / (SQRT3 * N));
  let cell = Math.max(sEst / 6, 0.03);
  if ((W / cell) * (H / cell) > MAX_FIELD_CELLS) cell = Math.sqrt((W * H) / MAX_FIELD_CELLS);
  const field = buildField(input, frame, W, H, cell, rotationDeg, progress);
  if (field.validCells === 0) {
    throw new FormationError('NO_VALID_AREA', 'No part of the design lies inside the allowed area (check perimeter and exclusion zones).');
  }
  const usableArea = field.validCells * cell * cell;
  const designArea = field.designCells * cell * cell;
  const clippedFraction = field.designCells ? 1 - field.validCells / field.designCells : 0;

  // ---- 2. spacing solve ----------------------------------------------------------------
  progress('spacing', 0);
  const s0 = Math.sqrt((2 * usableArea) / (SQRT3 * N));
  const ox = rand();
  const oy = rand();
  const countAt = (s: number) => latticeCount(field, s, ox, oy);
  if (countAt(minSpacing) < N) {
    const available = countAt(minSpacing);
    const scale = Math.sqrt(N / Math.max(1, available));
    throw new FormationError(
      'DESIGN_TOO_SMALL',
      `The usable design area (${Math.round(usableArea)} m²) holds only ${available} people at ${minSpacing} m spacing. ` +
        `Scale the design by at least ×${scale.toFixed(2)} or reduce the participant count.`,
      { available, requiredScale: scale, usableAreaM2: usableArea },
    );
  }
  let lo = minSpacing;
  let hi = Math.max(s0 * 1.5, minSpacing * 1.01);
  while (countAt(hi) >= N) hi *= 1.5;
  for (let it = 0; it < 32; it++) {
    const mid = (lo + hi) / 2;
    if (countAt(mid) >= N) lo = mid;
    else hi = mid;
    progress('spacing', it / 32);
  }
  const spacing = lo;
  const lattice = latticePoints(field, spacing, ox, oy);
  let n = lattice.xs.length;

  // ---- 3. surplus removal via progressive order ----------------------------------------
  let xs = lattice.xs;
  let ys = lattice.ys;
  if (n > N) {
    const rank = progressiveFillOrder(xs, ys, n, spacing, seed);
    const keepX = new Float64Array(N);
    const keepY = new Float64Array(N);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (rank[i]! < N) {
        keepX[k] = xs[i]!;
        keepY[k] = ys[i]!;
        k++;
      }
    }
    xs = keepX;
    ys = keepY;
    n = N;
  }

  // ---- 4. Lloyd relaxation -------------------------------------------------------------
  const iterations = input.lloydIterations ?? (N > 30_000 ? 6 : 10);
  const samples = fieldSamples(field, N, rand);
  for (let it = 0; it < iterations; it++) {
    lloydStep(field, xs, ys, n, spacing, samples, minSpacing);
    progress('relax', (it + 1) / iterations);
  }

  // ---- 5. separation -------------------------------------------------------------------
  for (let pass = 0; pass < 8; pass++) {
    const moved = separate(field, xs, ys, n, spacing, minSpacing);
    progress('separate', (pass + 1) / 8);
    if (moved === 0) break;
  }
  repairSpacing(field, xs, ys, n, spacing, minSpacing);

  // ---- 6. metrics, zones, ranks, labels -------------------------------------------------
  progress('metrics', 0);
  const nn = nearestNeighbourStats(xs, ys, n, spacing);
  const stroke = strokeWidths(field);
  const strokePersons = stroke.p20 / Math.max(spacing, 1e-6);
  const readability = readabilityScore(strokePersons, nn.mean, clippedFraction);

  // Reading-order index: rows top→bottom, then left→right (row height = spacing).
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ra = Math.round(-ys[a]! / spacing);
    const rb = Math.round(-ys[b]! / spacing);
    return ra - rb || xs[a]! - xs[b]!;
  });

  const zoneSize = input.zoneSize ?? 1_500;
  const zoneCount = Math.max(1, Math.min(52, Math.round(n / zoneSize)));
  const byX = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const zoneOf = new Int32Array(n);
  byX.forEach((i, k) => {
    zoneOf[i] = Math.min(zoneCount - 1, Math.floor((k * zoneCount) / n));
  });

  const fillRank = progressiveFillOrder(xs, ys, n, spacing, seed + 1);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i + 1;
  shuffleInPlace(labels, rand);

  const points: FormationPoint[] = new Array(n);
  const zoneAcc = Array.from({ length: zoneCount }, () => ({ x: 0, y: 0, c: 0 }));
  order.forEach((i, idx) => {
    const world = rotate({ x: xs[i]!, y: ys[i]! }, rotationDeg);
    const ll = frame.toLatLng(world);
    const z = zoneOf[i]!;
    zoneAcc[z]!.x += world.x;
    zoneAcc[z]!.y += world.y;
    zoneAcc[z]!.c += 1;
    points[idx] = {
      idx,
      lat: ll.lat,
      lng: ll.lng,
      x: world.x,
      y: world.y,
      dx: xs[i]!,
      dy: ys[i]!,
      zone: z,
      fillRank: fillRank[i]!,
      label: labels[idx]!,
    };
  });
  const zones: ZoneInfo[] = zoneAcc.map((z, i) => ({
    zone: i,
    label: zoneLabel(i),
    count: z.c,
    centroid: frame.toLatLng({ x: z.x / Math.max(1, z.c), y: z.y / Math.max(1, z.c) }),
  }));

  const designBox: BBox = bboxOf(points.map((p) => ({ x: p.dx, y: p.dy })));
  const metrics: FormationMetrics = {
    pointCount: n,
    spacingM: spacing,
    nnMinM: nn.min,
    nnMeanM: nn.mean,
    nnP5M: nn.p5,
    densityPerM2: 2 / (SQRT3 * nn.mean * nn.mean),
    designAreaM2: designArea,
    usableAreaM2: usableArea,
    clippedFraction,
    footprintWidthM: designBox.maxX - designBox.minX,
    footprintHeightM: designBox.maxY - designBox.minY,
    strokeWidthMedianM: stroke.median,
    strokeWidthP20M: stroke.p20,
    strokePersonsP20: strokePersons,
    readabilityScore: readability,
    lloydIterations: iterations,
    generationMs: Math.round(performance.now() - started),
  };
  progress('finalize', 1);
  return {
    points,
    zones,
    metrics,
    warnings: buildWarnings(metrics, minSpacing),
    seed,
    widthM: W,
    heightM: H,
    rotationDeg,
  };
}

// ----------------------------------------------------------------------------------------------

function buildField(
  input: FormationInput,
  frame: LocalFrame,
  W: number,
  H: number,
  cell: number,
  rotationDeg: number,
  progress: (s: FormationStage, f: number) => void,
): Field {
  const fw = Math.max(1, Math.ceil(W / cell));
  const fh = Math.max(1, Math.ceil(H / cell));
  const data = new Uint8Array(fw * fh);
  const threshold = input.coverageThreshold ?? 0.5;
  const m = input.mask;
  const perimeter = input.perimeter ? polygonToLocal(frame, input.perimeter) : null;
  const area = input.formationArea ? polygonToLocal(frame, input.formationArea) : null;
  const exclusions = (input.exclusions ?? []).map((e) => {
    const poly = polygonToLocal(frame, e.polygon);
    const b = bboxOf(poly.outer);
    const buf = Math.max(0, e.bufferM);
    return { poly, buf, box: { minX: b.minX - buf, minY: b.minY - buf, maxX: b.maxX + buf, maxY: b.maxY + buf } };
  });
  let validCells = 0;
  let designCells = 0;
  const world: XY = { x: 0, y: 0 };
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  for (let j = 0; j < fh; j++) {
    const y = H / 2 - (j + 0.5) * cell;
    const v = ((H / 2 - y) / H) * m.height;
    for (let i = 0; i < fw; i++) {
      const x = -W / 2 + (i + 0.5) * cell;
      const u = ((x + W / 2) / W) * m.width;
      if (sampleMask(m, u, v) < threshold) continue;
      designCells++;
      world.x = x * c - y * s;
      world.y = x * s + y * c;
      if (perimeter && !pointInPolygon(world, perimeter)) continue;
      if (area && !pointInPolygon(world, area)) continue;
      let excluded = false;
      for (const e of exclusions) {
        if (world.x < e.box.minX || world.x > e.box.maxX || world.y < e.box.minY || world.y > e.box.maxY) continue;
        if (pointInBufferedPolygon(world, e.poly, e.buf)) {
          excluded = true;
          break;
        }
      }
      if (excluded) continue;
      data[j * fw + i] = 1;
      validCells++;
    }
    if ((j & 63) === 0) progress('field', j / fh);
  }
  return { data, fw, fh, cell, W, H, validCells, designCells };
}

function isValid(f: Field, x: number, y: number): boolean {
  const i = Math.floor((x + f.W / 2) / f.cell);
  const j = Math.floor((f.H / 2 - y) / f.cell);
  if (i < 0 || j < 0 || i >= f.fw || j >= f.fh) return false;
  return f.data[j * f.fw + i] === 1;
}

function latticeCount(f: Field, s: number, ox: number, oy: number): number {
  let count = 0;
  const dy = (s * SQRT3) / 2;
  let r = 0;
  for (let y = f.H / 2 - oy * dy; y > -f.H / 2; y -= dy, r++) {
    const off = ((r & 1) * s) / 2 + ox * s;
    for (let x = -f.W / 2 + off; x < f.W / 2; x += s) if (isValid(f, x, y)) count++;
  }
  return count;
}

function latticePoints(f: Field, s: number, ox: number, oy: number): { xs: Float64Array; ys: Float64Array } {
  const xs: number[] = [];
  const ys: number[] = [];
  const dy = (s * SQRT3) / 2;
  let r = 0;
  for (let y = f.H / 2 - oy * dy; y > -f.H / 2; y -= dy, r++) {
    const off = ((r & 1) * s) / 2 + ox * s;
    for (let x = -f.W / 2 + off; x < f.W / 2; x += s) {
      if (isValid(f, x, y)) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

interface Samples {
  xs: Float64Array;
  ys: Float64Array;
}

/** Valid field cell centres, randomly subsampled so Lloyd cost stays ~O(N·48). */
function fieldSamples(f: Field, n: number, rand: () => number): Samples {
  const keepProb = Math.min(1, (n * MAX_LLOYD_SAMPLES_PER_POINT) / f.validCells);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j < f.fh; j++) {
    for (let i = 0; i < f.fw; i++) {
      if (f.data[j * f.fw + i] !== 1) continue;
      if (keepProb < 1 && rand() > keepProb) continue;
      xs.push(-f.W / 2 + (i + 0.5) * f.cell);
      ys.push(f.H / 2 - (j + 0.5) * f.cell);
    }
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

function lloydStep(f: Field, xs: Float64Array, ys: Float64Array, n: number, spacing: number, samples: Samples, minSpacing: number): void {
  const grid = new SpatialGrid(xs, ys, n, spacing, -f.W / 2 - spacing, -f.H / 2 - spacing, f.W / 2 + spacing, f.H / 2 + spacing);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const cnt = new Int32Array(n);
  for (let k = 0; k < samples.xs.length; k++) {
    const x = samples.xs[k]!;
    const y = samples.ys[k]!;
    const { index } = grid.nearest(x, y, -1, 3);
    if (index < 0) continue;
    sx[index]! += x;
    sy[index]! += y;
    cnt[index]!++;
  }
  for (let i = 0; i < n; i++) {
    if (cnt[i] === 0) continue;
    const cx = sx[i]! / cnt[i]!;
    const cy = sy[i]! / cnt[i]!;
    // Centroids of non-convex cells can fall outside the shape, and a move must never bring two
    // people closer than the minimum spacing: only accept moves that satisfy both.
    if (isValid(f, cx, cy) && clearOfNeighbours(grid, xs, ys, i, cx, cy, minSpacing)) {
      xs[i] = cx;
      ys[i] = cy;
    }
  }
}

function clearOfNeighbours(grid: SpatialGrid, xs: Float64Array, ys: Float64Array, self: number, x: number, y: number, minSpacing: number): boolean {
  const m2 = minSpacing * minSpacing;
  let ok = true;
  // Radius 2 cells: neighbours may have moved (by < 1 cell) since the grid was built.
  grid.forEachNear(x, y, 2, (j) => {
    if (!ok || j === self) return;
    const dx = xs[j]! - x;
    const dy = ys[j]! - y;
    if (dx * dx + dy * dy < m2) ok = false;
  });
  return ok;
}

/**
 * Last-resort guarantee: any point still closer than minSpacing to a neighbour is moved to the
 * nearest valid spot (rings of candidates) that is clear of everyone. Returns remaining violations.
 */
function repairSpacing(f: Field, xs: Float64Array, ys: Float64Array, n: number, spacing: number, minSpacing: number): number {
  const target = minSpacing * 1.001;
  let remaining = 0;
  for (let pass = 0; pass < 3; pass++) {
    const grid = new SpatialGrid(xs, ys, n, spacing, -f.W / 2 - spacing, -f.H / 2 - spacing, f.W / 2 + spacing, f.H / 2 + spacing);
    remaining = 0;
    for (let i = 0; i < n; i++) {
      if (clearOfNeighbours(grid, xs, ys, i, xs[i]!, ys[i]!, target)) continue;
      let fixed = false;
      for (let ring = 1; ring <= 8 && !fixed; ring++) {
        const r = spacing * 0.2 * ring;
        const steps = 8 + ring * 4;
        for (let k = 0; k < steps; k++) {
          const a = (k / steps) * Math.PI * 2 + ring;
          const x = xs[i]! + Math.cos(a) * r;
          const y = ys[i]! + Math.sin(a) * r;
          if (isValid(f, x, y) && clearOfNeighbours(grid, xs, ys, i, x, y, target)) {
            xs[i] = x;
            ys[i] = y;
            fixed = true;
            break;
          }
        }
      }
      if (!fixed) remaining++;
    }
    if (remaining === 0) break;
  }
  return remaining;
}

function separate(f: Field, xs: Float64Array, ys: Float64Array, n: number, spacing: number, minSpacing: number): number {
  const grid = new SpatialGrid(xs, ys, n, spacing, -f.W / 2 - spacing, -f.H / 2 - spacing, f.W / 2 + spacing, f.H / 2 + spacing);
  let moved = 0;
  const target = minSpacing * 1.0005;
  for (let i = 0; i < n; i++) {
    grid.forEachNear(xs[i]!, ys[i]!, 1, (j) => {
      if (j <= i) return;
      const dx = xs[j]! - xs[i]!;
      const dy = ys[j]! - ys[i]!;
      const d = Math.hypot(dx, dy);
      if (d >= target) return;
      const ux = d > 1e-9 ? dx / d : 1;
      const uy = d > 1e-9 ? dy / d : 0;
      const push = (target - d) / 2;
      const ax = xs[i]! - ux * push;
      const ay = ys[i]! - uy * push;
      const bx = xs[j]! + ux * push;
      const by = ys[j]! + uy * push;
      const aOk = isValid(f, ax, ay);
      const bOk = isValid(f, bx, by);
      if (aOk && bOk) {
        xs[i] = ax;
        ys[i] = ay;
        xs[j] = bx;
        ys[j] = by;
      } else if (aOk) {
        xs[i] = xs[i]! - ux * push * 2;
        ys[i] = ys[i]! - uy * push * 2;
        if (!isValid(f, xs[i]!, ys[i]!)) {
          xs[i] = ax;
          ys[i] = ay;
        }
      } else if (bOk) {
        xs[j] = xs[j]! + ux * push * 2;
        ys[j] = ys[j]! + uy * push * 2;
        if (!isValid(f, xs[j]!, ys[j]!)) {
          xs[j] = bx;
          ys[j] = by;
        }
      } else return;
      moved++;
    });
  }
  return moved;
}

export function nearestNeighbourStats(xs: Float64Array, ys: Float64Array, n: number, spacing: number): { min: number; mean: number; p5: number; all: Float64Array } {
  if (n < 2) return { min: 0, mean: 0, p5: 0, all: new Float64Array(0) };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]!);
    maxX = Math.max(maxX, xs[i]!);
    minY = Math.min(minY, ys[i]!);
    maxY = Math.max(maxY, ys[i]!);
  }
  const grid = new SpatialGrid(xs, ys, n, spacing, minX, minY, maxX, maxY);
  const all = new Float64Array(n);
  let sum = 0;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const { dist2 } = grid.nearest(xs[i]!, ys[i]!, i, 8);
    const d = Math.sqrt(dist2);
    all[i] = d;
    sum += d;
    if (d < min) min = d;
  }
  const sorted = Float64Array.from(all).sort();
  return { min, mean: sum / n, p5: sorted[Math.floor(n * 0.05)]!, all };
}

/**
 * Stroke width from a chamfer distance transform of the valid field: sampled on ridge cells
 * (local maxima along x or y ≈ medial axis). Width = 2 × distance to the nearest edge.
 */
function strokeWidths(f: Field): { median: number; p20: number } {
  const { fw, fh } = f;
  const INF = 1e9;
  const dt = new Float32Array(fw * fh);
  for (let k = 0; k < dt.length; k++) dt[k] = f.data[k] === 1 ? INF : 0;
  const a = 1;
  const b = Math.SQRT2;
  const get = (i: number, j: number) => (i < 0 || j < 0 || i >= fw || j >= fh ? 0 : dt[j * fw + i]!);
  for (let j = 0; j < fh; j++) {
    for (let i = 0; i < fw; i++) {
      const k = j * fw + i;
      if (dt[k] === 0) continue;
      dt[k] = Math.min(dt[k]!, get(i - 1, j) + a, get(i, j - 1) + a, get(i - 1, j - 1) + b, get(i + 1, j - 1) + b);
    }
  }
  for (let j = fh - 1; j >= 0; j--) {
    for (let i = fw - 1; i >= 0; i--) {
      const k = j * fw + i;
      if (dt[k] === 0) continue;
      dt[k] = Math.min(dt[k]!, get(i + 1, j) + a, get(i, j + 1) + a, get(i + 1, j + 1) + b, get(i - 1, j + 1) + b);
    }
  }
  const widths: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((fw * fh) / 400_000)));
  for (let j = 1; j < fh - 1; j += step) {
    for (let i = 1; i < fw - 1; i += step) {
      const d = dt[j * fw + i]!;
      if (d < 1.5) continue;
      // Medial-axis test: a local maximum across the stroke in some direction. Requiring one
      // strict inequality excludes the flat plateaus that run along the stroke.
      const ridge = (a1: number, a2: number) => d >= a1 && d >= a2 && (d > a1 || d > a2);
      if (
        ridge(get(i - 1, j), get(i + 1, j)) ||
        ridge(get(i, j - 1), get(i, j + 1)) ||
        ridge(get(i - 1, j - 1), get(i + 1, j + 1)) ||
        ridge(get(i + 1, j - 1), get(i - 1, j + 1))
      ) {
        widths.push(2 * d * f.cell);
      }
    }
  }
  if (widths.length === 0) return { median: 0, p20: 0 };
  widths.sort((x, y) => x - y);
  return { median: widths[widths.length >> 1]!, p20: widths[Math.floor(widths.length * 0.2)]! };
}

function readabilityScore(strokePersons: number, spacing: number, clipped: number): number {
  // Strokes ≥ 4 people wide read clearly from the air; below 2 they break apart.
  const stroke = Math.max(0, Math.min(1, (strokePersons - 1.5) / 2.5));
  // Beyond ~3 m spacing the "ink" looks faint on photos.
  const density = spacing <= 2 ? 1 : Math.max(0, 1 - (spacing - 2) / 3);
  const integrity = Math.max(0, 1 - clipped * 3);
  return Math.round(100 * (0.6 * stroke + 0.25 * density + 0.15 * integrity));
}

function buildWarnings(m: FormationMetrics, minSpacing: number): FormationWarning[] {
  const w: FormationWarning[] = [];
  if (m.strokePersonsP20 < 3) {
    w.push({
      code: 'THIN_STROKES',
      message: `Some strokes are only ~${m.strokePersonsP20.toFixed(1)} people wide; they may be hard to read from above. Use a bolder font, a larger design or more participants.`,
    });
  }
  if (m.nnMeanM > 3) {
    w.push({ code: 'SPARSE', message: `Average spacing is ${m.nnMeanM.toFixed(1)} m; the image may look faint. Reduce the design size.` });
  }
  if (m.nnMeanM < 1.05) {
    w.push({ code: 'VERY_DENSE', message: `Average spacing is ${m.nnMeanM.toFixed(2)} m, which is very dense. Review crowd-safety requirements.` });
  }
  if (m.clippedFraction > 0.01) {
    w.push({ code: 'CLIPPED', message: `${(m.clippedFraction * 100).toFixed(1)}% of the design falls outside the allowed area and was removed.` });
  }
  if (m.nnMinM < minSpacing * 0.97) {
    w.push({ code: 'SPACING_VIOLATION', message: `Closest pair is ${m.nnMinM.toFixed(2)} m apart (minimum ${minSpacing} m).` });
  }
  if (m.readabilityScore < 50) {
    w.push({ code: 'LOW_READABILITY', message: `Readability score ${m.readabilityScore}/100.` });
  }
  return w;
}
