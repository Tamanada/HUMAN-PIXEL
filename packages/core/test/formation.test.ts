import { describe, expect, it } from 'vitest';
import {
  FormationError,
  LocalFrame,
  createMask,
  fillEllipse,
  generateFormation,
  haversineDistance,
  nearestNeighbourStats,
  pointInPolygon,
  pointInBufferedPolygon,
  pointsChecksum,
  polygonToLocal,
  progressiveFillOrder,
  renderBitmapText,
  toPointRows,
  type FormationResult,
  type LatLng,
  type Polygon,
} from '../src';

const ANCHOR: LatLng = { lat: 9.6804, lng: 100.0663 };
const frame = new LocalFrame(ANCHOR);
const rect = (w: number, h: number, cx = 0, cy = 0): Polygon<LatLng> => ({
  outer: [
    frame.toLatLng({ x: cx - w / 2, y: cy - h / 2 }),
    frame.toLatLng({ x: cx + w / 2, y: cy - h / 2 }),
    frame.toLatLng({ x: cx + w / 2, y: cy + h / 2 }),
    frame.toLatLng({ x: cx - w / 2, y: cy + h / 2 }),
  ],
});

function assertInvariants(r: FormationResult, n: number, minSpacing: number) {
  expect(r.points).toHaveLength(n);
  // Unique, contiguous indices, labels and ranks.
  const idx = new Set(r.points.map((p) => p.idx));
  const labels = new Set(r.points.map((p) => p.label));
  const ranks = new Set(r.points.map((p) => p.fillRank));
  expect(idx.size).toBe(n);
  expect(labels.size).toBe(n);
  expect(ranks.size).toBe(n);
  expect(Math.min(...labels)).toBe(1);
  expect(Math.max(...labels)).toBe(n);
  expect(Math.max(...ranks)).toBe(n - 1);
  expect(r.metrics.nnMinM).toBeGreaterThanOrEqual(minSpacing);
  for (const p of r.points) {
    expect(Number.isFinite(p.lat) && Number.isFinite(p.lng)).toBe(true);
  }
}

describe('formation engine: text', () => {
  const mask = renderBitmapText('LOVE\nPHANGAN', 10);

  for (const n of [1_000, 5_000, 12_000]) {
    it(`LOVE PHANGAN with ${n.toLocaleString()} participants`, () => {
      const width = Math.sqrt(n) * 6; // keeps comparable density across sizes
      const r = generateFormation({ mask, anchor: ANCHOR, widthM: width, targetCount: n, seed: 1234 });
      assertInvariants(r, n, 0.9);
      expect(r.metrics.spacingM).toBeGreaterThan(0.9);
      // Uniformity: the closest pairs are not much closer than the average pair (no clumping).
      expect(r.metrics.nnP5M / r.metrics.nnMeanM).toBeGreaterThan(0.75);
      expect(r.zones.length).toBeGreaterThanOrEqual(1);
      expect(r.zones.reduce((a, z) => a + z.count, 0)).toBe(n);
      // Stroke thickness in persons is scale-invariant: it depends on N, not on metres.
      if (n >= 12_000) expect(r.metrics.readabilityScore).toBeGreaterThanOrEqual(90);
      if (n <= 1_000) expect(r.warnings.some((w) => w.code === 'THIN_STROKES')).toBe(true);
    });
  }

  it('50,000 participants (architecture target)', () => {
    const n = 50_000;
    const r = generateFormation({ mask, anchor: ANCHOR, widthM: 1300, targetCount: n, seed: 99, lloydIterations: 4 });
    assertInvariants(r, n, 0.9);
    expect(r.metrics.generationMs).toBeLessThan(90_000);
  });

  it('never violates minimum spacing, even when the design is packed tight', () => {
    for (const [n, seed] of [[300, 4242], [400, 4242], [800, 7], [2_000, 11]] as const) {
      const r = generateFormation({ mask, anchor: ANCHOR, widthM: Math.sqrt(n) * 3.2, targetCount: n, seed });
      expect(r.metrics.nnMinM, `n=${n}`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('is deterministic for a seed and different for another seed', () => {
    const a = generateFormation({ mask, anchor: ANCHOR, widthM: 200, targetCount: 800, seed: 5 });
    const b = generateFormation({ mask, anchor: ANCHOR, widthM: 200, targetCount: 800, seed: 5 });
    const c = generateFormation({ mask, anchor: ANCHOR, widthM: 200, targetCount: 800, seed: 6 });
    expect(pointsChecksum(a.points)).toBe(pointsChecksum(b.points));
    expect(a.points[10]).toEqual(b.points[10]);
    expect(pointsChecksum(a.points)).not.toBe(pointsChecksum(c.points));
  });

  it('fails loudly when the design cannot hold everyone at minimum spacing', () => {
    try {
      generateFormation({ mask, anchor: ANCHOR, widthM: 40, targetCount: 12_000, seed: 1 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FormationError);
      expect((e as FormationError).code).toBe('DESIGN_TOO_SMALL');
      expect((e as FormationError).details.requiredScale).toBeGreaterThan(1);
    }
  });

  it('warns on thin strokes', () => {
    const thin = renderBitmapText('HI', 2);
    const r = generateFormation({ mask: thin, anchor: ANCHOR, widthM: 30, targetCount: 120, seed: 3, minSpacingM: 0.6 });
    expect(r.warnings.some((w) => w.code === 'THIN_STROKES')).toBe(true);
  });
});

describe('formation engine: safety constraints', () => {
  const disc = createMask(400, 400);
  fillEllipse(disc, 200, 200, 190, 190);

  it('never places points inside exclusion zones (+ safety buffer) or outside the perimeter', () => {
    const perimeter = rect(170, 400); // clips the left and right of a 200 m disc
    const rock = rect(30, 30, 20, 10);
    const tower = rect(10, 10, -50, -40);
    const r = generateFormation({
      mask: disc,
      anchor: ANCHOR,
      widthM: 200,
      targetCount: 5_000,
      seed: 11,
      perimeter,
      exclusions: [
        { polygon: rock, bufferM: 3 },
        { polygon: tower, bufferM: 5 },
      ],
    });
    assertInvariants(r, 5_000, 0.9);
    const per = polygonToLocal(frame, perimeter);
    const rk = polygonToLocal(frame, rock);
    const tw = polygonToLocal(frame, tower);
    for (const p of r.points) {
      const q = frame.toLocal(p);
      expect(pointInPolygon(q, per)).toBe(true);
      expect(pointInBufferedPolygon(q, rk, 3)).toBe(false);
      expect(pointInBufferedPolygon(q, tw, 5)).toBe(false);
    }
    expect(r.warnings.some((w) => w.code === 'CLIPPED')).toBe(true);
  });

  it('applies rotation around the anchor', () => {
    const bar = createMask(400, 40);
    bar.data.fill(255);
    const r = generateFormation({ mask: bar, anchor: ANCHOR, widthM: 200, targetCount: 1_000, seed: 2, rotationDeg: 90 });
    const ys = r.points.map((p) => p.y);
    const xs = r.points.map((p) => p.x);
    // Rotated 90°: the long axis now runs north-south.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(150);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(30);
    // Anchor is the centre.
    const c = r.points.reduce((a, p) => ({ lat: a.lat + p.lat / r.points.length, lng: a.lng + p.lng / r.points.length }), { lat: 0, lng: 0 });
    expect(haversineDistance(c, ANCHOR)).toBeLessThan(3);
  });
});

describe('progressive fill order', () => {
  it('every prefix is spread over the whole design (partial turnout stays readable)', () => {
    const mask = renderBitmapText('PEACE', 10);
    const r = generateFormation({ mask, anchor: ANCHOR, widthM: 400, targetCount: 6_000, seed: 8 });
    for (const turnout of [0.25, 0.5, 0.7]) {
      const k = Math.floor(r.points.length * turnout);
      const chosen = r.points.filter((p) => p.fillRank < k);
      const xs = Float64Array.from(chosen.map((p) => p.dx));
      const ys = Float64Array.from(chosen.map((p) => p.dy));
      const nn = nearestNeighbourStats(xs, ys, chosen.length, r.metrics.spacingM / Math.sqrt(turnout));
      // Ideal thinning of a uniform set scales spacing by 1/sqrt(turnout).
      const ideal = r.metrics.nnMeanM / Math.sqrt(turnout);
      expect(nn.mean).toBeGreaterThan(ideal * 0.7);
      // Largest hole: every unfilled point has a filled neighbour within ~2.5 ideal spacings.
      const grid = { xs, ys };
      let worst = 0;
      for (const p of r.points) {
        if (p.fillRank < k) continue;
        let best = Infinity;
        for (let i = 0; i < grid.xs.length; i++) best = Math.min(best, Math.hypot(grid.xs[i]! - p.dx, grid.ys[i]! - p.dy));
        worst = Math.max(worst, best);
      }
      expect(worst).toBeLessThan(ideal * 2.5);
    }
  });

  it('is a permutation', () => {
    const xs = Float64Array.from({ length: 500 }, (_, i) => i % 25);
    const ys = Float64Array.from({ length: 500 }, (_, i) => Math.floor(i / 25));
    const rank = progressiveFillOrder(xs, ys, 500, 1, 3);
    expect(new Set(rank).size).toBe(500);
  });
});

describe('upload wire format', () => {
  it('rounds and preserves checksum', () => {
    const r = generateFormation({ mask: renderBitmapText('2027', 8), anchor: ANCHOR, widthM: 120, targetCount: 700, seed: 4 });
    const rows = toPointRows(r.points);
    expect(rows[0]).toHaveLength(8);
    expect(pointsChecksum(rows.map((row) => ({ idx: row[0], label: row[7] })))).toBe(pointsChecksum(r.points));
  });
});
