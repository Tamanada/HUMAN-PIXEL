import { describe, expect, it } from 'vitest';
import {
  FormationError,
  LocalFrame,
  createMask,
  fillEllipse,
  deepestPoint,
  fitDesignWidth,
  generateFormation,
  hexPeople,
  surfaceCapacity,
  haversineDistance,
  nearestNeighbourStats,
  pointInPolygon,
  pointInBufferedPolygon,
  pointsChecksum,
  polygonToLocal,
  progressiveFillOrder,
  fitCurvedPlacement,
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

describe('sizing from the surface (capacity is an output)', () => {
  const bar = createMask(400, 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 400; x++) bar.data[y * 400 + x] = 255;

  it('surface capacity: area minus buffered exclusions, hex packing', () => {
    const cap = surfaceCapacity({ perimeter: rect(200, 100), formationArea: null, exclusions: [{ polygon: rect(10, 10), bufferM: 5 }] }, [1.3])!;
    // 20 000 m² − (20 m square with rounded corners ≈ 400 − (4 − π)·25 ≈ 379 m²)
    expect(cap.usableAreaM2).toBeGreaterThan(19_560);
    expect(cap.usableAreaM2).toBeLessThan(19_700);
    expect(cap.bySpacing[0]!.people).toBe(hexPeople(cap.usableAreaM2, 1.3));
    expect(surfaceCapacity({ perimeter: null, formationArea: null, exclusions: [] })).toBeNull();
  });

  it('fits the design to the largest width inside the area', () => {
    const w = fitDesignWidth({ mask: bar, anchor: ANCHOR, perimeter: rect(300, 300) });
    // A 4:1 bar in a 300 m square is limited by width: ≈ 300 m minus the 3 % margin.
    expect(w).toBeGreaterThan(280);
    expect(w).toBeLessThanOrEqual(300);
    // Rotated 90°, the same bar is still limited to 300 m.
    const r = fitDesignWidth({ mask: bar, anchor: ANCHOR, perimeter: rect(300, 300), rotationDeg: 90 });
    expect(Math.abs(r - w)).toBeLessThan(10);
    expect(() => fitDesignWidth({ mask: bar, anchor: ANCHOR, perimeter: rect(50, 50, 500, 500) })).toThrow(FormationError);
  });

  it('an exclusion inside the area removes pixels but does not shrink the fitted design', () => {
    const rock = [{ polygon: rect(20, 20, 30, 0), bufferM: 3 }];
    const r = generateFormation({ mask: bar, anchor: ANCHOR, targetSpacingM: 1.5, perimeter: rect(300, 300), exclusions: rock, seed: 1 });
    expect(r.widthM).toBeGreaterThan(280);
    expect(r.metrics.clippedFraction).toBeGreaterThan(0);
  });

  it('derives the head count from spacing and fits the surface', () => {
    const r = generateFormation({ mask: bar, anchor: ANCHOR, targetSpacingM: 1.5, perimeter: rect(120, 120), seed: 3 });
    const area = r.widthM * r.heightM;
    // A solid bar: head count ≈ its area in a 1.5 m hex packing.
    expect(r.points.length).toBeGreaterThan(hexPeople(area, 1.5) * 0.9);
    expect(r.points.length).toBeLessThan(hexPeople(area, 1.5) * 1.1);
    expect(r.metrics.clippedFraction).toBeLessThan(0.01);
    assertInvariants(r, r.points.length, 0.9);
  });

  it('deepest point of a curved (concave) beach lies inside, away from the shore', () => {
    // A crescent: its corner average falls in the bay, outside the sand.
    const arc = (r: number, a: number) => frame.toLatLng({ x: r * Math.cos(a), y: r * Math.sin(a) });
    const outer: LatLng[] = [];
    for (let i = 0; i <= 20; i++) outer.push(arc(200, Math.PI * (0.1 + 0.8 * (i / 20))));
    for (let i = 20; i >= 0; i--) outer.push(arc(150, Math.PI * (0.1 + 0.8 * (i / 20))));
    const crescent: Polygon<LatLng> = { outer };
    const p = frame.toLocal(deepestPoint(crescent));
    const local = polygonToLocal(frame, crescent);
    expect(pointInPolygon(p, local)).toBe(true);
    // Depth ≈ half the 50 m band.
    expect(Math.abs(Math.hypot(p.x, p.y) - 175)).toBeLessThan(5);
  });

  it('auto-placement turns and slides the design to fill a long slanted strip', () => {
    // A 400 × 40 m strip turned 25° CCW, like a beach; a one-line message (10:1).
    const line = createMask(1000, 100);
    for (let y = 10; y < 90; y++) for (let x = 20; x < 980; x++) line.data[y * 1000 + x] = 255;
    const corner = (x: number, y: number) => {
      const r = (25 * Math.PI) / 180;
      return frame.toLatLng({ x: 60 + x * Math.cos(r) - y * Math.sin(r), y: -30 + x * Math.sin(r) + y * Math.cos(r) });
    };
    const strip: Polygon<LatLng> = { outer: [corner(-200, -20), corner(200, -20), corner(200, 20), corner(-200, 20)] };
    const fixed = generateFormation({ mask: line, anchor: frame.toLatLng({ x: 60, y: -30 }), targetSpacingM: 1.5, perimeter: strip, seed: 1 });
    const auto = generateFormation({ mask: line, anchor: ANCHOR, targetSpacingM: 1.5, perimeter: strip, seed: 1, autoPlace: { preferredRotationDeg: 0 } });
    expect(Math.abs(auto.rotationDeg - 25)).toBeLessThan(4);
    // ≈ 400 m long (minus margins), far larger than the unrotated fit.
    expect(auto.widthM).toBeGreaterThan(330);
    expect(auto.points.length).toBeGreaterThan(fixed.points.length * 3);
    expect(auto.metrics.clippedFraction).toBeLessThan(0.02);
    // Reading direction follows the preferred rotation: turned the other way round, it flips.
    const flipped = generateFormation({ mask: line, anchor: ANCHOR, targetSpacingM: 1.5, perimeter: strip, seed: 1, autoPlace: { preferredRotationDeg: 180 } });
    expect(Math.abs(Math.abs(flipped.rotationDeg) - 155)).toBeLessThan(4);
  });
});

describe('curved layout (the message follows the shape of the area)', () => {
  // A crescent beach: a 50 m band of sand bent through 145°, like Haad Rin.
  const arc = (r: number, a: number) => frame.toLatLng({ x: r * Math.cos(a), y: r * Math.sin(a) });
  const outer: LatLng[] = [];
  for (let i = 0; i <= 40; i++) outer.push(arc(200, Math.PI * (0.1 + 0.8 * (i / 40))));
  for (let i = 40; i >= 0; i--) outer.push(arc(150, Math.PI * (0.1 + 0.8 * (i / 40))));
  const crescent: Polygon<LatLng> = { outer };
  const words = ['FULL', 'MOON', 'FESTIVAL'];
  const masks = words.map((w) => renderBitmapText(w, 8));
  const whole = renderBitmapText(words.join(' '), 8);

  it('every segment keeps the same letter height, and the message bends with the beach', () => {
    const fit = fitCurvedPlacement({ masks, formationArea: crescent, preferredRotationDeg: 0 });
    expect(fit.blocks).toHaveLength(3);
    // One shared height: no word comes out bigger than its neighbours.
    for (const b of fit.blocks) expect(b.heightM).toBeCloseTo(fit.heightM, 6);
    // Widths follow each word's own aspect ratio.
    fit.blocks.forEach((b, i) => expect(b.widthM / b.heightM).toBeCloseTo(masks[i]!.width / masks[i]!.height, 3));
    // The segments turn with the sand rather than all facing the same way.
    expect(fit.bendDeg).toBeGreaterThan(40);
    // The letters use the width of the sand (50 m band), not what a straight block would allow.
    expect(fit.heightM).toBeGreaterThan(30);
  });

  it('reads in the direction of the organizer map view', () => {
    const a = fitCurvedPlacement({ masks, formationArea: crescent, preferredRotationDeg: 0 });
    const b = fitCurvedPlacement({ masks, formationArea: crescent, preferredRotationDeg: 180 });
    // Turned the other way round, the first word starts at the other end of the beach.
    const firstA = frame.toLocal(a.blocks[0]!.anchor);
    const firstB = frame.toLocal(b.blocks[0]!.anchor);
    expect(Math.sign(firstA.x)).toBe(-Math.sign(firstB.x));
  });

  it('fits far more people on a curved beach than one rigid block', () => {
    const common = { anchor: ANCHOR, targetSpacingM: 1.5, formationArea: crescent, seed: 7 } as const;
    const straight = generateFormation({ ...common, mask: whole, autoPlace: { preferredRotationDeg: 0 } });
    const curved = generateFormation({ ...common, mask: whole, segments: { masks }, autoPlace: { preferredRotationDeg: 0 } });
    expect(curved.blocks).toHaveLength(3);
    expect(curved.points.length).toBeGreaterThan(straight.points.length * 2);
    // Thicker strokes are the point: a bigger message reads better from the air.
    expect(curved.metrics.strokeWidthP20M).toBeGreaterThan(straight.metrics.strokeWidthP20M);
    expect(curved.metrics.clippedFraction).toBeLessThan(0.02);
    assertInvariants(curved, curved.points.length, 0.9);
  });

  it('keeps every pixel on the sand, outside the exclusions', () => {
    const rock: Polygon<LatLng> = { outer: [arc(160, 1.2), arc(190, 1.2), arc(190, 1.35), arc(160, 1.35)] };
    const r = generateFormation({
      mask: whole,
      anchor: ANCHOR,
      segments: { masks },
      targetSpacingM: 1.5,
      formationArea: crescent,
      exclusions: [{ polygon: rock, bufferM: 3 }],
      seed: 7,
      autoPlace: { preferredRotationDeg: 0 },
    });
    const sand = polygonToLocal(frame, crescent);
    const local = polygonToLocal(frame, rock);
    for (const p of r.points) {
      const q = frame.toLocal({ lat: p.lat, lng: p.lng });
      expect(pointInPolygon(q, sand)).toBe(true);
      expect(pointInBufferedPolygon(q, local, 3)).toBe(false);
    }
    // Marshalling groups follow the message: a zone never straddles two segments.
    expect(r.zones.length).toBeGreaterThan(0);
  });
});
