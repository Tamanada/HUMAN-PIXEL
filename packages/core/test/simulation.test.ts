import { describe, expect, it } from 'vitest';
import { GPS_OPEN_SKY, generateFormation, makeSimParticipants, renderBitmapText, simulateCrowd } from '../src';

const ANCHOR = { lat: 9.6804, lng: 100.0663 };

/**
 * Crowd rehearsal: runs the real tracker + outbox for every simulated phone and measures
 * what actually reaches the backend.
 */
describe('crowd simulation (no phones required)', () => {
  const sizes = [1_000, 5_000, 12_000, 50_000];
  for (const n of sizes) {
    it(`${n.toLocaleString()} participants`, () => {
      const f = generateFormation({
        mask: renderBitmapText('LOVE\nPHANGAN', 10),
        anchor: ANCHOR,
        widthM: Math.sqrt(n) * 6,
        targetCount: n,
        seed: 21,
        lloydIterations: n > 20_000 ? 3 : 6,
      });
      // Big crowds are sampled: the per-phone logic is identical, traffic scales linearly.
      const sample = n > 12_000 ? f.points.filter((_, i) => i % 10 === 0) : f.points;
      const scale = f.points.length / sample.length;
      const participants = makeSimParticipants(sample, ANCHOR, { seed: n, noShowRate: 0.03, arrivalWindowS: 900 });
      const r = simulateCrowd({
        participants,
        anchor: ANCHOR,
        radius: 3,
        requiredAccuracy: 10,
        gps: GPS_OPEN_SKY,
        durationS: 2_300,
        startAtS: 1_800,
        seed: n + 1,
      });
      const shown = sample.length;
      // Network budget: a handful of transitions per participant, never per GPS fix.
      expect(r.reportsPerParticipant).toBeLessThan(10);
      // Nothing is sent during the quiet window around T-0.
      expect(r.reportsDuringQuietWindow).toBe(0);
      // Most present participants are in position at T-0; false positives are rare.
      const present = shown * 0.97;
      expect(r.inPositionAtStart / present).toBeGreaterThan(0.85);
      expect(r.falseInPosition / Math.max(1, r.inPositionAtStart)).toBeLessThan(0.05);
      const peak = r.peakReportsPerSecond * scale;
      // 12k: tens of writes per second at peak, far from any database limit.
      expect(peak).toBeLessThan(Math.max(20, n / 100));
      console.info(
        `[sim ${n}] reports/participant=${r.reportsPerParticipant.toFixed(2)} peak≈${Math.round(peak)}/s ` +
          `inPosition@T0=${((r.inPositionAtStart / present) * 100).toFixed(1)}% false=${r.falseInPosition} ` +
          `medianWalk=${r.medianTimeToPositionS}s`,
      );
    });
  }
});
