import { describe, expect, it } from 'vitest';
import { LocalFrame, PositionTracker, evaluatePosition, formatDistance, gpsQuality, type GpsFix } from '../src';

const T = { lat: 9.7, lng: 100.0, radius: 3, requiredAccuracy: 10 };
const f = new LocalFrame(T);
const at = (x: number, y: number, accuracy: number, timestamp: number, speed = 0): GpsFix => ({ ...f.toLatLng({ x, y }), accuracy, timestamp, speed });

describe('evaluatePosition (tolerance)', () => {
  it('in position inside radius with good accuracy', () => {
    const e = evaluatePosition(at(2, 0, 4, 0), T);
    expect(e.status).toBe('IN_POSITION');
    expect(e.distance).toBeCloseTo(2, 1);
    expect(e.bearing).toBeCloseTo(270, 0); // target is to the west
  });
  it('move closer outside radius', () => {
    expect(evaluatePosition(at(37, 0, 4, 0), T).status).toBe('MOVE_CLOSER');
  });
  it('never claims in-position with poor accuracy', () => {
    const e = evaluatePosition(at(0.5, 0, 25, 0), T);
    expect(e.inside).toBe(false);
    expect(e.status).toBe('GPS_LOW');
  });
  it('respects configurable radii (2/3/5/10 m)', () => {
    for (const radius of [2, 3, 5, 10]) {
      expect(evaluatePosition(at(radius - 0.2, 0, 3, 0), { ...T, radius }).inside).toBe(true);
      expect(evaluatePosition(at(radius + 0.2, 0, 3, 0), { ...T, radius }).inside).toBe(false);
    }
  });
  it('no fix', () => expect(evaluatePosition(null, T).status).toBe('NO_FIX'));
  it('quality buckets', () => {
    expect(gpsQuality(3, 10)).toBe('good');
    expect(gpsQuality(8, 10)).toBe('fair');
    expect(gpsQuality(30, 10)).toBe('poor');
    expect(gpsQuality(null, 10)).toBe('none');
  });
  it('formats distances', () => {
    expect(formatDistance(84.4)).toBe('84 m');
    expect(formatDistance(4.83)).toBe('4.8 m');
    expect(formatDistance(1234)).toBe('1.2 km');
  });
});

describe('PositionTracker hysteresis', () => {
  it('requires dwell before entering and debounces exits', () => {
    const tr = new PositionTracker(T);
    let s = tr.update(at(1, 0, 4, 0));
    expect(s.inPosition).toBe(false); // not yet 3 s
    s = tr.update(at(1, 0, 4, 1500));
    s = tr.update(at(1, 0, 4, 3200));
    expect(s.inPosition).toBe(true);
    // One wild fix outside does not eject.
    s = tr.update(at(8, 0, 4, 4200));
    expect(s.inPosition).toBe(true);
    // Being clearly outside for more than 8 s does.
    for (let t = 5000; t <= 16000; t += 1000) s = tr.update(at(12, 0, 4, t, 1.5));
    expect(s.inPosition).toBe(false);
    expect(s.outside).toBe(true);
  });

  it('poor accuracy is never "outside"', () => {
    const tr = new PositionTracker(T);
    let s = tr.update(at(6, 0, 30, 0));
    for (let t = 1000; t <= 20000; t += 1000) s = tr.update(at(6, 0, 30, t));
    expect(s.outside).toBe(false);
  });

  it('marks arrival within 25 m and GPS loss after 15 s silence', () => {
    const tr = new PositionTracker(T);
    tr.update(at(20, 0, 5, 0, 1.4));
    expect(tr.snapshot(1000).arrived).toBe(true);
    expect(tr.snapshot(20_000).gpsLost).toBe(true);
  });
});
